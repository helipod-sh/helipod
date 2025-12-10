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
import { isDevMode, type OptimisticLocalStore, type OptimisticUpdateFn } from "./optimistic-store";
import {
  DEFAULT_OUTBOX_MAX_QUEUE_SIZE,
  OUTBOX_VERSION,
  OfflineClientResetError,
  OutboxOverflowError,
  defaultMintClientId,
  mintIdentity,
  type OutboxEntry,
  type OutboxEntryError,
  type OutboxEntryStatus,
  type OutboxStorage,
} from "./outbox-storage";
import { OutboxDrain, type DrainHost, type OutboxLockManager, type PoisonPolicy } from "./outbox-drain";
import { buildConnectMessage, outboxHeldFromLog } from "./connect-handshake";
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

/** T5 (R9): the `onMutationFailed` callback's payload — a terminal, server-recorded verdict for a
 *  durable outbox entry the CURRENT session may have no live promise awaiter for (a hydrated
 *  cross-reload entry, a retried one, or one discovered already-failed at construction — "resume"). */
export interface MutationFailedInfo {
  clientId: string;
  seq: number;
  udfPath: string;
  error: OutboxEntryError;
}

/** T5 (R9): one row of `client.pendingMutations()`/`usePendingMutations()` — a snapshot from the
 *  DURABLE store (verdict §(d) "Observability"), not the in-memory reconciler log; `retry()`/
 *  `dismiss()` are meaningful only when `status === "failed"` (a terminal, server-recorded verdict —
 *  every other status is still in flight and simply isn't a `retry()`/`dismiss()` candidate) and are
 *  harmless no-ops otherwise. */
export interface PendingMutationEntry {
  readonly clientId: string;
  readonly seq: number;
  readonly udfPath: string;
  readonly status: OutboxEntryStatus;
  readonly enqueuedAt: number;
  readonly error?: OutboxEntryError;
  /** Re-enqueue this FAILED entry under a fresh `(clientId, seq)` — "never reuse a seq for a new
   *  attempt" (verdict §(b)): the old seq's durable record IS its terminal verdict. No-op unless
   *  `status === "failed"`. */
  retry(): Promise<void>;
  /** Permanently remove this FAILED entry from the durable store without retrying. No-op unless
   *  `status === "failed"`. */
  dismiss(): Promise<void>;
}

/** T5 (R9, hazard 2's client half): the queue-age/size advisory — cheap enough to poll before
 *  surfacing a "you have offline changes that may be lost soon" banner ahead of Safari's 7-day
 *  eviction cliff. `oldestEnqueuedAt`/`oldestAgeMs` are `undefined` for an empty (or unconfigured)
 *  outbox. */
export interface PendingSummary {
  count: number;
  oldestEnqueuedAt: number | undefined;
  oldestAgeMs: number | undefined;
}

/** T5 (R9): the one method `usePendingMutations()`'s cross-tab nudge needs from `BroadcastChannel` —
 *  a minimal, structurally-fakeable seam (the same probe-and-fallback discipline as
 *  `OutboxLockManager`, `./outbox-drain`). Real `BroadcastChannel`s satisfy this structurally. */
export interface OutboxBroadcastLike {
  postMessage(message: unknown): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  close(): void;
}

/** T-crosstab (browser-ux spec Part A): the broadcast channel's payload becomes ADDITIVELY typed.
 *  Today's bare `1` ("the message IS the nudge", see `notifyOutboxChange` below) stays a valid,
 *  forward-compatible message forever — every listener still fires its `outboxChangeListeners` fan-out
 *  on ANY payload shape first (`onmessage` below), unconditionally. These three shapes let a receiver
 *  additionally MIRROR another tab's durable entries live, instead of merely re-reading on next poll:
 *   - `enqueued` — posted after any durable-outbox-mutating write (append/dequeue/status change);
 *     the receiver re-reads `loadAll()` and reconciles its mirrored set against it (the backstop).
 *   - `settled` — posted by the drain leader right after an `applied` verdict; a mirroring tab holds
 *     its layer `completed` and drops it only once ITS OWN feed observes `commitTs` (flicker-free).
 *   - `failed` — posted by the drain leader right after a terminal verdict; a mirroring tab drops the
 *     layer and fires its own R9 `onMutationFailed`/dev-loud default (no promise exists to reject).
 *  A payload that isn't one of these three (including the legacy bare `1`, or anything malformed) is
 *  simply not recognized by `isOutboxBroadcastMessage` below — nudge-only, mirrors nothing, throws
 *  nothing. */
export type OutboxBroadcastMessage =
  | { kind: "enqueued" }
  | { kind: "settled"; clientId: string; seq: number; commitTs: number }
  | { kind: "failed"; clientId: string; seq: number; code?: string; message: string };

/** Structural guard for `OutboxBroadcastMessage` — deliberately shallow (only `kind` is checked):
 *  the caller (`onCrossTabSettle`) already tolerates a missing/wrong-typed `clientId`/`seq` by
 *  simply finding no matching entry (a strict field-by-field validator would just be more code for
 *  the same outcome), and the whole typed-dispatch call is wrapped in try/catch regardless (hazard
 *  (d): "a malformed typed payload must never break the nudge contract"). */
function isOutboxBroadcastMessage(data: unknown): data is OutboxBroadcastMessage {
  if (typeof data !== "object" || data === null || !("kind" in data)) return false;
  const kind = (data as { kind: unknown }).kind;
  return kind === "enqueued" || kind === "settled" || kind === "failed";
}

/** Probe the ambient `BroadcastChannel` global — absent in most Node/vitest runtimes and in
 *  private-mode Safari without a same-origin partition; returns `undefined` there, in which case
 *  cross-tab observability degrades to same-instance-only (still fully reactive within one tab).
 *  Wraps (rather than returns) the real channel: the DOM `BroadcastChannel.onmessage` setter's
 *  parameter type is the full `MessageEvent`, which isn't structurally assignable to this seam's
 *  minimal `{ data: unknown }` shape — the wrapper is the adapter, not a cast. */
