/**
 * `StackbaseClient` — the reactive client, now a **Gated Ledger** (verdict §(b)-(c)). It manages
 * query subscriptions (deduped by path+args), applies the version-bracketed sync protocol, and
 * layers optimistic updates over a serializable pending log:
 *
 *  - S1 `MutationLog` — one serializable entry per unconfirmed mutation (`./mutation-log`).
 *  - S2 `LayeredQueryStore` — per-subscription `serverValue` (server ingest) vs `composedValue`
 *    (server base + surviving optimistic layers replayed on top); what listeners see (`./layered-store`).
 *  - S3 `Reconciler` — the ONE chokepoint every state change routes through (`./reconcile`).
 *  - S4 `DeliveryPolicy` — close rules; NO layer crosses a session (`./delivery-policy`).
 *
 * Promise resolution is at `MutationResponse` (D3) — today's timing, an explicit divergence from
 * convex-js's gate-time resolution. A one-shot `query()` returns the **composed** view (D15).
 */
import {
  versionsEqual,
  INITIAL_VERSION,
  type ClientMessage,
  type ClientMutationRef,
  type ClientMutationVerdict,
  type ServerMessage,
  type StateVersion,
} from "@stackbase/sync";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import { getFunctionPath, type AnyFunctionRef, type FunctionReference } from "./api";
import type { AnyFunctionReference, FunctionArgs, FunctionReturnType } from "./function-types";
import type { ClientTransport } from "./transport";
import { LayeredQueryStore, queryHash, type Listener, type OptimisticUpdate, type QueryErrorListener, type QueryListener } from "./layered-store";
import { Reconciler } from "./reconcile";
import { MutationUndeliveredError } from "./delivery-policy";
import type { PendingMutation } from "./mutation-log";
import type { OptimisticLocalStore } from "./optimistic-store";
import {
  DEFAULT_OUTBOX_MAX_QUEUE_SIZE,
  OUTBOX_VERSION,
  OfflineClientResetError,
  OutboxOverflowError,
  defaultMintClientId,
  mintIdentity,
  type OutboxEntry,
  type OutboxStorage,
} from "./outbox-storage";
import { OutboxDrain, type DrainHost, type OutboxLockManager, type PoisonPolicy } from "./outbox-drain";
import type { MutationBatchEntry } from "@stackbase/sync";

export type { QueryListener, QueryErrorListener };

/** Passed to the `onClientReset` callback (verdict §(d) Retention) when the server disowns this
 *  client's mutation history on `ConnectAck{known: false}`. `unsentReEnqueued` counts the `unsent`
 *  entries carried forward under the fresh clientId + NEW seqs; `parkedRejected` counts the
 *  in-flight-at-disconnect entries rejected loudly with `OfflineClientResetError`. */
export interface ClientResetInfo {
  oldClientId: string | undefined;
  newClientId: string;
  unsentReEnqueued: number;
  parkedRejected: number;
}

