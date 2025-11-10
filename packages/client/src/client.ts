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
import { versionsEqual, INITIAL_VERSION, type ClientMessage, type ServerMessage, type StateVersion } from "@stackbase/sync";
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
  OutboxOverflowError,
  defaultMintClientId,
  mintIdentity,
  type OutboxEntry,
  type OutboxStorage,
} from "./outbox-storage";

export type { QueryListener, QueryErrorListener };

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

  constructor(
    transport: ClientTransport,
    opts: { gateTimeoutMs?: number; outbox?: OutboxStorage; outboxMaxQueueSize?: number } = {},
  ) {
    this.transport = transport;
    this.reconciler = new Reconciler(this.store, { gateTimeoutMs: opts.gateTimeoutMs });
    this.outbox = opts.outbox;
    this.outboxMaxQueueSize = opts.outboxMaxQueueSize ?? DEFAULT_OUTBOX_MAX_QUEUE_SIZE;
    if (opts.outbox) {
      this.outboxClientId = defaultMintClientId();
      this.outboxIdentity = mintIdentity(opts.outbox, { mintClientId: () => this.outboxClientId! }).then((id) => {
        this.outboxNextSeq = Math.max(this.outboxNextSeq, id.nextSeq);
        return id;
      });
    }
    this.disposeTransport = transport.onMessage((msg) => this.onServerMessage(msg));
    this.disposeClose = transport.onClose(() => this.onTransportClosed());
    this.disposeReopen = transport.onReopen?.(() => this.onTransportReopened());
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
        return;
      }
      case "MutationResponse": {
        const pending = this.pendingMutations.get(msg.requestId);
        this.pendingMutations.delete(msg.requestId);
        if (msg.success) {
          // `value` is optional on the wire (a Receipted Outbox replay-ack with `valueMissing`
          // omits it); coalesce to null. Full replay handling is Plan B — this keeps today's shape.
          pending?.resolve(jsonToConvex(msg.value ?? null)); // D3: resolve now
          this.reconciler.onMutationSuccess(msg.requestId, msg.ts);
        } else {
          pending?.reject(new Error(msg.error));
          this.reconciler.onMutationFailure(msg.requestId);
        }
        return;
      }
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
    for (const entry of this.reconciler.unsentInOrder()) {
      entry.status = { type: "inflight" };
      this.transport.send(this.mutationMessage(entry));
    }
  }
}