function probeBroadcastChannel(name: string): OutboxBroadcastLike | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined;
  const channel = new BroadcastChannel(name);
  let closed = false;
  const wrapper: OutboxBroadcastLike = {
    // A `postMessage` racing an in-flight write-behind `.then()` against `close()` (e.g. a client
    // torn down mid-test, or an app unmounting while an append is still resolving) must NEVER throw
    // out from under `notifyOutboxChange()` — `closed` makes this a harmless no-op instead of the
    // DOM's `InvalidStateError`.
    postMessage: (message) => {
      if (!closed) channel.postMessage(message);
    },
    onmessage: null,
    close: () => {
      closed = true;
      channel.close();
    },
  };
  channel.onmessage = (ev) => wrapper.onmessage?.({ data: ev.data });
  return wrapper;
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
  private readonly pendingMutationCallbacks = new Map<string, { resolve: (v: Value) => void; reject: (e: Error) => void }>();
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

  /* -------------------------------------------------------------------------------------------
   * T5 — the `optimisticUpdates` registry, R9 observability.
   * ------------------------------------------------------------------------------------------- */

  /** T5: the registry `mutation()` NEVER consults — only `addHydratedEntry` does, at hydrate time
   *  (verdict §(d): "call-site closure wins for the live call; the registry is consulted only at
   *  hydrate"). Plain string-keyed: a generated `UdfPathOf<Api>` union (`@stackbase/codegen`) narrows
   *  the caller's OWN object-literal keys; this package never imports that generated type. */
  private readonly optimisticUpdates: Partial<Record<string, OptimisticUpdateFn>>;
  /** udfPaths already warned for a registry miss at hydrate — "one warn per udfPath" (spec §(k)6),
   *  not once per missed ENTRY (a stale backlog of the same unregistered udfPath warns exactly once). */
  private readonly optimisticUpdateMissWarned = new Set<string>();
  /** T5 (R9): fired for a terminal durable failure with no live promise awaiter THIS session (a
   *  hydrated/retried entry, or one discovered already-failed at construction — "resume"). Never
   *  fired for a failure a live `mutation()` caller's own rejected promise already delivered
   *  (Lunora's `hadAwaiter` — no double notification for one failure). */
  private readonly onMutationFailedCallback?: (info: MutationFailedInfo) => void;
  /** T5 (R9): same-instance listeners for "the durable outbox changed" — `usePendingMutations()`'s
   *  re-read trigger. Fired locally on every outbox-mutating op AND on an incoming cross-tab
   *  `outboxBroadcast` message (unified into one path — a listener never needs to know which). */
  private readonly outboxChangeListeners = new Set<() => void>();
  /** T5 (R9): the cross-tab nudge — `undefined` when no outbox is configured or the probe/injected
   *  option resolved to nothing (single-tab observability still works via `outboxChangeListeners`). */
  private readonly outboxBroadcast?: OutboxBroadcastLike;
  /** T-crosstab: serializes `mirrorFromStore()` — a second call arriving while one is already
   *  in-flight (a rapid burst of `enqueued` broadcasts) sets this bit instead of racing a second
   *  `loadAll()`; the in-flight run loops once more on completion so the caller's freshest read is
   *  never dropped. */
  private mirrorInFlight = false;
  private mirrorRerun = false;

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
      /** T5: the durable-outbox registry — consulted ONLY when a durable entry is hydrated after a
       *  reload (never for a live call). Plain string-keyed here; a generated `UdfPathOf<Api>`
       *  (`@stackbase/codegen`) narrows an app's own object literal at the call site. */
      optimisticUpdates?: Partial<Record<string, OptimisticUpdateFn>>;
      /** T5 (R9): fired for a terminal durable failure with no live promise awaiter this session. */
      onMutationFailed?: (info: MutationFailedInfo) => void;
      /** T5 (R9): the cross-tab nudge for `usePendingMutations()` — `undefined` probes the ambient
       *  `BroadcastChannel`, `null` disables it (single-tab observability only), an object is used
       *  directly (tests inject a fake). */
      outboxBroadcast?: OutboxBroadcastLike | null;
    } = {},
  ) {
    this.transport = transport;
    this.reconciler = new Reconciler(this.store, { gateTimeoutMs: opts.gateTimeoutMs });
    this.outbox = opts.outbox;
    this.onClientResetCallback = opts.onClientReset;
    this.outboxMaxQueueSize = opts.outboxMaxQueueSize ?? DEFAULT_OUTBOX_MAX_QUEUE_SIZE;
    this.optimisticUpdates = opts.optimisticUpdates ?? {};
    this.onMutationFailedCallback = opts.onMutationFailed;
    if (opts.outbox) {
      this.outboxClientId = defaultMintClientId();
      this.outboxIdentity = mintIdentity(opts.outbox, { mintClientId: () => this.outboxClientId! }).then((id) => {
        this.outboxNextSeq = Math.max(this.outboxNextSeq, id.nextSeq);
        return id;
      });
      // `this.outboxIdentity` is returned verbatim to `getOutboxIdentity()` callers (who may attach
      // their own handler, or never call it at all) — attaching a SEPARATE catch here (on the same
      // promise; a harmless fan-out, not a value consumption) guarantees it is never left unhandled
      // regardless of whether an external caller ever awaits it. A `mintIdentity` failure (the
      // durable meta-row write behind a fail-stopped outbox) has no mutation record to attach to —
      // floors to the same observability path as any other meta-only durable write.
      this.outboxIdentity.catch((err: unknown) => this.handleOutboxWriteError("mintIdentity", this.outboxClientId, undefined, undefined, err));
      this.outboxDrain = new OutboxDrain(this.makeDrainHost(), {
        lockName: `stackbase:outbox:${this.originTag()}:${opts.outboxDeployment ?? "default"}`,
        locks: opts.outboxLocks,
        poisonPolicy: opts.poisonPolicy,
        chunkSize: opts.outboxChunkSize,
        intervalMs: opts.outboxDrainIntervalMs,
        backoffMs: opts.outboxBackoffMs,
        onPause: opts.onOutboxPause,
      });
      this.outboxBroadcast =
        opts.outboxBroadcast === null ? undefined : (opts.outboxBroadcast ?? probeBroadcastChannel(`stackbase:outbox:${this.originTag()}:${opts.outboxDeployment ?? "default"}:pending`));
      if (this.outboxBroadcast) {
        this.outboxBroadcast.onmessage = (event) => {
          // Keep the unconditional accessor fan-out FIRST — every existing/legacy listener nudges
          // on ANY message, exactly as before this typed dispatch existed.
          for (const l of this.outboxChangeListeners) l();
          // The typed path is IN ADDITION, and must never break the nudge contract above: a
          // malformed/foreign payload floors to console, never throws out of `onmessage`.
          try {
            this.handleOutboxBroadcastMessage(event.data);
          } catch (err) {
            if (isDevMode()) console.error("[stackbase] outbox: error handling a cross-tab broadcast message", err);
          }
        };
      }
      // R9 "resume" refire: scan the durable store for ALREADY-failed entries left behind (a prior
      // session that ended before the app ever surfaced them) — trivially "no awaiter" (nothing has
      // called `mutation()` yet this session), so every one refires unconditionally.
      void this.refireDurableFailures();
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
      this.pendingMutationCallbacks.set(requestId, { resolve, reject });
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
        // `closeDisposition` reads it at close ("park eligibility requires durability"). A rejected
        // append (e.g. a fail-stopped `fsOutbox` after a disk error) must NOT become an unhandled
        // rejection — see `handleOutboxWriteError`.
        void this.outbox
          .append(this.toOutboxEntry(entry))
          .then(() => {
            entry.durable = true;
            // Now durable → drain-eligible: wake the drain (wake on enqueue, verdict §(d)).
            this.outboxDrain?.nudge();
            this.notifyOutboxChange(); // T5 (R9): usePendingMutations()'s re-read trigger.
          })
          .catch((err: unknown) => this.handleOutboxWriteError("append", entry.clientId, entry.seq, entry.udfPath, err));
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
   *  drain) — the FIFO-preserving gate a new mutation enqueues behind (verdict §(d) "Enqueue").
   *  A drain chunk in flight also counts (its units are `inflight`, which the scan alone would miss
   *  when the chunk consumed the whole backlog) — otherwise a mutation issued mid-chunk would
   *  direct-send AHEAD of a still-unsettled older unit, breaking the FIFO promise if the chunk
   *  transient-stops and re-sends. Plain live in-flight direct-sends deliberately do NOT count:
   *  "when empty, live sends go direct and concurrent" (T2's scoping, unchanged). */
  private hasOutboxBacklog(): boolean {
    if (this.outboxDrain?.hasActiveChunk) return true;
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
    this.outboxBroadcast?.close();
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
        const pending = this.pendingMutationCallbacks.get(msg.requestId);
        const hadAwaiter = pending !== undefined;
        this.pendingMutationCallbacks.delete(msg.requestId);
        if (msg.success) {
          // `value` is optional on the wire (a Receipted Outbox replay-ack with `valueMissing`
          // omits it); coalesce to null. Full replay handling is Plan B — this keeps today's shape.
          pending?.resolve(jsonToConvex(msg.value ?? null)); // D3: resolve now
          this.reconciler.onMutationSuccess(msg.requestId, msg.ts);
          // A successful response means this durable entry's fate is known — dequeue it so it never
          // resends. (No-op when no outbox is configured.)
          this.dequeueOutboxEntry(entry);
        } else {
          pending?.reject(this.mutationError(msg.error, msg.code));
          this.reconciler.onMutationFailure(msg.requestId);
          // R9: MARK failed (persist for the tray) instead of dequeuing — a retryable follow-up is a
          // FRESH seq (verdict §(d) `retry()`), never a resurrection of this record. `hadAwaiter` is
          // essentially always true on this direct-send path (the caller's own promise already
          // learned of the failure via `pending.reject` above) — the refire/dev-loud path exists for
          // the rare case a caller's promise had no live handler by the time this settles.
          if (entry?.clientId !== undefined && entry.seq !== undefined) {
            this.outboxMarkFailed(entry.clientId, entry.seq, msg.error, msg.code);
          }
          if (!hadAwaiter) this.notifyMutationFailed(entry?.clientId, entry?.seq, entry?.udfPath ?? "unknown", { message: msg.error, code: msg.code });
        }
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
      // `resultHash` (subscription resume): echoed ONLY for a sub that was actually delivered a
      // base value and still has its fingerprint on hand — a failed sub (`serverValue` never set),
      // a never-answered sub, or one whose last `QueryUpdated` had no `hash` (old server) echoes
      // nothing, falling through to today's full-send byte-for-byte. Note this condition doesn't
      // check "currently failed" — a sub that failed AFTER a prior success still has a retained
      // `serverValue`/`lastHash` from that success and still echoes it here. That's sound: the
      // server only replies `QueryUnchanged` if the FRESH re-run (against live, current state)
      // hashes equal to the echoed base — i.e. the query has recovered back to that exact value —
      // in which case `QueryUnchanged` renders exactly what a full `QueryUpdated` send would have
      // delivered. Any other outcome (still failing, or recovered to a different value) arrives as
      // a normal `QueryFailed`/`QueryUpdated` modification, not `QueryUnchanged`.
      add: subs.map((s) => ({
        queryId: s.queryId,
        udfPath: s.path,
        args: s.args,
        ...(s.answered && s.serverValue !== undefined && s.lastHash !== undefined ? { resultHash: s.lastHash } : {}),
      })),
      remove: [],
    });
  }

  private onTransportClosed(): void {
    this.closed = true;
    this.outboxConnectSent = false; // a fresh connection needs a fresh Connect handshake.
    // BEFORE the S4 close rules: revert the drain's in-flight chunk (its unresponded units will
    // never get a response on the new server session) so `closeSession` below sees them as plain
    // `unsent` retained entries, and the drain's one-unacked invariant (`active === null`) can't
    // wedge the rest of this tab session (see `OutboxDrain#onTransportClosed`). Leadership and the
    // interval nudge survive a reconnect-class close; only `close()` stops the drain.
    this.outboxDrain?.onTransportClosed();
    // S4 close rules: unsent retained; inflight/completed layers drop; frontier resets. Task 2's
    // park swap (armed + durable) is folded in here via `this.outboxArmed` — `rejectedInflight`
    // already excludes anything that parked instead; a parked entry's promise stays pending in
    // `pendingMutationCallbacks`, untouched, ready for a future drain (T4) to settle.
    const { rejectedInflight, parked } = this.reconciler.closeSession(this.outboxArmed);
    for (const rid of rejectedInflight) {
      const pending = this.pendingMutationCallbacks.get(rid);
      this.pendingMutationCallbacks.delete(rid);
      pending?.reject(new MutationUndeliveredError());
    }
    // T5 (R9): persist the park transition too — otherwise a parked entry's durable `status` stays
    // frozen at whatever it was appended/last flushed as, misleading `pendingMutations()`'s tray.
    for (const rid of parked) {
      const entry = this.reconciler.getEntry(rid);
      if (entry?.clientId !== undefined && entry.seq !== undefined) this.outboxUpdateStatus(entry.clientId, entry.seq, "parked");
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

  /** True iff at least one live subscription has NOT yet received its first server reply
   *  (`!sub.answered` — set by `ingestTransition` on EITHER outcome, `QueryUpdated` or `QueryFailed`).
   *  The drain's first-connect `ensureInitialHandshake` gate (T4 bug fix, later widened to cover the
   *  failed-query shape too — re-review FIX 2): a subscription created (and answered) BEFORE the
   *  drain's async hydrate finishes has already consumed its one-shot Transition by the time the
   *  handshake arms — waiting for ANOTHER one that will never come on a quiet deployment would starve
   *  `whenBaselineAdopted()` (and so the drain) forever. Only a subscription still awaiting its first
   *  reply guarantees a future Transition is actually coming — that's the one worth waiting for.
   *  (Deliberately NOT `sub.serverValue === undefined`: a `QueryFailed` reply never sets `serverValue`
   *  — there's no base to render — so that check misclassified an already-answered failed query as
   *  still-undelivered and reproduced the same deadlock via the failed-query path.) */
  private hasUndeliveredSubscription(): boolean {
    for (const sub of this.store.byId.values()) {
      if (!sub.answered) return true;
    }
    return false;
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
   *  queries); for a first connect, whether any live subscription is still awaiting its first
   *  delivery (`hasUndeliveredSubscription()` — NOT merely whether one exists: a subscription
   *  created and already answered before the handshake armed has nothing left to wait for). With
   *  nothing pending, there is no baseline frame coming and adoption is immediate. */
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
   *  server-side retention pruning). Delegates the pure computation to `./connect-handshake` — the
   *  SAME shared module the headless drain (`headless-drain.ts`) builds its own `Connect` from. */
  private sendConnect(): void {
    const held = outboxHeldFromLog(this.reconciler.entries());
    this.transport.send(buildConnectMessage(makeEntropy(), this.outboxClientId!, held));
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
      // Stamp the timeline onto the current clientId's meta row (best-effort, fire-and-forget). No
      // mutation record to attach a failure to (this is a meta-only write) — the dev-loud
      // console.error floor in `handleOutboxWriteError` applies.
      void this.outbox
        .setMeta(this.outboxClientId, { nextSeq: this.outboxNextSeq, deployment: msg.deploymentId })
        .catch((err: unknown) => this.handleOutboxWriteError("setMeta", this.outboxClientId, undefined, undefined, err));
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
        // Unconditional is sound HERE (unlike a drain response, see `drainSettleApplied`): a
        // ConnectAck verdict is always classifying a seq from a PRIOR connect — by construction its
        // commit predates this session's `Connect`, hence the baseline — never a fresh same-session
        // apply, so there is no flicker risk to gate against.
        const value = v.valueMissing ? null : jsonToConvex(v.value ?? null);
        if (entry) this.resolvePending(entry.requestId, value);
        this.outboxDequeue(v.clientId, v.seq);
        if (entry) this.dropAfterBaseline(entry.requestId);
        break;
      }
      case "failed": {
        // R9: MARK failed (persist, don't dequeue) instead of removing — "failed entries persist
        // until dismissed/retried". `hadAwaiter` gates the `onMutationFailed` refire (never a double
        // notification for a failure the entry's own live promise already delivered THIS session).
        const hadAwaiter = entry ? this.pendingMutationCallbacks.has(entry.requestId) : false;
        const message = `mutation "${entry?.udfPath ?? "unknown"}" failed`;
        if (entry) this.rejectPending(entry.requestId, this.mutationError(message, v.code));
        this.outboxMarkFailed(v.clientId, v.seq, message, v.code);
        if (entry) this.reconciler.onMutationFailure(entry.requestId);
        if (!hadAwaiter) this.notifyMutationFailed(v.clientId, v.seq, entry?.udfPath ?? "unknown", { message, code: v.code });
        break;
      }
      case "stale": {
        const hadAwaiter = entry ? this.pendingMutationCallbacks.has(entry.requestId) : false;
        const message = "mutation disowned (STALE_CLIENT)";
        const code = v.code ?? "STALE_CLIENT";
        if (entry) this.rejectPending(entry.requestId, this.mutationError(message, code));
        this.outboxMarkFailed(v.clientId, v.seq, message, code);
        if (entry) this.reconciler.onMutationFailure(entry.requestId);
        if (!hadAwaiter) this.notifyMutationFailed(v.clientId, v.seq, entry?.udfPath ?? "unknown", { message, code });
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
      // The durable store is keyed by each entry's RECORDED `(clientId, seq)` — for an entry
      // hydrated from a prior session that is the PRIOR session's clientId, not this session's
      // `oldClientId`. Targeting `oldClientId` here made the dequeue/markFailed below a silent
      // no-op for every hydrated entry (its record lingered in the store forever, so
      // `pendingMutations()` never drained to empty after a reset) — the fsOutbox E2E found it.
      const recordedClientId = entry.clientId ?? oldClientId;
      if (entry.status.type === "parked") {
        // R9: MARK failed (persist for the tray) rather than dequeue — a deliberate user-initiated
        // `retry()` under a FRESH `(clientId, seq)` is safe even though a blind auto-resend under the
        // OLD identity would not be (the reason it rejects loudly in the first place).
        const hadAwaiter = this.pendingMutationCallbacks.has(entry.requestId);
        const resetMessage = "the server disowned this client's mutation history (swept/foreign timeline)";
        if (recordedClientId !== undefined && entry.seq !== undefined) {
          this.outboxMarkFailed(recordedClientId, entry.seq, resetMessage, "OFFLINE_CLIENT_RESET");
        }
        this.rejectPending(entry.requestId, new OfflineClientResetError());
        this.reconciler.onMutationFailure(entry.requestId); // remove from the log (no layer to roll back)
        if (!hadAwaiter) this.notifyMutationFailed(recordedClientId, entry.seq, entry.udfPath, { message: resetMessage, code: "OFFLINE_CLIENT_RESET" });
        parkedRejected++;
      } else if (entry.status.type === "unsent") {
        // Re-key onto the fresh identity under a brand-new seq; the old durable record is dropped.
        if (recordedClientId !== undefined && entry.seq !== undefined) this.outboxDequeue(recordedClientId, entry.seq);
        entry.clientId = fresh;
        entry.seq = this.outboxNextSeq++;
        entry.order = this.nextOutboxOrder();
        this.outboxAppend(entry);
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
    const pending = this.pendingMutationCallbacks.get(requestId);
    this.pendingMutationCallbacks.delete(requestId);
    pending?.resolve(value);
  }

  /** Reject a pending mutation promise by requestId (no-op if it already settled / has no awaiter). */
  private rejectPending(requestId: string, error: Error): void {
    const pending = this.pendingMutationCallbacks.get(requestId);
    this.pendingMutationCallbacks.delete(requestId);
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
    if (entry?.clientId !== undefined && entry.seq !== undefined) this.outboxDequeue(entry.clientId, entry.seq);
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
      ensureInitialHandshake: () => this.initiateHandshake(this.hasUndeliveredSubscription()),
      setStatus: (entry, status) => {
        entry.status = { type: status };
        // T5 (R9): persist the transition too — `pendingMutations()` reads the DURABLE record, so
        // without this its `status` would stay frozen at whatever `append()` first wrote.
        if (entry.clientId !== undefined && entry.seq !== undefined) this.outboxUpdateStatus(entry.clientId, entry.seq, status);
      },
      batchEntry: (entry) => this.drainBatchEntry(entry),
      sendBatch: (entries) => this.transport.send({ type: "MutationBatch", entries }),
      settleApplied: (requestId, value, replayed, ts) => this.drainSettleApplied(requestId, value, replayed, ts),
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
   *  T5: `entry.update` is populated from the `optimisticUpdates` registry (hydrate-only lookup — a
   *  live call-site closure is never in play here, there IS no live call site for a cross-reload
   *  entry); a registry miss is layerless (no `update` at all), a clean drop under the baseline-gated
   *  drop rule exactly as T4 shipped it. */
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
      update: this.lookupHydratedUpdate(e.udfPath),
    };
    // `addHydrated` (not `initiate`): a throwing registered updater here is ordinary replay-drop
    // collateral (warned + dropped), never rethrown — there is no synchronous caller on the hydrate
    // path to propagate it to (see `reconcile.ts#addHydrated`'s doc).
    this.reconciler.addHydrated(entry);
  }

  /** T5: the registry lookup `addHydratedEntry` makes — hydrate-time ONLY (verdict §(d): "the
   *  registry is consulted at hydrate only"). A miss warns ONCE per udfPath (not per entry — a
   *  backlog of many unregistered entries for the same udfPath warns once) and returns `undefined`:
   *  the entry still drains fine, only its optimistic rendering is skipped (spec §(k)6). */
  private lookupHydratedUpdate(udfPath: string): OptimisticUpdate | undefined {
    const fn = this.optimisticUpdates[udfPath];
    if (fn) return fn as unknown as OptimisticUpdate;
    if (!this.optimisticUpdateMissWarned.has(udfPath)) {
      this.optimisticUpdateMissWarned.add(udfPath);
      console.warn(
        `[stackbase] outbox: no optimisticUpdates registered for "${udfPath}" — a hydrated cross-reload ` +
          `mutation for it will drain without an optimistic layer (rendering only; the mutation itself is unaffected)`,
      );
    }
    return undefined;
  }

  /* ---------------------------------------------------------------------------------------------
   * T-crosstab (browser-ux spec Part A) — live cross-tab rendering. Extends the hydrate machinery
   * above (`addHydratedEntry`/`lookupHydratedUpdate`) with live callers driven by the broadcast
   * channel, instead of its one construction-time caller (`OutboxDrain#hydrateOnce`).
   * ------------------------------------------------------------------------------------------- */

  /** The one predicate distinguishing a MIRRORED entry (another tab-session's durable append, or
   *  this tab's own past-session hydrate — either way, no live promise) from an entry THIS instance
   *  itself initiated live (hazard (a), "own-tab discrimination"): durable AND no
   *  `pendingMutationCallbacks` registered for its `requestId`. A live `mutation()` caller has a
   *  callback registered only UNTIL its own wire response settles it — resolved/rejected callbacks
   *  are deleted immediately (`resolvePending`/`rejectPending`), well before a `completed` layer's
   *  gate gets a chance to drop it. So a live caller's entry looks exactly like a true mirror
   *  (`isMirroredEntry` returns `true`) for the whole post-ack, still-gated window — this predicate
   *  alone does NOT distinguish "own tab, post-ack" from "another tab's mirror"; it is the
   *  `status.type === "completed"` skip in `mirrorFromStore`'s backstop pass that closes that gap
   *  (a `completed` layer is owned by its gate, never force-settled by this predicate or the store).
   *  Used both by the dispatch methods below and the doc comment on `mirrorFromStore`'s backstop pass
   *  — a single documented helper, never inlined twice (brief hazard (a)). */
  private isMirroredEntry(entry: PendingMutation): boolean {
    return entry.durable === true && !this.pendingMutationCallbacks.has(entry.requestId);
  }

  /** Handle an incoming (already-fan-out'd) broadcast payload — the typed half of `onmessage`. A
   *  payload that doesn't match `OutboxBroadcastMessage` (the legacy bare `1`, or anything else) is
   *  simply not recognized: the accessor nudge already fired in the caller, nothing else happens. */
  private handleOutboxBroadcastMessage(data: unknown): void {
    if (!this.outbox || !isOutboxBroadcastMessage(data)) return;
    if (data.kind === "enqueued") {
      // `mirrorFromStore` is fire-and-forget (never awaited by this synchronous handler) — a
      // rejection (e.g. a fail-stopped `fsOutbox`'s `OutboxClosedError` after a disk error) must
      // route to the SAME observability floor every other durable-outbox write rejection uses,
      // rather than becoming an unhandled promise rejection on every subsequent broadcast (several
      // Node/Electron hosts treat that as fatal by default — see `handleOutboxWriteError`'s doc).
      // Meta-only (no `(clientId, seq)` to attach to): floors straight to the dev-loud console.
      void this.mirrorFromStore().catch((err: unknown) => this.handleOutboxWriteError("mirrorFromStore", undefined, undefined, undefined, err));
    } else {
      this.onCrossTabSettle(data);
    }
  }

  /** Re-read the durable store and reconcile this tab's mirrored set against it — the `enqueued`
   *  broadcast's handler, and the missed-message backstop (spec Part A "Rules"): a mirrored entry
   *  absent from the fresh snapshot (settled/failed elsewhere, whose OWN targeted broadcast this tab
   *  never received) drops via the same `dropAfterBaseline` one-pass rule the verdict-after-baseline
   *  path uses. Serialized on `mirrorInFlight` — a second call arriving mid-read sets `mirrorRerun`
   *  and is folded into one more pass after the current read finishes, rather than racing a second
   *  `loadAll()` against it.
   *
   *  Only STILL-ACTIVE entries (`unsent`/`inflight`/`parked`) are (re-)hydrated — a `failed` (or a
   *  stray `completed`) entry is a terminal, accessor-only record (`pendingMutations()` already
   *  surfaces it) and must never be resurrected as a fresh `unsent` optimistic layer. Without this
   *  guard, a tab that itself once owned a now-terminally-failed entry would keep reviving its OWN
   *  dead record on every subsequent `enqueued` broadcast (this store never dequeues a `failed`
   *  entry — R9 "persists until dismissed/retried") — and, being `durable` with no live callback,
   *  that revived entry would then match `isMirroredEntry`, making the tab react to an UNRELATED
   *  later `settled`/`failed` broadcast that merely happens to name the same `(clientId, seq)`.
   *
   *  Two review-fixed hazards in the reconcile loop below (both stem from the SAME root cause: the
   *  store's presence/absence is not always the authority for a mirrored layer's fate):
   *   - a `completed` mirrored layer (this tab already got a targeted `settled` broadcast and is
   *     holding it gated until ITS OWN feed observes `commitTs`, per `onCrossTabSettle`) is SKIPPED
   *     entirely here, never force-dropped merely because the store record is absent. The leader's
   *     own `drainSettleApplied` dequeues the record right after posting `settled`, and THAT
   *     dequeue's `{kind:"enqueued"}` follow-up broadcast is exactly what drives this backstop pass —
   *     so a `completed` entry being store-absent is the ordinary, expected case, not a missed
   *     message. Force-dropping it here would race ahead of this tab's own gate (a flicker the gate
   *     exists to prevent) — CRITICAL. The same skip also protects THIS tab's own just-acked live
   *     mutation: its `pendingMutationCallbacks` entry is deleted the moment its wire response
   *     settles it (see `isMirroredEntry`'s doc — the callback does NOT survive the whole gated
   *     window, only until the response arrives), so during that gated window it is
   *     indistinguishable from a true mirror to `isMirroredEntry` and would otherwise be dropped by a
   *     totally unrelated tab's `enqueued` broadcast.
   *   - the "is this mirror still active" check now reads from ACTIVE-status (`unsent`/`inflight`/
   *     `parked`) entries only, not "any entry present in the store" — a mirror whose backing record
   *     flipped to `failed` (R9 never dequeues a failure) is present-in-store but no longer active;
   *     treating presence alone as "still live" would leave a permanent phantom optimistic row behind
   *     a missed `failed` broadcast. Such an entry is instead settled failed right here (same effect
   *     as `onCrossTabSettle`'s `failed` branch — mark failed + fire R9), using the terminal verdict
   *     already recorded on the store row itself. */
  private async mirrorFromStore(): Promise<void> {
    if (!this.outbox) return;
    if (this.mirrorInFlight) {
      this.mirrorRerun = true;
      return;
    }
    this.mirrorInFlight = true;
    try {
      do {
        this.mirrorRerun = false;
        const { entries } = await this.outbox.loadAll();
        const activeLive = new Set<string>();
        const byKey = new Map<string, OutboxEntry>();
        for (const e of entries) {
          const key = `${e.clientId}:${e.seq}`;
          byKey.set(key, e);
          if (e.status === "unsent" || e.status === "inflight" || e.status === "parked") {
            activeLive.add(key);
            // idempotent — addHydratedEntry's own (clientId, seq) dedup.
            this.addHydratedEntry(e);
          }
        }
        for (const entry of this.reconciler.entries()) {
          if (!this.isMirroredEntry(entry)) continue; // never touch an own-live entry here.
          if (entry.clientId === undefined || entry.seq === undefined) continue;
          if (entry.status.type === "completed") continue; // gate-owned — see doc above.
          const key = `${entry.clientId}:${entry.seq}`;
          if (activeLive.has(key)) continue; // still active in the store — nothing to reconcile.
          const stored = byKey.get(key);
          if (stored?.status === "failed") {
            this.reconciler.onMutationFailure(entry.requestId);
            this.notifyMutationFailed(entry.clientId, entry.seq, entry.udfPath, stored.error ?? { message: `mutation "${entry.udfPath}" failed` });
          } else {
            this.dropAfterBaseline(entry.requestId); // genuinely absent — the original missed-settle drop.
          }
        }
      } while (this.mirrorRerun);
    } finally {
      this.mirrorInFlight = false;
    }
  }

  /** Handle a targeted `settled`/`failed` broadcast — the leader's flicker-free fast path (Part A's
   *  normal route; `mirrorFromStore`'s backstop above is the fallback for a missed message). Ignored
   *  entirely for an entry this tab doesn't know about, or one it initiated live itself (hazard (a)).
   *  Never touches the durable store — the leader (whichever tab settled it) already wrote that;
   *  this only updates THIS tab's in-memory reconciler layer + R9 observability. */
  private onCrossTabSettle(msg: Extract<OutboxBroadcastMessage, { kind: "settled" | "failed" }>): void {
    const entry = this.findOutboxEntry(msg.clientId, msg.seq);
    if (!entry || !this.isMirroredEntry(entry)) return;
    if (msg.kind === "settled") {
      // The exact same same-session gate `drainSettleApplied`'s fresh-apply branch uses — hold
      // `completed` until THIS tab's own feed observes `commitTs` (flicker-free, never drop-on-ack).
      this.reconciler.onMutationSuccess(entry.requestId, msg.commitTs);
    } else {
      // The terminal-settle shape minus the promise reject — no promise exists for a mirror.
      this.reconciler.onMutationFailure(entry.requestId);
      this.notifyMutationFailed(entry.clientId, entry.seq, entry.udfPath, { message: msg.message, code: msg.code });
    }
  }

  private drainBatchEntry(entry: PendingMutation): MutationBatchEntry {
    return { requestId: entry.requestId, udfPath: entry.udfPath, args: entry.args, clientId: entry.clientId, seq: entry.seq };
  }

  /** applied settlement for a drained unit — resolve the awaiting promise (if any) and dequeue the
   *  durable record ALWAYS; then route the layer drop by `replayed` (T4 review fix — the ungated
   *  fresh-apply drop):
   *   - `replayed: true` — a resend whose commit predates this session's `Connect`, reusing the same
   *     primitive `settleVerdict`'s `applied` case uses (T3's unconditional baseline-gated drop).
   *     Drop-soundness (T3 watch item, scoped to replays ONLY): the drop is gated on baseline
   *     adoption, not on the replay's carried commitTs — the entry's commit necessarily predates this
   *     session's `Connect`, so it predates the baseline's read snapshot and the baseline already
   *     renders the effect. Historical-ts-vs-current-base is therefore still covered; the drop is
   *     flicker-free by the same one-pass rule as T3's handshake.
   *   - a FRESH apply (`replayed` absent/false — this session's OWN first execution, a genuinely new
   *     `ts`) — the argument above does NOT apply: nothing proves this commit predates the baseline,
   *     so an unconditional drop here would remove a still-rendered layer before its authoritative row
   *     ever appears (a flicker). Instead this routes through the normal same-session gate,
   *     `onMutationSuccess` (the response `ts`) — the exact same shipped no-flicker discipline the
   *     direct-send path uses at `MutationResponse` (see the `case "MutationResponse"` handler above):
   *     hold the layer `completed` until this client's own reactive feed observes `ts`.
   *
   *  T-crosstab: AFTER the local settle above, the leader (this tab, if it holds the drain lock)
   *  also posts a targeted `settled` broadcast so a tab MIRRORING this same `(clientId, seq)` gets
   *  the flicker-free fast path instead of waiting for its own next `enqueued`-triggered backstop
   *  read. Posted only when the entry carries a durable `(clientId, seq)` — a plain non-outbox
   *  mutation has nothing for another tab to have mirrored in the first place.
   */
  private drainSettleApplied(requestId: string, value: Value | null, replayed: boolean, ts: number | undefined): void {
    const entry = this.reconciler.getEntry(requestId);
    this.resolvePending(requestId, value);
    if (entry?.clientId !== undefined && entry.seq !== undefined) this.outboxDequeue(entry.clientId, entry.seq);
    if (!entry) return;
    if (replayed) this.dropAfterBaseline(requestId);
    else this.reconciler.onMutationSuccess(requestId, ts);
    if (entry.clientId !== undefined && entry.seq !== undefined) {
      this.outboxBroadcast?.postMessage({ kind: "settled", clientId: entry.clientId, seq: entry.seq, commitTs: ts ?? 0 } satisfies OutboxBroadcastMessage);
    }
  }

  /** Terminal settlement for a drained unit (a coded server verdict, or the identity gate) — reject
   *  the awaiting promise (coded), MARK the durable record `"failed"` (R9: never dequeue a terminal
   *  failure — it persists until dismissed/retried), drop the layer, and (T5) refire `onMutationFailed`
   *  / the dev-loud default when nothing awaited this failure this session. T-crosstab: AFTER all of
   *  the above, also posts a targeted `failed` broadcast (same durability gate as `drainSettleApplied`
   *  above) — a mirroring tab's own `onCrossTabSettle` fires ITS OWN `onMutationFailed`/dev-loud
   *  default; it never double-delivers THIS tab's own notification above. */
  private drainSettleTerminal(requestId: string, code: string | undefined, message: string): void {
    const entry = this.reconciler.getEntry(requestId);
    const hadAwaiter = this.pendingMutationCallbacks.has(requestId);
    this.rejectPending(requestId, this.mutationError(message, code));
    if (entry?.clientId !== undefined && entry.seq !== undefined) this.outboxMarkFailed(entry.clientId, entry.seq, message, code);
    if (entry) this.reconciler.onMutationFailure(requestId);
    if (!hadAwaiter) this.notifyMutationFailed(entry?.clientId, entry?.seq, entry?.udfPath ?? "unknown", { message, code });
    if (entry?.clientId !== undefined && entry.seq !== undefined) {
      this.outboxBroadcast?.postMessage({ kind: "failed", clientId: entry.clientId, seq: entry.seq, code, message } satisfies OutboxBroadcastMessage);
    }
  }

  /* ---------------------------------------------------------------------------------------------
   * T5 — R9 observability: `pendingMutations()`/`usePendingMutations()`, `pendingSummary()`,
   * `onMutationFailed` refire, the dev-mode loud default, and the outbox-change notification bus
   * every durable-mutating operation above funnels through.
   * ------------------------------------------------------------------------------------------- */

  /** A snapshot of the durable outbox — `usePendingMutations()`'s underlying read. `[]` without an
   *  outbox configured (verdict §(d) R9). Each row's `retry()`/`dismiss()` close over the entry as
   *  read HERE (no extra storage round-trip — `retry()` needs `args`/`seed`/`identityFingerprint`,
   *  all captured already). */
  async pendingMutations(): Promise<PendingMutationEntry[]> {
    if (!this.outbox) return [];
    const { entries } = await this.outbox.loadAll();
    return entries.map((e) => this.toPendingMutationEntry(e));
  }

  /** T5 (R9, hazard 2's client half): count + oldest-age advisory over the durable queue — cheap
   *  enough to poll for a "your offline changes may be lost soon" banner ahead of a storage cliff
   *  (Safari's 7-day eviction). `{count: 0, oldestEnqueuedAt: undefined, oldestAgeMs: undefined}`
   *  without an outbox configured, or with an empty one. */
  async pendingSummary(): Promise<PendingSummary> {
    if (!this.outbox) return { count: 0, oldestEnqueuedAt: undefined, oldestAgeMs: undefined };
    const { entries } = await this.outbox.loadAll();
    if (entries.length === 0) return { count: 0, oldestEnqueuedAt: undefined, oldestAgeMs: undefined };
    let oldest = entries[0]!.enqueuedAt;
    for (const e of entries) if (e.enqueuedAt < oldest) oldest = e.enqueuedAt;
    return { count: entries.length, oldestEnqueuedAt: oldest, oldestAgeMs: Date.now() - oldest };
  }

  private toPendingMutationEntry(e: OutboxEntry): PendingMutationEntry {
    return {
      clientId: e.clientId,
      seq: e.seq,
      udfPath: e.udfPath,
      status: e.status,
      enqueuedAt: e.enqueuedAt,
      error: e.error,
      retry: () => this.retryOutboxEntry(e),
      dismiss: () => this.dismissOutboxEntry(e),
    };
  }

  /** `entry.retry()` (R9): a FAILED entry only — everything else is a harmless no-op (verdict §(b):
   *  "never reuse a seq for a new attempt"). Dequeues the OLD (failed-verdict) durable record and
   *  builds a brand-new `PendingMutation` — fresh requestId/seq/order, the CURRENT session's identity
   *  fingerprint (a fair shot even if identity rotated since the original failure), reconstructed
   *  exactly like a hydrated entry (same udfPath/args/seed; the registry is consulted — there is no
   *  live call-site closure for a retry either). No live promise is registered: like a hydrated
   *  entry, its eventual outcome surfaces via `usePendingMutations()`/`onMutationFailed`, never a
   *  returned `Promise<Value>` (the durable record outlives any promise). */
  private async retryOutboxEntry(e: OutboxEntry): Promise<void> {
    if (!this.outbox || e.status !== "failed" || this.outboxClientId === undefined) return;
    const requestId = String(this.nextRequestId++);
    const entry: PendingMutation = {
      requestId,
      udfPath: e.udfPath,
      args: e.args,
      seed: e.seed,
      touched: new Set(),
      status: { type: "unsent" },
      clientId: this.outboxClientId,
      seq: this.outboxNextSeq++,
      order: this.nextOutboxOrder(),
      identityFingerprint: this.outboxFingerprint,
      enqueuedAt: Date.now(),
      durable: false,
      update: this.lookupHydratedUpdate(e.udfPath),
    };
    this.reconciler.addHydrated(entry);
    this.outboxAppend(entry);
    this.outboxDequeue(e.clientId, e.seq);
    this.outboxDrain?.nudge();
  }

  /** `entry.dismiss()` (R9): a FAILED entry only — permanently forget it without retrying. */
  private async dismissOutboxEntry(e: OutboxEntry): Promise<void> {
    if (!this.outbox || e.status !== "failed") return;
    this.outboxDequeue(e.clientId, e.seq);
  }

  /** T5 (R9): subscribe to "the durable outbox changed" — `usePendingMutations()`'s re-read trigger.
   *  Fires on every local outbox-mutating op AND on an incoming cross-tab `outboxBroadcast` message. */
  onOutboxChange(listener: () => void): () => void {
    this.outboxChangeListeners.add(listener);
    return () => this.outboxChangeListeners.delete(listener);
  }

  private notifyOutboxChange(): void {
    for (const l of this.outboxChangeListeners) l();
    // T-crosstab: was the payload-irrelevant bare `1` ("the message IS the nudge"); now additively
    // typed as `{kind: "enqueued"}` — every OTHER tab's receiver re-reads `loadAll()` and reconciles
    // its mirrored set against it (both the live-render path and the missed-message backstop).
    this.outboxBroadcast?.postMessage({ kind: "enqueued" } satisfies OutboxBroadcastMessage);
  }

  /** Every durable-mutating outbox call site funnels through these four wrappers (instead of a bare
   *  `this.outbox?.xxx(...)`) so `notifyOutboxChange()` — and a rejection's route through
   *  `handleOutboxWriteError` — is never missed at a new call site. */
  private outboxAppend(entry: PendingMutation): void {
    if (!this.outbox) return;
    void this.outbox
      .append(this.toOutboxEntry(entry))
      .then(() => {
        entry.durable = true; // write-behind confirmed — mirrors `mutation()`'s own append `.then()`.
        this.outboxDrain?.nudge();
        this.notifyOutboxChange();
      })
      .catch((err: unknown) => this.handleOutboxWriteError("append", entry.clientId, entry.seq, entry.udfPath, err));
  }

  private outboxDequeue(clientId: string, seq: number): void {
    if (!this.outbox) return;
    void this.outbox
      .dequeue(clientId, seq)
      .then(() => this.notifyOutboxChange())
      .catch((err: unknown) => this.handleOutboxWriteError("dequeue", clientId, seq, undefined, err));
  }

  private outboxUpdateStatus(clientId: string, seq: number, status: OutboxEntryStatus): void {
    if (!this.outbox) return;
    void this.outbox
      .updateStatus(clientId, seq, status)
      .then(() => this.notifyOutboxChange())
      .catch((err: unknown) => this.handleOutboxWriteError("updateStatus", clientId, seq, undefined, err));
  }

  /** Record a terminal failure DURABLY (`status: "failed"` + the error) instead of dequeuing — R9:
   *  "failed entries persist until dismissed/retried". */
  private outboxMarkFailed(clientId: string, seq: number, message: string, code: string | undefined): void {
    if (!this.outbox) return;
    void this.outbox
      .updateStatus(clientId, seq, "failed", { message, code })
      .then(() => this.notifyOutboxChange())
      .catch((err: unknown) => this.handleOutboxWriteError("updateStatus", clientId, seq, undefined, err));
  }

  /** Routes a rejected fire-and-forget durable-outbox write (append/updateStatus/dequeue/setMeta —
   *  never awaited by its caller, per the write-behind contract) to observability instead of letting
   *  it become an unhandled promise rejection, which several Node/Electron hosts treat as fatal by
   *  default (a `fsOutbox` that has fail-stopped after a disk error rejects EVERY subsequent op —
   *  see `outbox-fs.ts`'s `OutboxClosedError`). When the write carries a `(clientId, seq)` — every
   *  case except a meta-only write — it routes through the SAME R9 channel as any other terminal
   *  mutation failure (`onMutationFailed`, or `notifyMutationFailed`'s own dev-mode loud
   *  `console.error` default). With no such record to attach the failure to (a meta write), a
   *  dev-loud `console.error` is the floor — NEVER swallowed silently either way. */
  private handleOutboxWriteError(op: string, clientId: string | undefined, seq: number | undefined, udfPath: string | undefined, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
    if (clientId !== undefined && seq !== undefined) {
      this.notifyMutationFailed(clientId, seq, udfPath ?? "unknown", { message: `durable outbox ${op} failed: ${message}`, code });
    } else if (isDevMode()) {
      console.error(`[stackbase] durable outbox ${op} failed (clientId=${clientId ?? "unknown"}):`, err);
    }
  }

  /** T5 (R9): fire `onMutationFailed` for a terminal durable failure with NO live promise awaiter
   *  this session (`hadAwaiter` already checked by every call site) — or, absent a registered
   *  handler, the dev-mode loud `console.error` default (spec-review: "the five-line courtesy" no
   *  position shipped). A no-op for a non-outbox-tracked entry (`clientId`/`seq` undefined) — R9 is
   *  entirely a durable-outbox concern. */
  private notifyMutationFailed(clientId: string | undefined, seq: number | undefined, udfPath: string, error: OutboxEntryError): void {
    if (clientId === undefined || seq === undefined) return;
    if (this.onMutationFailedCallback) {
      this.onMutationFailedCallback({ clientId, seq, udfPath, error });
    } else if (isDevMode()) {
      console.error(
        `[stackbase] outbox: mutation "${udfPath}" (clientId=${clientId}, seq=${seq}) failed terminally` +
          `${error.code ? ` (${error.code})` : ""} with no onMutationFailed handler registered: ${error.message}`,
      );
    }
  }

  /** R9 "resume" refire (constructor-only, verdict §(d) Observability: "`onMutationFailed` refires
   *  from durable records on resume"): a fresh `StackbaseClient` instance has made zero `mutation()`
   *  calls yet, so EVERY already-`"failed"` durable record found here is trivially "no live awaiter" —
   *  Lunora's `hadAwaiter` check is unconditionally false at this point, no gating needed. */
  private async refireDurableFailures(): Promise<void> {
    if (!this.outbox) return;
    const { entries } = await this.outbox.loadAll();
    for (const e of entries) {
      if (e.status === "failed") {
        this.notifyMutationFailed(e.clientId, e.seq, e.udfPath, e.error ?? { message: `mutation "${e.udfPath}" failed` });
      }
    }
  }
}