let entropyCounter = 0;
function makeEntropy(): string {
  return `${Date.now().toString(36)}-${(entropyCounter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** SHA-256 hex digest of `input` — the durable outbox's `identityFingerprint` (verdict §(d) hazard
 *  9 / spec §(k)7). Async (`SubtleCrypto`), so `setAuth` computes-and-caches it; `mutation()` (which
 *  must stay synchronous) only ever reads the cache. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class StackbaseClient {
  private readonly transport: ClientTransport;
  private version: StateVersion = { ...INITIAL_VERSION };
  private resyncing = false;
  private closed = false;
  private readonly store = new LayeredQueryStore();
  private readonly reconciler: Reconciler;
  /** Mutation promise callbacks, keyed by requestId — resolved/rejected here; layers live in the log. */
  private readonly pendingMutations = new Map<string, { resolve: (v: Value) => void; reject: (e: Error) => void }>();
  private readonly pendingActions = new Map<string, { resolve: (v: Value) => void; reject: (e: Error) => void }>();
  private readonly broadcastListeners = new Set<(topic: string, event: Value) => void>();
  private readonly disposeTransport: () => void;
  private readonly disposeClose: () => void;
  private readonly disposeReopen?: () => void;
  private nextQueryId = 1;
  private nextRequestId = 1;
  /** The last token passed to `setAuth` (T6: replayed on reconnect). Unset until `setAuth` is
   *  first called — a transport that never had auth set never sends a spurious `SetAuth` on reopen. */
  private hasSetAuth = false;
  private lastAuthToken: string | null = null;
  /** Absent unless `opts.outbox` is configured — a client constructed without it behaves exactly
   *  as before this seam existed (`outbox-storage.ts`'s file doc: "never touches this file's
   *  runtime branches that matter"). */
  private readonly outbox?: OutboxStorage;
  /** Resolves once this tab-session's clientId is durably persisted (`mintIdentity`,
   *  `outbox-storage.ts`) — ALWAYS a fresh clientId, never one reused from a prior session. Public
   *  contract for tests/direct inspection; `mutation()` itself never awaits this (see
   *  `outboxClientId`/`outboxNextSeq` below — the synchronous counterparts it actually reads). */
  private readonly outboxIdentity?: Promise<{ clientId: string; nextSeq: number }>;
  /** This tab-session's clientId, minted SYNCHRONOUSLY at construction (Task 2) — `mutation()` must
   *  stay fully synchronous (T1's open concern), so it cannot await `outboxIdentity`'s async
   *  `getMeta`/`setMeta` round-trip. Fed into `mintIdentity` via `opts.mintClientId` below so the
   *  durable meta row names this SAME id. Set once, iff `opts.outbox` is configured; never reused
   *  across a reload (a fresh `StackbaseClient` always mints again). */
  private outboxClientId?: string;
  /** In-memory serial `seq` counter for `outboxClientId` (verdict §(d): "seqs minted serially
   *  in-memory per tab"). Starts at 0 synchronously; `outboxIdentity`'s resolution only ever
   *  reconciles it UPWARD (never re-hands-out a seq already allocated locally) for the
   *  astronomically-unlikely colliding-clientId case `mintIdentity` itself guards against. */
  private outboxNextSeq = 0;
  /** Monotonic per-tab counter for `OutboxEntry.order` — the drain's (T4) FIFO key across the
   *  WHOLE shared queue (every clientId/tab). Seeded from wall-clock time so multiple tabs sharing
   *  one outbox interleave in roughly chronological order; strictly increasing per call within
   *  this tab regardless of clock resolution. Cross-tab total ordering is a best-effort aid to the
   *  drain's efficiency, NOT a correctness requirement — "locks are efficiency; correctness is the
   *  records" (verdict §(d) "Drain"). */
  private outboxOrderCounter = 0;
  /** Cache of `identityFingerprint` (SHA-256 hex of the last `SetAuth` token, or `"anon"` for
   *  none/empty) — see `setAuth()` below and spec §(k)7. Stamped synchronously onto every entry;
   *  computed asynchronously (SubtleCrypto) whenever `setAuth` is called with a real token. */
  private outboxFingerprint = "anon";
  /** The S4 swap's capability flag (verdict §(d) "S4 swap, feature-detected") — flipped by
   *  `setOutboxArmed()`, which T3's Connect handshake calls once a `ConnectAck` proves server-side
   *  receipt dedup exists for this session. Defaults `false`: today's fail-fast, byte-for-byte,
   *  whether or not an outbox is configured. */
  private outboxArmed = false;
  private readonly outboxMaxQueueSize: number;
  /** The last `ConnectAck.deploymentId` seen — the same-timeline proof stamp (verdict §(g) hazard
   *  15's client half). Surfaced via `getOutboxDeploymentId()`; also written into the durable meta
   *  row so a future reload can compare timelines. Undefined until the first `ConnectAck`. */
  private outboxDeploymentId?: string;
  /** App callback fired once whenever a `ConnectAck{known: false}` resets this client's identity
   *  (verdict §(d) Retention). Optional constructor config. */
  private readonly onClientResetCallback?: (info: ClientResetInfo) => void;
  /** True while the Connect handshake is waiting for the first post-`Connect` baseline Transition
   *  to be ADOPTED through S3 (verdict §(d) / spec decision 5 — "a NEW await"). While true, the
   *  drop rule for `applied` cross-session entries is DEFERRED (queued in `outboxPendingDrops`) and
   *  `whenBaselineAdopted()` (T4's drain gate) stays pending. */
  private outboxAwaitingBaseline = false;
  /** requestIds whose `applied`-verdict layer drop is deferred until the baseline is adopted (so the
   *  drop is flicker-free — the baseline already renders the effect). Drained by `markBaselineAdopted`. */
  private outboxPendingDrops: string[] = [];
  /** Resolvers for in-flight `whenBaselineAdopted()` promises — settled together when the baseline
   *  Transition adopts (or immediately, when a reopen had no live subscriptions to re-baseline). */
  private outboxBaselineResolvers: Array<() => void> = [];
  /** Whether a `Connect` handshake has already gone out on the CURRENT connection (reset at close).
   *  Guards against a double-handshake when both the reopen path and the drain's first-connect path
   *  could fire — the drain's `ensureInitialHandshake()` is a no-op once a reopen already sent one. */
  private outboxConnectSent = false;
  /** The drain (Task 4) — the Web Locks leader that turns the durable queue into exactly-once server
   *  effects. Present iff `opts.outbox` is configured; started at construction. */
  private readonly outboxDrain?: OutboxDrain;

  constructor(
    transport: ClientTransport,
    opts: {
      gateTimeoutMs?: number;
      outbox?: OutboxStorage;
      outboxMaxQueueSize?: number;
      onClientReset?: (info: ClientResetInfo) => void;
      /** How a coded (terminal, server-recorded) mutation failure is handled during the drain
       *  (verdict §(c) R5) — `"skip"` (default: skip-and-record + continue) or `"pause"` (halt). */
      poisonPolicy?: PoisonPolicy;
      /** The Web Locks manager for the drain leader — `undefined` probes `navigator.locks`, `null`
       *  forces single-tab, an object is used directly (tests inject a fake). */
      outboxLocks?: OutboxLockManager | null;
      /** Distinguishes the drain's lock name per deployment (`stackbase:outbox:<origin>:<deployment>`);
       *  defaults to `"default"`. */
      outboxDeployment?: string;
      /** The drain's interval-nudge period (verdict §(d): never `navigator.onLine`). */
      outboxDrainIntervalMs?: number;
      /** The drain's `MutationBatch` chunk size (default 50). */
      outboxChunkSize?: number;
      /** Injectable backoff for the drain's codeless-retry path (tests drive it deterministically). */
      outboxBackoffMs?: (attempts: number) => number;
      /** Fired once when `poisonPolicy: "pause"` halts the drain (surfacing). */
      onOutboxPause?: (info: { requestId: string; udfPath: string; code: string }) => void;
    } = {},
  ) {
    this.transport = transport;
    this.reconciler = new Reconciler(this.store, { gateTimeoutMs: opts.gateTimeoutMs });
    this.outbox = opts.outbox;
    this.onClientResetCallback = opts.onClientReset;
    this.outboxMaxQueueSize = opts.outboxMaxQueueSize ?? DEFAULT_OUTBOX_MAX_QUEUE_SIZE;
    if (opts.outbox) {
      this.outboxClientId = defaultMintClientId();
      this.outboxIdentity = mintIdentity(opts.outbox, { mintClientId: () => this.outboxClientId! }).then((id) => {
        this.outboxNextSeq = Math.max(this.outboxNextSeq, id.nextSeq);
        return id;
      });
      this.outboxDrain = new OutboxDrain(this.makeDrainHost(), {
        lockName: `stackbase:outbox:${this.originTag()}:${opts.outboxDeployment ?? "default"}`,
        locks: opts.outboxLocks,
        poisonPolicy: opts.poisonPolicy,
        chunkSize: opts.outboxChunkSize,
        intervalMs: opts.outboxDrainIntervalMs,
        backoffMs: opts.outboxBackoffMs,
        onPause: opts.onOutboxPause,
      });
    }
    this.disposeTransport = transport.onMessage((msg) => this.onServerMessage(msg));
    this.disposeClose = transport.onClose(() => this.onTransportClosed());
    this.disposeReopen = transport.onReopen?.(() => this.onTransportReopened());
    // Start the drain AFTER the message/close hooks are wired (it may hydrate + handshake at once).
    this.outboxDrain?.start();
  }

  /** The origin component of the drain's Web Locks name — `location.origin` in a browser, a stable
   *  fallback elsewhere (Node/SSR share one origin; correctness is the records, not the lock). */
  private originTag(): string {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    return loc?.origin ?? "app";
  }

  /** @internal This tab-session's durable outbox identity, or `undefined` when no `outbox` was
   *  configured. Exposed for direct testing of the identity-mint behavior; `mutation()` itself
   *  reads the synchronous `outboxClientId`/`outboxNextSeq` counterparts, never this promise
   *  (see the field doc above `outboxClientId`). */
  getOutboxIdentity(): Promise<{ clientId: string; nextSeq: number }> | undefined {
    return this.outboxIdentity;
  }

  /** @internal T3's Connect handshake calls this once a `ConnectAck` proves server-side receipt
   *  dedup exists for this session — see verdict §(d) "S4 swap, feature-detected". Before that (no
   *  outbox configured, a fresh/pre-handshake session, or an old server that never sends
   *  `ConnectAck`), `close()` behaves exactly as it always has: today's fail-fast, byte-for-byte. */
  setOutboxArmed(armed: boolean): void {
    this.outboxArmed = armed;
  }

  /**
   * Subscribe to a reactive query. `onUpdate` fires with the latest **composed** value (immediately
   * if cached). `onError` (optional) fires if the query's handler throws server-side — otherwise a
   * failing query is logged and leaves the last known value in place.
   *
   * Two overloads bridge T3/T5's type reconciliation (`api.ts`'s `AnyFunctionRef` doc): a
   * codegen-generated ref types `args`/`onUpdate`'s value from its declared `__args`/`__returns`;
   * this package's own untyped `{ __path }` ref or a raw string path fall back to the pre-existing
   * `Record<string, Value>`/`Value` shape (an explicit `T` still overrides, as before).
   */
  subscribe<Q extends AnyFunctionReference<any, any>>(
    ref: Q,
    args: FunctionArgs<Q>,
    onUpdate: (value: FunctionReturnType<Q>) => void,
    onError?: QueryErrorListener,
  ): () => void;
  subscribe(
    ref: FunctionReference | string,
    args: Record<string, Value> | undefined,
    onUpdate: QueryListener,
    onError?: QueryErrorListener,
  ): () => void;
  subscribe(
    ref: AnyFunctionRef,
    args: Record<string, Value> = {},
    onUpdate: QueryListener,
    onError?: QueryErrorListener,
  ): () => void {
    const path = getFunctionPath(ref);
    const argsJson = convexToJson(args as Value);
    const hash = queryHash(path, argsJson);

    let sub = this.store.byHash.get(hash);
    if (!sub) {
      const queryId = this.nextQueryId++;
      sub = this.store.create(queryId, path, argsJson, hash);
      this.transport.send({ type: "ModifyQuerySet", add: [{ queryId, udfPath: path, args: argsJson }], remove: [] });
    }
    const listener: Listener = { onUpdate, onError };
    sub.listeners.add(listener);
    // Cached first delivery serves the COMPOSED view (server base + any optimistic layer).
    if (sub.composedValue !== undefined) onUpdate(sub.composedValue);

    return () => {
      const s = this.store.byHash.get(hash);
      if (!s) return;
      s.listeners.delete(listener);
      if (s.listeners.size === 0) {
        this.transport.send({ type: "ModifyQuerySet", add: [], remove: [s.queryId] });
        this.store.remove(hash);
      }
    };
  }

  /** One-shot read: resolves with the first **composed** value (D15) — a one-shot read can return
   *  speculative data — or rejects if the query throws; then unsubscribes. */
  query<Q extends AnyFunctionReference<any, any>>(ref: Q, args?: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  query(ref: FunctionReference | string, args?: Record<string, Value>): Promise<Value>;
  query(ref: AnyFunctionRef, args: Record<string, Value> = {}): Promise<Value> {
    return new Promise((resolve, reject) => {
      // Overload dispatch needs a concrete match; `ref`/`args` are already the resolved runtime
      // shape here (the outer overloads did the caller-facing type-checking).
      const unsubscribe = this.subscribe(
        ref as FunctionReference | string,
        args,
        (value) => {
          resolve(value);
          // Defer the reference: a cached first delivery fires this synchronously inside
          // `subscribe()`, before `unsubscribe` is assigned (TDZ) — an arrow reads it later.
          queueMicrotask(() => unsubscribe());
        },
        (error) => {
          reject(new Error(error));
          queueMicrotask(() => unsubscribe());
        },
      );
    });
  }

  /**
   * Run a mutation; resolves with its return value at `MutationResponse` (D3), or rejects with its
   * error. With `{ optimisticUpdate }`, the closure runs synchronously against a writeable composed
   * view before the mutation is sent (instant UI); if it throws, `mutation` throws **synchronously**
   * and nothing is sent. The optimistic layer is dropped on observed inclusion, never on the ack.
   *
   * The typed overload's `optimisticUpdate` is typed against the public `OptimisticLocalStore`
   * (`Q`'s declared `__args`) — sound because `Reconciler.invokeUpdate` (`reconcile.ts`) ALWAYS
   * enriches the raw internal view into an `OptimisticLocalStore` before calling `entry.update`,
   * regardless of entry point; the cast to the internal `OptimisticUpdate` shape below is safe for
   * exactly that reason.
   */
  mutation<Q extends AnyFunctionReference<any, any>>(
    ref: Q,
    args?: FunctionArgs<Q>,
    opts?: { optimisticUpdate?: (store: OptimisticLocalStore, args: FunctionArgs<Q>) => void },
  ): Promise<FunctionReturnType<Q>>;
  mutation(
    ref: FunctionReference | string,
    args?: Record<string, Value>,
    opts?: { optimisticUpdate?: OptimisticUpdate },
  ): Promise<Value>;
  mutation(
    ref: AnyFunctionRef,
    args: Record<string, Value> = {},
    opts: { optimisticUpdate?: OptimisticUpdate } = {},
  ): Promise<Value> {
    const path = getFunctionPath(ref);
    // Encodability triage (verdict §(d) "Drain", applied at enqueue time too): an unencodable
    // `args` throws HERE, synchronously — before any requestId/seq/entry exists — so a bad call
    // never occupies a durable outbox slot (a seq, once minted, is never reused).
    const argsJson = convexToJson(args as Value);

    if (this.outbox && this.outboxQueueDepth() >= this.outboxMaxQueueSize) {
      // Overflow: reject the NEW enqueue, coded (verdict §(d) "Enqueue") — nothing was created,
      // no seq was consumed, no optimistic layer was touched.
      return Promise.reject(new OutboxOverflowError());
    }

    const requestId = String(this.nextRequestId++);
    const entry: PendingMutation = {
      requestId,
      udfPath: path,
      args: argsJson,
      update: opts.optimisticUpdate,
      seed: { entropy: makeEntropy(), now: Date.now() },
      touched: new Set(),
      status: { type: "unsent" },
    };
    if (this.outbox) {
      // Stamped synchronously — the durable-outbox identity (verdict §(d) "Identity"/"Enqueue").
      // Carried on the wire whenever an outbox is configured, not only once the S4 swap is armed
      // (see `mutationMessage` below) — "for park-safety... exactly as today otherwise".
      entry.clientId = this.outboxClientId;
      entry.seq = this.outboxNextSeq++;
      entry.order = this.nextOutboxOrder();
      entry.identityFingerprint = this.outboxFingerprint;
      entry.enqueuedAt = Date.now();
    }
    // "While the queue is non-empty, new mutations enqueue behind it; when empty, live sends go
    // direct" (verdict §(d) "Enqueue") — computed BEFORE `initiate()` adds this entry to the log,
    // so it only ever sees OTHER entries' backlog.
    const queueBusy = this.outbox !== undefined && this.hasOutboxBacklog();

    // Event 1 — apply at initiation. A throwing updater rethrows here, synchronously, before any
    // promise is created or anything is sent.
    this.reconciler.initiate(entry);

    return new Promise<Value>((resolve, reject) => {
      this.pendingMutations.set(requestId, { resolve, reject });
      if (this.closed || queueBusy) {
        // Offline, or FIFO behind an already-queued backlog: retain as `unsent` for a flush. The
        // promise stays pending.
        entry.status = { type: "unsent" };
      } else {
        entry.status = { type: "inflight" };
        this.transport.send(this.mutationMessage(entry));
      }
      if (this.outbox) {
        // Write-behind: durably append WITHOUT awaiting — "the send never waits for it" (verdict
        // §(d) "Enqueue"). `entry.durable` flips once this resolves; `delivery-policy.ts`'s
        // `closeDisposition` reads it at close ("park eligibility requires durability").
        void this.outbox.append(this.toOutboxEntry(entry)).then(() => {
          entry.durable = true;
          // Now durable → drain-eligible: wake the drain (wake on enqueue, verdict §(d)).
          this.outboxDrain?.nudge();
        });
      }
    });
  }

  /** The wire `Mutation` message for `entry` — carries `(clientId, seq)` whenever an outbox is
   *  configured (park-safety, verdict §(d)), and OMITS the fields entirely (not merely `undefined`)
   *  when it isn't, so a client with no `outbox` sends exactly today's shape, byte-for-byte. */
  private mutationMessage(entry: PendingMutation): ClientMessage {
    return {
      type: "Mutation",
      requestId: entry.requestId,
      udfPath: entry.udfPath,
      args: entry.args,
      ...(entry.clientId !== undefined ? { clientId: entry.clientId, seq: entry.seq! } : {}),
    };
  }

  /** The persisted `OutboxStorage` twin of `entry` — only ever called when `this.outbox` (and thus
   *  `entry.clientId`/`seq`/`order`/`enqueuedAt`) is set. */
  private toOutboxEntry(entry: PendingMutation): OutboxEntry {
    return {
      clientId: entry.clientId!,
      seq: entry.seq!,
      requestId: entry.requestId,
      udfPath: entry.udfPath,
      args: entry.args,
      seed: entry.seed,
      order: entry.order!,
      status: entry.status.type === "unsent" ? "unsent" : "inflight",
      identityFingerprint: entry.identityFingerprint,
      outboxVersion: OUTBOX_VERSION,
      enqueuedAt: entry.enqueuedAt!,
    };
  }

  /** True while any OTHER entry is `unsent` (queued for a flush) or `parked` (queued for a future
   *  drain) — the FIFO-preserving gate a new mutation enqueues behind (verdict §(d) "Enqueue"). */
  private hasOutboxBacklog(): boolean {
    for (const e of this.reconciler.entries()) {
      if (e.status.type === "unsent" || e.status.type === "parked") return true;
    }
    return false;
  }

  /** Count of outbox-tracked entries not yet fully settled (excludes `completed` — already acked,
   *  held only for the ts-gate) — the overflow cap's occupancy (verdict §(d) "Enqueue": "bounded,
   *  default 1000"). */
  private outboxQueueDepth(): number {
    let n = 0;
    for (const e of this.reconciler.entries()) {
      if (e.clientId !== undefined && e.status.type !== "completed") n++;
    }
    return n;
  }

  /** Monotonic `OutboxEntry.order` allocator — see the `outboxOrderCounter` field doc. */
  private nextOutboxOrder(): number {
    const now = Date.now();
    this.outboxOrderCounter = this.outboxOrderCounter >= now ? this.outboxOrderCounter + 1 : now;
    return this.outboxOrderCounter;
  }

  /** Run an action; resolves with its return value (or rejects with its error). Not reactive — an action has no subscription. */
  action<Q extends AnyFunctionReference<any, any>>(ref: Q, args?: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  action(ref: FunctionReference | string, args?: Record<string, Value>): Promise<Value>;
  action(ref: AnyFunctionRef, args: Record<string, Value> = {}): Promise<Value> {
    const requestId = String(this.nextRequestId++);
    return new Promise<Value>((resolve, reject) => {
      this.pendingActions.set(requestId, { resolve, reject });
      this.transport.send({ type: "Action", requestId, udfPath: getFunctionPath(ref), args: convexToJson(args as Value) });
    });
  }

  /** Set (or clear) the session identity for this connection; the server re-runs subscriptions under it. */
  setAuth(token: string | null): void {
    this.hasSetAuth = true;
    this.lastAuthToken = token;
    this.transport.send({ type: "SetAuth", token });
    if (this.outbox) {
      // `identityFingerprint` cache (verdict §(d) hazard 9 / spec §(k)7): SHA-256 of the token, or
      // "anon" for none/empty — computed here (async, SubtleCrypto) so `mutation()` can stamp the
      // cached value synchronously. Guarded against a stale resolution racing a LATER setAuth call.
      if (!token) {
        this.outboxFingerprint = "anon";
      } else {
        const forToken = token;
        void sha256Hex(forToken).then((hex) => {
          if (this.lastAuthToken === forToken) this.outboxFingerprint = hex;
        });
      }
    }
  }

  /** Publish an ephemeral event (presence/typing) — bypasses the engine. */
  publishEphemeral(topic: string, event: Value): void {
    this.transport.send({ type: "EphemeralPublish", topic, event: convexToJson(event) });
  }

  /** Listen for ephemeral broadcasts (presence/typing) from other clients. */
  onBroadcast(listener: (topic: string, event: Value) => void): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  close(): void {
    this.outboxDrain?.stop();
    this.disposeTransport();
    this.disposeClose();
    this.disposeReopen?.();
    this.transport.close();
    this.onTransportClosed();
  }

  /** @internal test/debug only — the observed-inclusion frontier (resets to 0 at close). */
  get __maxObservedTs(): number {
    return this.reconciler.maxObservedTs;
  }

  /** @internal test/debug only — the live pending-mutation log, in requestId order. */
  get __pending(): readonly PendingMutation[] {
    return this.reconciler.entries();
  }

  /** @internal test/debug only — the current `identityFingerprint` cache (see `setAuth`); polling
   *  this (rather than calling `mutation()` repeatedly, which consumes seqs) is how a test waits
   *  out the async SHA-256 digest without depending on a fixed tick count. */
  get __outboxFingerprint(): string {
    return this.outboxFingerprint;
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "Transition": {
        // While resyncing, adopt the next transition as the new baseline (its modifications are the
        // full re-subscribed results) regardless of its start version. Layers are NOT blanket-dropped
        // (same session, ts still monotone) — the gate still drops any covered `completed` layer.
        if (this.resyncing) {
          this.reconciler.ingestTransition(msg.modifications, msg.endVersion.ts);
          this.version = msg.endVersion;
          this.resyncing = false;
          // T3: this adopted Transition IS the post-Connect baseline the drop rule + T4's drain
          // await — fire the deferred drops and release `whenBaselineAdopted()` waiters.
          if (this.outboxAwaitingBaseline) this.markBaselineAdopted();
          return;
        }
        // Version-bracket guard: a non-contiguous start means a frame was dropped. Do NOT deliver the
        // (post-gap) values — resync from scratch instead, preserving correctness.
        if (!versionsEqual(msg.startVersion, this.version)) {
          this.resync();
          return;
        }
        this.reconciler.ingestTransition(msg.modifications, msg.endVersion.ts);
        this.version = msg.endVersion;
        // First-connect baseline adoption (Task 4): unlike a reopen (whose baseline adopts in the
        // `resyncing` branch above), a fresh first connect's baseline is just its first contiguous
        // Transition — so release the drain's `whenBaselineAdopted()` gate + fire deferred drops
        // here. Only ever true while a first-connect handshake is in flight; a no-op otherwise.
        if (this.outboxAwaitingBaseline) this.markBaselineAdopted();
        return;
      }
      case "MutationResponse": {
        // A response for a unit the drain (Task 4) is awaiting routes to the drain's state machine
        // (per-unit resolution, transient-stop, backoff) — NOT the direct-send path below.
        if (this.outboxDrain?.handles(msg.requestId)) {
          this.outboxDrain.onResponse(msg);
          return;
        }
        // Capture the outbox identity BEFORE the settling event removes the entry from the log —
        // dequeue-on-success/settle needs its recorded `(clientId, seq)` (T3, verdict §(f) AC1.2).
        const entry = this.reconciler.getEntry(msg.requestId);
        const pending = this.pendingMutations.get(msg.requestId);
        this.pendingMutations.delete(msg.requestId);
        if (msg.success) {
          // `value` is optional on the wire (a Receipted Outbox replay-ack with `valueMissing`
          // omits it); coalesce to null. Full replay handling is Plan B — this keeps today's shape.
          pending?.resolve(jsonToConvex(msg.value ?? null)); // D3: resolve now
          this.reconciler.onMutationSuccess(msg.requestId, msg.ts);
        } else {
          pending?.reject(this.mutationError(msg.error, msg.code));
          this.reconciler.onMutationFailure(msg.requestId);
        }
        // A settled response (either outcome) means this durable entry's fate is known — dequeue it
        // so it never resends. A retryable follow-up is a FRESH seq (verdict §(d) retry()), never a
        // resurrection of this record. (No-op when no outbox is configured.)
        this.dequeueOutboxEntry(entry);
        return;
      }
      case "ConnectAck":
        this.handleConnectAck(msg);
        return;
      case "ActionResponse": {
        const pending = this.pendingActions.get(msg.requestId);
        if (pending) {
          this.pendingActions.delete(msg.requestId);
          if (msg.success) pending.resolve(jsonToConvex(msg.value));
          else pending.reject(new Error(msg.error));
        }
        return;
      }
      case "Broadcast": {
        const event = jsonToConvex(msg.event);
        for (const listener of this.broadcastListeners) listener(msg.topic, event);
        return;
      }
      default:
        return;
    }
  }

  /** A frame was missed: reset and re-subscribe all live queries; adopt the server's next state. */
  private resync(): void {
    this.resyncing = true;
    this.version = { ...INITIAL_VERSION };
    const subs = [...this.store.byId.values()];
    if (subs.length === 0) {
      this.resyncing = false;
      return;
    }
    this.transport.send({
      type: "ModifyQuerySet",
      add: subs.map((s) => ({ queryId: s.queryId, udfPath: s.path, args: s.args })),
      remove: [],
    });
  }

  private onTransportClosed(): void {
    this.closed = true;
    this.outboxConnectSent = false; // a fresh connection needs a fresh Connect handshake.
    // S4 close rules: unsent retained; inflight/completed layers drop; frontier resets. Task 2's
    // park swap (armed + durable) is folded in here via `this.outboxArmed` — `rejectedInflight`
    // already excludes anything that parked instead; a parked entry's promise stays pending in
    // `pendingMutations`, untouched, ready for a future drain (T4) to settle.
    const { rejectedInflight } = this.reconciler.closeSession(this.outboxArmed);
    for (const rid of rejectedInflight) {
      const pending = this.pendingMutations.get(rid);
      this.pendingMutations.delete(rid);
      pending?.reject(new MutationUndeliveredError());
    }
    // Actions have no layer — their outcome is simply unknown on a dropped socket.
    for (const [, pending] of this.pendingActions) pending.reject(new Error("connection closed"));
    this.pendingActions.clear();
  }

  /**
   * T6: the transport reconnected (a fresh session — the server has no state for it). Order is
   * load-bearing (verdict §(c) event 6): `SetAuth` replay first (the server re-runs subscriptions
   * under the right identity), THEN resubscribe every live query (the existing resync path — it
   * adopts the reply as a fresh baseline regardless of its start version), THEN flush every
   * `unsent` mutation FIFO — each transitions `unsent` -> `inflight` reusing its ORIGINAL
   * `requestId` (never re-minted), so the promise created at `mutation()` call time stays the one
   * that resolves when the new session's `MutationResponse` arrives.
   */
  private onTransportReopened(): void {
    this.closed = false;
    if (this.hasSetAuth) this.transport.send({ type: "SetAuth", token: this.lastAuthToken });
    this.resync();
    if (this.outbox) {
      // T3: for a durable-outbox client the naive unsent flush is REPLACED by the `Connect` resume
      // handshake. `Connect` re-proves capability (its `ConnectAck` arms the S4 park swap) and lets
      // the server classify every held `(clientId, seq)`; the actual FIFO resend of `unknown`/parked
      // entries is T4's drain, which awaits `whenBaselineAdopted()` before sending. Held entries are
      // NOT flushed directly here — that would bypass the dedup handshake and re-order the FIFO.
      this.initiateHandshake(this.resyncing);
      this.outboxDrain?.nudge(); // wake on reconnect-after-baseline.
      return;
    }
    for (const entry of this.reconciler.unsentInOrder()) {
      entry.status = { type: "inflight" };
      this.transport.send(this.mutationMessage(entry));
    }
  }

  /** Send the `Connect` resume handshake once per connection (idempotent via `outboxConnectSent`),
   *  arming the baseline await. Shared by the reopen path and the drain's first-connect path (Task 4
   *  / T3 handoff #1: a fresh-client-first-connect after reload has no reopen event, so the drain
   *  triggers the same handshake on becoming leader with a durable backlog). */
  private initiateHandshake(expectTransition: boolean): void {
    if (this.outboxConnectSent || this.closed || !this.outbox) return;
    this.outboxConnectSent = true;
    this.beginBaselineAwait(expectTransition);
    this.sendConnect();
  }

  /* ---------------------------------------------------------------------------------------------
   * T3 — the Connect resume handshake, verdict settlement, the baseline-gated drop rule, and reset.
   * ------------------------------------------------------------------------------------------- */

  /** @internal T4's drain gate. Resolves once the first post-`Connect` baseline Transition has been
   *  adopted through S3 (verdict §(d) / spec decision 5). Resolves immediately when no handshake is
   *  in flight (nothing to await) or when a reopen had no live subscriptions to re-baseline. */
  whenBaselineAdopted(): Promise<void> {
    if (!this.outboxAwaitingBaseline) return Promise.resolve();
    return new Promise<void>((resolve) => this.outboxBaselineResolvers.push(resolve));
  }

  /** @internal test/debug — the last `ConnectAck.deploymentId` (the same-timeline proof stamp), or
   *  `undefined` before any handshake completed. */
  getOutboxDeploymentId(): string | undefined {
    return this.outboxDeploymentId;
  }

  /** @internal test/debug — whether the S4 park swap is armed (a `ConnectAck` has proven dedup). */
  get __outboxArmed(): boolean {
    return this.outboxArmed;
  }

  /** Begin awaiting the post-`Connect` baseline. `expectTransition` is true iff a baseline Transition
   *  is actually coming — for a reopen, `this.resyncing` (set iff `resync()` re-subscribed live
   *  queries); for a first connect, whether any live subscription exists. With none, there is no
   *  baseline frame and adoption is immediate. */
  private beginBaselineAwait(expectTransition: boolean): void {
    this.outboxAwaitingBaseline = expectTransition;
    if (!expectTransition) this.markBaselineAdopted();
  }

  /** The baseline Transition adopted (or there was none to await): fire every deferred `applied`
   *  layer drop (each flicker-free now — the baseline renders the effect), release the drain gate,
   *  and wake the drain (reconnect-after-baseline). */
  private markBaselineAdopted(): void {
    this.outboxAwaitingBaseline = false;
    for (const rid of this.outboxPendingDrops.splice(0)) this.reconciler.onVerdictAfterBaseline(rid);
    const resolvers = this.outboxBaselineResolvers.splice(0);
    for (const resolve of resolvers) resolve();
    this.outboxDrain?.nudge();
  }

  /** Send the `Connect` resume handshake: this tab-session's clientId, the `held` durable entries
   *  (every not-yet-settled `(clientId, seq)` in the log — the server classifies each into
   *  `ConnectAck.results`), and `ackedThrough` (the contiguous settled-prefix per clientId, for
   *  server-side retention pruning). `sessionId` is a fresh per-connect id; the server routes the
   *  handshake by the transport-level session, so this field is only informational. */
  private sendConnect(): void {
    const held = this.outboxHeld();
    this.transport.send({
      type: "Connect",
      sessionId: makeEntropy(),
      clientId: this.outboxClientId!,
      held,
      ackedThrough: this.outboxAckedThrough(held),
    });
  }

  /** Every durable entry still awaiting a verdict — `unsent`/`inflight`/`parked` with a recorded
   *  `(clientId, seq)`. A parked entry's fate is the genuinely-unknown one the handshake resolves;
   *  presenting `unsent`/`inflight` too is harmless (they classify `unknown` and re-drain). */
  private outboxHeld(): ClientMutationRef[] {
    const refs: ClientMutationRef[] = [];
    for (const e of this.reconciler.entries()) {
      const st = e.status.type;
      if (e.clientId !== undefined && e.seq !== undefined && (st === "unsent" || st === "inflight" || st === "parked")) {
        refs.push({ clientId: e.clientId, seq: e.seq });
      }
    }
    return refs;
  }

  /** The highest CONTIGUOUS settled-prefix seq per clientId (verdict §(c) Retention / spec
   *  decision 3). Under the FIFO one-unacked-chunk drain a seq can never settle past an unsettled
   *  earlier one, so for each clientId the settled prefix is exactly `(lowest still-held seq) - 1`;
   *  a clientId whose lowest held seq is 0 has acked nothing and is omitted. */
  private outboxAckedThrough(held: ClientMutationRef[]): ClientMutationRef[] {
    const lowestHeld = new Map<string, number>();
    for (const ref of held) {
      const cur = lowestHeld.get(ref.clientId);
      if (cur === undefined || ref.seq < cur) lowestHeld.set(ref.clientId, ref.seq);
    }
    const acked: ClientMutationRef[] = [];
    for (const [clientId, minSeq] of lowestHeld) {
      if (minSeq > 0) acked.push({ clientId, seq: minSeq - 1 });
    }
    return acked;
  }

  /** Process a `ConnectAck` (verdict §(e)): the capability proof arms the S4 park swap; the
   *  deploymentId is surfaced + persisted; `known: false` triggers `onClientReset`; otherwise each
   *  classified `held` seq is settled (`applied`/`failed`/`stale` terminal; `unknown` left for the
   *  drain). */
  private handleConnectAck(msg: Extract<ServerMessage, { type: "ConnectAck" }>): void {
    // The ConnectAck itself is the capability proof — arm regardless of `known` (the server speaks
    // the dedup protocol either way; a reset still wants future closes to park under the fresh id).
    this.outboxArmed = true;
    this.outboxDeploymentId = msg.deploymentId;
    if (this.outbox && this.outboxClientId !== undefined) {
      // Stamp the timeline onto the current clientId's meta row (best-effort, fire-and-forget).
      void this.outbox.setMeta(this.outboxClientId, { nextSeq: this.outboxNextSeq, deployment: msg.deploymentId });
    }
    if (!msg.known) {
      void this.onClientReset().then(() => this.outboxDrain?.nudge());
      return;
    }
    for (const v of msg.results) this.settleVerdict(v);
    // The handshake proved dedup + classified `held`; wake the drain to (re)send any `unknown` seqs.
    this.outboxDrain?.nudge();
  }

  /** Settle one classified `held` seq from a `ConnectAck` (or, later, a drain replay-ack). */
  private settleVerdict(v: ClientMutationVerdict): void {
    const entry = this.findOutboxEntry(v.clientId, v.seq);
    switch (v.verdict) {
      case "applied": {
        // Resolve the awaiting promise (a parked entry from THIS session still has one; a hydrated
        // cross-reload entry has none — `valueMissing` is tolerated everywhere) with the recorded
        // value, dequeue the durable record, and drop its layer once the baseline is adopted.
        const value = v.valueMissing ? null : jsonToConvex(v.value ?? null);
        if (entry) this.resolvePending(entry.requestId, value);
        void this.outbox?.dequeue(v.clientId, v.seq);
        if (entry) this.dropAfterBaseline(entry.requestId);
        break;
      }
      case "failed": {
        if (entry) this.rejectPending(entry.requestId, this.mutationError(`mutation "${entry.udfPath}" failed`, v.code));
        void this.outbox?.dequeue(v.clientId, v.seq);
        if (entry) this.reconciler.onMutationFailure(entry.requestId);
        break;
      }
      case "stale": {
        if (entry) this.rejectPending(entry.requestId, this.mutationError("mutation disowned (STALE_CLIENT)", v.code ?? "STALE_CLIENT"));
        void this.outbox?.dequeue(v.clientId, v.seq);
        if (entry) this.reconciler.onMutationFailure(entry.requestId);
        break;
      }
      case "unknown":
        // Never seen by the server — remains in the log for T4's drain to (re)send under its seq.
        break;
    }
  }

  /** `known: false` — the server disowned this client's history (verdict §(d) Retention). Re-mint a
   *  fresh clientId + meta; re-enqueue every `unsent` entry under the new clientId + NEW seqs (never
   *  applied, so safe); reject every `parked` entry LOUDLY (in-flight-at-disconnect, no server dedup
   *  → a blind resend could double-apply); fire the `onClientReset` callback. */
  private async onClientReset(): Promise<void> {
    const oldClientId = this.outboxClientId;
    const fresh = defaultMintClientId();
    this.outboxClientId = fresh;
    this.outboxNextSeq = 0;

    let parkedRejected = 0;
    let unsentReEnqueued = 0;
    // Snapshot first — the loop rejects (mutates promise maps) and re-stamps entries.
    for (const entry of [...this.reconciler.entries()]) {
      if (entry.status.type === "parked") {
        if (oldClientId !== undefined && entry.seq !== undefined) void this.outbox?.dequeue(oldClientId, entry.seq);
        this.rejectPending(entry.requestId, new OfflineClientResetError());
        this.reconciler.onMutationFailure(entry.requestId); // remove from the log (no layer to roll back)
        parkedRejected++;
      } else if (entry.status.type === "unsent") {
        // Re-key onto the fresh identity under a brand-new seq; the old durable record is dropped.
        if (oldClientId !== undefined && entry.seq !== undefined) void this.outbox?.dequeue(oldClientId, entry.seq);
        entry.clientId = fresh;
        entry.seq = this.outboxNextSeq++;
        entry.order = this.nextOutboxOrder();
        void this.outbox?.append(this.toOutboxEntry(entry));
        unsentReEnqueued++;
      }
    }

    if (this.outbox) {
      await mintIdentity(this.outbox, { mintClientId: () => fresh, deployment: this.outboxDeploymentId });
      // The fresh meta row must reflect the seqs already re-handed-out to `unsent` entries above.
      await this.outbox.setMeta(fresh, { nextSeq: this.outboxNextSeq, deployment: this.outboxDeploymentId });
    }

    this.onClientResetCallback?.({ oldClientId, newClientId: fresh, unsentReEnqueued, parkedRejected });
  }

  /** The in-memory log entry with this recorded `(clientId, seq)`, or `undefined`. */
  private findOutboxEntry(clientId: string, seq: number): PendingMutation | undefined {
    for (const e of this.reconciler.entries()) {
      if (e.clientId === clientId && e.seq === seq) return e;
    }
    return undefined;
  }

  /** Resolve a pending mutation promise by requestId (no-op if it already settled / has no awaiter). */
  private resolvePending(requestId: string, value: Value): void {
    const pending = this.pendingMutations.get(requestId);
    this.pendingMutations.delete(requestId);
    pending?.resolve(value);
  }

  /** Reject a pending mutation promise by requestId (no-op if it already settled / has no awaiter). */
  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingMutations.get(requestId);
    this.pendingMutations.delete(requestId);
    pending?.reject(error);
  }

  /** Drop an `applied` cross-session entry's layer — deferred until the baseline is adopted (so the
   *  drop is flicker-free), or immediately if it already has. */
  private dropAfterBaseline(requestId: string): void {
    if (this.outboxAwaitingBaseline) this.outboxPendingDrops.push(requestId);
    else this.reconciler.onVerdictAfterBaseline(requestId);
  }

  /** Dequeue a settled durable entry from the outbox store (no-op without an outbox / clientId). */
  private dequeueOutboxEntry(entry: PendingMutation | undefined): void {
    if (this.outbox && entry?.clientId !== undefined && entry.seq !== undefined) {
      void this.outbox.dequeue(entry.clientId, entry.seq);
    }
  }

  /** An `Error` carrying the server's terminal verdict `code` (STALE_CLIENT, an app error code) so
   *  the drain's coded-vs-codeless retry policy (T4) and apps can key off it. */
  private mutationError(message: string, code?: string): Error {
    const err = new Error(message);
    if (code !== undefined) (err as Error & { code?: string }).code = code;
    return err;
  }

  /* ---------------------------------------------------------------------------------------------
   * Task 4 — the drain host. These bind the drain's `DrainHost` seam to the client's private state
   * so the T3 settlement primitives (`resolvePending`/`rejectPending`, `dequeue`, the drop rule) are
   * REUSED by the drain, not forked (verdict §(d) "Drain").
   * ------------------------------------------------------------------------------------------- */

  /** @internal test/debug — the live drain (Task 4), or `undefined` without an outbox. */
  get __outboxDrain(): OutboxDrain | undefined {
    return this.outboxDrain;
  }

  private makeDrainHost(): DrainHost {
    return {
      outbox: this.outbox!,
      currentClientId: () => this.outboxClientId,
      currentFingerprint: () => this.outboxFingerprint,
      transportOpen: () => !this.closed,
      isArmed: () => this.outboxArmed,
      drainable: () => this.drainableEntries(),
      addHydrated: (entry) => this.addHydratedEntry(entry),
      ensureInitialHandshake: () => this.initiateHandshake(this.store.byId.size > 0),
      setStatus: (entry, status) => {
        entry.status = { type: status };
      },
      batchEntry: (entry) => this.drainBatchEntry(entry),
      sendBatch: (entries) => this.transport.send({ type: "MutationBatch", entries }),
      settleApplied: (requestId, value) => this.drainSettleApplied(requestId, value),
      settleTerminal: (requestId, code, message) => this.drainSettleTerminal(requestId, code, message),
      whenBaselineAdopted: () => this.whenBaselineAdopted(),
    };
  }

  /** Drain-eligible entries: durable, recorded `(clientId, seq)`, still `unsent`/`parked`, FIFO by
   *  the persisted `order`. Excludes `inflight` (a live direct-send or an in-flight chunk unit) and
   *  `completed`. */
  private drainableEntries(): PendingMutation[] {
    return this.reconciler
      .entries()
      .filter(
        (e) =>
          e.clientId !== undefined &&
          e.seq !== undefined &&
          e.durable === true &&
          (e.status.type === "unsent" || e.status.type === "parked"),
      )
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }

  /** Add a hydrated durable entry into the log under a FRESH requestId (the persisted requestId was
   *  session-correlation only; a fresh one avoids colliding with this session's requestId counter).
   *  Idempotent by `(clientId, seq)` — a direct-send this session already tracks is not re-added.
   *  Layerless (no `update`): T5's registry rebuilds cross-reload optimistic layers; T4 leaves them
   *  bare, which is a clean drop under the baseline-gated drop rule. */
  private addHydratedEntry(e: OutboxEntry): void {
    for (const existing of this.reconciler.entries()) {
      if (existing.clientId === e.clientId && existing.seq === e.seq) return;
    }
    // Keep the order counter ahead of every hydrated (past-session) order so new mutations this
    // session sort strictly AFTER the hydrated backlog — FIFO across the reload boundary.
    this.outboxOrderCounter = Math.max(this.outboxOrderCounter, e.order);
    const entry: PendingMutation = {
      requestId: String(this.nextRequestId++),
      udfPath: e.udfPath,
      args: e.args,
      seed: e.seed,
      touched: new Set(),
      status: { type: "unsent" },
      clientId: e.clientId,
      seq: e.seq,
      order: e.order,
      identityFingerprint: e.identityFingerprint,
      enqueuedAt: e.enqueuedAt,
      durable: true,
    };
    this.reconciler.log.add(entry);
  }

  private drainBatchEntry(entry: PendingMutation): MutationBatchEntry {
    return { requestId: entry.requestId, udfPath: entry.udfPath, args: entry.args, clientId: entry.clientId, seq: entry.seq };
  }

  /** applied/replayed settlement for a drained unit — the same primitives `settleVerdict`'s
   *  `applied` case uses (resolve the awaiting promise if any, dequeue the durable record, drop the
   *  layer after baseline). Drop-soundness (T3 watch item): a drain replay-ack carries the ORIGINAL
   *  historical commitTs, but the drop is gated on baseline adoption, not on that commitTs — the
   *  entry's commit necessarily predates this session's `Connect`, so it predates the baseline's
   *  read snapshot and the baseline already renders the effect. Historical-ts-vs-current-base is
   *  therefore still covered; the drop is flicker-free by the same one-pass rule as T3's handshake. */
  private drainSettleApplied(requestId: string, value: Value | null): void {
    const entry = this.reconciler.getEntry(requestId);
    this.resolvePending(requestId, value);
    if (entry?.clientId !== undefined && entry.seq !== undefined) void this.outbox?.dequeue(entry.clientId, entry.seq);
    if (entry) this.dropAfterBaseline(requestId);
  }

  /** Terminal settlement for a drained unit (a coded server verdict, or the identity gate) — reject
   *  the awaiting promise (coded), dequeue the durable record, drop the layer. */
  private drainSettleTerminal(requestId: string, code: string | undefined, message: string): void {
    const entry = this.reconciler.getEntry(requestId);
    this.rejectPending(requestId, this.mutationError(message, code));
    if (entry?.clientId !== undefined && entry.seq !== undefined) void this.outbox?.dequeue(entry.clientId, entry.seq);
    if (entry) this.reconciler.onMutationFailure(requestId);
  }
}
