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
import { versionsEqual, INITIAL_VERSION, type ServerMessage, type StateVersion } from "@stackbase/sync";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import { getFunctionPath, type AnyFunctionRef, type FunctionReference } from "./api";
import type { AnyFunctionReference, FunctionArgs, FunctionReturnType } from "./function-types";
import type { ClientTransport } from "./transport";
import { LayeredQueryStore, queryHash, type Listener, type OptimisticUpdate, type QueryErrorListener, type QueryListener } from "./layered-store";
import { Reconciler } from "./reconcile";
import { MutationUndeliveredError } from "./delivery-policy";
import type { PendingMutation } from "./mutation-log";
import type { OptimisticLocalStore } from "./optimistic-store";

export type { QueryListener, QueryErrorListener };

let entropyCounter = 0;
function makeEntropy(): string {
  return `${Date.now().toString(36)}-${(entropyCounter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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

  constructor(transport: ClientTransport, opts: { gateTimeoutMs?: number } = {}) {
    this.transport = transport;
    this.reconciler = new Reconciler(this.store, { gateTimeoutMs: opts.gateTimeoutMs });
    this.disposeTransport = transport.onMessage((msg) => this.onServerMessage(msg));
    this.disposeClose = transport.onClose(() => this.onTransportClosed());
    this.disposeReopen = transport.onReopen?.(() => this.onTransportReopened());
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
    const requestId = String(this.nextRequestId++);
    const path = getFunctionPath(ref);
    const argsJson = convexToJson(args as Value);
    const entry: PendingMutation = {
      requestId,
      udfPath: path,
      args: argsJson,
      update: opts.optimisticUpdate,
      seed: { entropy: makeEntropy(), now: Date.now() },
      touched: new Set(),
      status: { type: "unsent" },
    };
    // Event 1 — apply at initiation. A throwing updater rethrows here, synchronously, before any
    // promise is created or anything is sent.
    this.reconciler.initiate(entry);

    return new Promise<Value>((resolve, reject) => {
      this.pendingMutations.set(requestId, { resolve, reject });
      if (this.closed) {
        // Offline: retain as `unsent` for a reconnect flush (T6). The promise stays pending.
        entry.status = { type: "unsent" };
      } else {
        entry.status = { type: "inflight" };
        this.transport.send({ type: "Mutation", requestId, udfPath: path, args: argsJson });
      }
    });
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
    // S4 close rules: unsent retained; inflight/completed layers drop; frontier resets.
    const { rejectedInflight } = this.reconciler.closeSession();
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
      this.transport.send({ type: "Mutation", requestId: entry.requestId, udfPath: entry.udfPath, args: entry.args });
    }
  }
}
