/**
 * S3 — the reconcile chokepoint. EVERY state change flows through this one object: mutation
 * initiation, server ingest (Transition), mutation resolution (success/failure), the gate-timeout
 * valve, and transport close. It is the sole place optimistic layers are applied, dropped, or
 * replayed. The gate predicate is isolated behind `versionCoversCommit` so the sharded-frontier
 * future (lmid-shape identity confirmation, verdict §(g)) changes one predicate, not the reconciler.
 *
 * The reconciler owns the `MutationLog` (S1), the `maxObservedTs` frontier, and the per-entry gate
 * timers; it drives the `LayeredQueryStore` (S2) and consults the `DeliveryPolicy` (S4) at close.
 * It does NOT own promise callbacks or the transport — the client resolves/rejects promises and
 * decides send-vs-unsent, calling into the reconciler for all layer bookkeeping.
 */
import { jsonToConvex } from "@helipod/values";
import type { StateModification } from "@helipod/sync";
import type { LayeredQueryStore, OptimisticStoreView } from "./layered-store";
import { MutationLog, type PendingMutation } from "./mutation-log";
import { closeDisposition } from "./delivery-policy";
import { createOptimisticLocalStore } from "./optimistic-store";

/**
 * The gate predicate (v1). A `completed` layer is safe to drop once this client's own reactive feed
 * has observed a ts at or beyond the mutation's commit — "drop on observed inclusion, never on the
 * ack alone". Guarded `commitTs > 0` so a leaked `0`/absent commitTs can never falsely gate.
 */
export function versionCoversCommit(maxObservedTs: number, commitTs: number): boolean {
  return commitTs <= maxObservedTs && commitTs > 0;
}

/** Result of a `MutationResponse` — the client already resolved the promise; this handles the layer. */
export interface CloseResult {
  /** `inflight` request ids whose promises the client must reject with `MutationUndeliveredError`. */
  rejectedInflight: string[];
  /** `inflight` request ids that PARKED instead (Task 2's S4 swap, armed + durable) — their
   *  promise stays pending; the client must NOT reject (or resolve) them here. */
  parked: string[];
}

const DEFAULT_GATE_TIMEOUT_MS = 10_000;

export class Reconciler {
  readonly log = new MutationLog();
  private observedTs = 0;
  private readonly gateTimeoutMs: number;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** DLR Stage 2a — invoked when a `QueryDiff`'s client-recomputed drift checksum diverges from the
   *  server's. The client wires this to a scoped resync (`client.ts` passes `() => this.resync()`).
   *  For by-id the diff is trivially correct so this should never fire in normal operation; it is the
   *  safety net that 2b's harder differ inherits already proven. */
  private readonly onDrift?: (queryId: number) => void;

  constructor(
    private readonly store: LayeredQueryStore,
    opts: { gateTimeoutMs?: number; onDrift?: (queryId: number) => void } = {},
  ) {
    this.gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    this.onDrift = opts.onDrift;
  }

  /** Max `endVersion.ts` observed this session (reset on close). Exposed for tests. */
  get maxObservedTs(): number {
    return this.observedTs;
  }

  entries(): PendingMutation[] {
    return this.log.entriesInOrder();
  }

  /** T6: `unsent` entries in FIFO (requestId/insertion) order — flushed on transport reopen. */
  unsentInOrder(): PendingMutation[] {
    return this.log.entriesInOrder().filter((e) => e.status.type === "unsent");
  }

  /** T3: the log entry for `requestId` (or `undefined`). Lets `client.ts` read an outbox entry's
   *  recorded `(clientId, seq)` for dequeue-on-success BEFORE a settling event removes it from the
   *  log. Read-only — all mutation still flows through the events below. */
  getEntry(requestId: string): PendingMutation | undefined {
    return this.log.get(requestId);
  }

  /**
   * The drop-on-verdict-after-baseline rule (T3, verdict §(d) "Reload and rendering — the fork,
   * decided"). A CROSS-SESSION entry whose recorded verdict is `applied` (learned via the `Connect`
   * handshake's `ConnectAck` or a drain replay-ack) drops its optimistic layer once the reconnect
   * baseline Transition has been ADOPTED. Sound because the entry's commit necessarily predates
   * this session's `Connect`, hence predates the baseline's read snapshot — so the baseline already
   * renders the effect; removing the (registry-rebuilt, T5) layer in the SAME one-pass `rebuild()`
   * is flicker-free (the authoritative rows are already in the base, so the composed view never
   * blinks the row away). The rule is deliberately **layer-agnostic**: the entry may hold no layer
   * at all — a parked entry (its `update` was cleared at close), a plain non-optimistic mutation,
   * or (until T5 ships the registry) any hydrated entry — in which case this is a clean removal.
   *
   * The CALLER (`client.ts`) is responsible for gating the call on baseline adoption; this method
   * assumes that gate has already passed. `versionCoversCommit` (the same-session gate predicate)
   * is intentionally untouched — same-session entries still drop on observed inclusion, never here.
   */
  onVerdictAfterBaseline(requestId: string): void {
    if (!this.log.get(requestId)) return;
    this.log.delete(requestId);
    this.clearTimer(requestId);
    this.rebuild();
  }

  /**
   * T5: add a HYDRATED (cross-reload) durable entry to the log — `client.ts#addHydratedEntry`'s
   * counterpart to `initiate()` for a live call-site mutation. `entry.update` may already be set
   * (a registry hit — `client.ts` looks it up BEFORE calling this). Unlike `initiate()`, where the
   * OWN entry's throw is rethrown synchronously to the `mutation()` caller, a REGISTERED updater
   * that throws here is ordinary replay-drop collateral — warned and dropped via the normal
   * `rebuild()` path, never rethrown (there is no synchronous caller on the hydrate path to
   * propagate to; the entry still drains fine, only its rendering is lost). An entry with no
   * `update` (no registry hit, or the registry simply wasn't configured) is added without a
   * recompose pass at all — a plain layerless entry, exactly T4's pre-registry behavior.
   */
  addHydrated(entry: PendingMutation): void {
    this.log.add(entry);
    if (entry.update) this.rebuild();
  }

  private invokeUpdate = (entry: PendingMutation, view: OptimisticStoreView): void => {
    // T5: enrich the raw view into the typed OptimisticLocalStore (placeholderId()/now()/dev-freeze,
    // derived from `entry.seed`) before invoking. `entry.update`'s declared param type is the
    // internal `OptimisticStoreView` (a subset of `OptimisticLocalStore`'s surface); a real
    // `PendingMutation.update` created via `useMutation(...).withOptimisticUpdate(...)` is actually
    // typed against `OptimisticLocalStore` and cast down at that boundary (react.tsx) — this is the
    // runtime guarantee that makes that cast sound: every invocation, from every entry point,
    // always receives the fully-enriched store.
    const store = createOptimisticLocalStore(view, entry.seed);
    entry.update!(store, jsonToConvex(entry.args));
  };

  /** Rebuild composed values; drop + warn any entry whose updater threw during replay.
   *  `forceNotify` (subscription resume) forwards straight to `store.recompose` — see its doc. */
  private rebuild(forceNotify?: ReadonlySet<string>): void {
    const dropped = this.store.recompose(this.log.entriesInOrder(), this.invokeUpdate, forceNotify);
    for (const d of dropped) {
      const path = this.log.get(d.requestId)?.udfPath ?? d.requestId;
      this.log.delete(d.requestId);
      this.clearTimer(d.requestId);
      console.warn(`[helipod] optimistic update for "${path}" threw during replay; dropping its pending layer`, d.error);
    }
  }

  /**
   * Event 1 — mutation initiation. Add the entry, replay all surviving updates over the current
   * base. If THIS entry's updater throws, it is removed and the error rethrown **synchronously** so
   * the caller sends nothing (a prior entry throwing is contained + warned, not rethrown).
   */
  initiate(entry: PendingMutation): void {
    this.log.add(entry);
    if (!entry.update) return; // plain mutation — no layer to build
    const dropped = this.store.recompose(this.log.entriesInOrder(), this.invokeUpdate);
    let ownError: { error: unknown } | undefined;
    for (const d of dropped) {
      this.log.delete(d.requestId);
      this.clearTimer(d.requestId);
      if (d.requestId === entry.requestId) {
        ownError = { error: d.error };
      } else {
        const path = this.log.get(d.requestId)?.udfPath ?? d.requestId;
        console.warn(`[helipod] optimistic update for "${path}" threw during replay; dropping its pending layer`, d.error);
      }
    }
    if (ownError) throw ownError.error;
  }

  /**
   * Event 2 — a contiguous (or resync-adopted) Transition, applied as ONE synchronous pass:
   * advance the frontier, apply modifications to the base, drop every gated `completed` layer, then
   * rebuild composed. The frame where a layer disappears is the same frame its authoritative rows
   * appear — the no-flicker guarantee. An empty (`modifications: []`) ts-advancing Transition (T2)
   * flows through here with zero special-casing: the loop simply does no base writes.
   */
  ingestTransition(modifications: StateModification[], endTs: number): void {
    this.observedTs = Math.max(this.observedTs, endTs);
    // Subscription resume: `hash`es of subs answered via `QueryUnchanged` this pass — forwarded to
    // `rebuild`/`recompose` so they still fire listeners despite no reference change (see
    // `LayeredQueryStore.recompose`'s `forceNotify` doc).
    let unchanged: Set<string> | undefined;
    for (const mod of modifications) {
      if (mod.type === "QueryUpdated") {
        const sub = this.store.byId.get(mod.queryId);
        if (sub) this.store.setServerValue(sub, jsonToConvex(mod.value), mod.hash);
      } else if (mod.type === "QueryFailed") {
        const sub = this.store.byId.get(mod.queryId);
        if (sub) {
          this.store.markAnswered(sub);
          console.error(`[helipod] query "${sub.path}" failed: ${mod.error}`);
          for (const l of sub.listeners) l.onError?.(mod.error);
        }
      } else if (mod.type === "QueryUnchanged") {
        const sub = this.store.byId.get(mod.queryId);
        if (sub) {
          this.store.markUnchanged(sub);
          (unchanged ??= new Set()).add(sub.hash);
        }
      } else if (mod.type === "QueryDiff") {
        // DLR Stage 2a/2b: a DIFFABLE (by-id or range) sub's answer — a reset (initial subscribe, or
        // a resync) or an incremental diff. `applyDiff` mutates the sub's row-map and re-derives
        // `serverValue` (a fresh reference, so the `rebuild` below fires listeners) per `mod.reset`'s
        // mode (by-id sole-row vs. range sorted array); a checksum mismatch triggers a scoped resync.
        const sub = this.store.byId.get(mod.queryId);
        if (sub) {
          // UNINITIALIZED-RENDER-MODE GUARD (DLR 2b Task 10 residual): an INCREMENTAL diff
          // (`mod.reset === undefined`) arriving for a sub that was already ANSWERED by something
          // OTHER than a reset (`sub.answered` true, but `sub.renderMode` never established) is
          // treated exactly like a checksum-drift resync, WITHOUT calling `applyDiff` at all — so
          // `serverValue`/`diffRows` are left untouched rather than silently mis-rendered (e.g. a
          // range sub falling back to `applyDiff`'s by-id single-row default). This is reachable even
          // though the server only ever emits an incremental diff for an already-registered
          // subscription: a `QueryUnchanged` RESUME answer (Task 10) seeds the SERVER's own row-map
          // (ready to diff going forward) without teaching the CLIENT anything about render shape —
          // and a client whose retained cross-session baseline for this query predates diff-
          // capability entirely (its subscribe was answered `QueryUpdated` in an earlier session,
          // before this connection ever advertised `supportsQueryDiff`) has no `renderMode` to resume
          // from. Checked BEFORE `sub.answered` gets read anywhere else this pass (see below), and
          // gated on `sub.answered`'s PRE-diff value so a genuinely fresh, never-yet-answered sub
          // (this subscription's first-ever reply) is unaffected — that can only be a real reset
          // (`mod.reset` defined) on the actual wire, so this branch never fires for it regardless.
          if (mod.reset === undefined && sub.renderMode === undefined && sub.answered) {
            console.error(`[helipod] query "${sub.path}" incremental diff arrived with no established render mode; resyncing`);
            sub.lastHash = undefined;
            this.onDrift?.(mod.queryId);
          } else {
            const { drift } = this.store.applyDiff(sub, mod.changes, mod.checksum, mod.reset);
            // DLR 2b Task 10 — resume fingerprint ownership: a RESET carries the server's `hashValue`
            // fingerprint of the fresh baseline (same contract `QueryUpdated.hash` already has) —
            // store it so a later resubscribe can echo it back for a `QueryUnchanged` resume. An
            // INCREMENTAL diff (`mod.reset === undefined`) has no such fingerprint (the server never
            // computes one for a single write's delta) and, more importantly, the value just CHANGED
            // — any hash on file is now stale, so it must be cleared rather than left dangling.
            // Echoing nothing on the next resubscribe safely forces a full reset; echoing a stale
            // hash could never happen here (undefined never matches), but clearing it is the honest,
            // cheap-to-reason-about invariant.
            sub.lastHash = mod.reset !== undefined ? mod.hash : undefined;
            if (drift) {
              console.error(`[helipod] query "${sub.path}" diff checksum mismatch; resyncing`);
              this.onDrift?.(mod.queryId);
            }
          }
        }
      }
      // QueryRemoved: keep the last known base.
    }
    for (const entry of this.log.entriesInOrder()) {
      if (entry.status.type === "completed" && versionCoversCommit(this.observedTs, entry.status.commitTs)) {
        this.log.delete(entry.requestId);
        this.clearTimer(entry.requestId);
      }
    }
    this.rebuild(unchanged);
  }

  /**
   * Event 3 — `MutationResponse` success carrying `ts` (W1). The client already resolved the
   * promise (D3). Here: drop now if there is nothing to protect (no updater / nothing touched), or
   * the gate is already covered, or `ts` is missing/≤0 (accept one-frame flicker over a wedge —
   * the server-side `commitTs > 0` assertion makes this unreachable); otherwise hold the layer as
   * `completed` and arm the gate timer.
   */
  onMutationSuccess(requestId: string, ts: number | undefined): void {
    const entry = this.log.get(requestId);
    if (!entry) return; // already dropped (e.g. replay-throw) — promise handled by the client
    if (!entry.update || entry.touched.size === 0) {
      this.log.delete(requestId);
      return; // nothing rendered — no rebuild needed
    }
    if (ts === undefined || ts <= 0) {
      console.warn(`[helipod] mutation "${entry.udfPath}" acked with no usable commitTs (ts=${ts}); dropping its layer now`);
      this.log.delete(requestId);
      this.rebuild();
      return;
    }
    if (versionCoversCommit(this.observedTs, ts)) {
      this.log.delete(requestId);
      this.rebuild();
      return;
    }
    entry.status = { type: "completed", commitTs: ts, completedAt: Date.now() };
    this.armGateTimer(requestId);
  }

  /** Event 4 — `MutationResponse` failure. The client rejected the promise; drop the layer + rebuild. */
  onMutationFailure(requestId: string): void {
    if (!this.log.get(requestId)) return;
    this.log.delete(requestId);
    this.clearTimer(requestId);
    this.rebuild();
  }

  /**
   * Event 6 — transport close (S4). `unsent` retained; `inflight`/`completed` layers drop; the
   * frontier resets; composed rebuilds over the retained set. Returns the `inflight` ids the client
   * must reject with `MutationUndeliveredError`. NO layer crosses a session.
   *
   * Task 2 extends this with the S4 park swap: when `armed` (a `ConnectAck` has proven server-side
   * dedup — T3 sets it via `client.ts#setOutboxArmed`) AND an `inflight` entry's durable append has
   * already committed (`entry.durable`), it PARKS instead of rejecting — its `status` flips to
   * `"parked"` and its `update` closure is cleared (the layer still drops, via the normal
   * `rebuild()` below: `recompose` skips any entry with no `update`, the same mechanism a plain
   * non-optimistic mutation already relies on) but the entry itself STAYS in the log, ready for a
   * future drain (T4) to resend under its recorded `(clientId, seq)`. Every other `drop`ped id
   * (rejected-inflight, completed) is still fully removed from the log, exactly as before.
   */
  closeSession(armed = false): CloseResult {
    const disp = closeDisposition(this.log.entriesInOrder(), { armed });
    const parkedIds = new Set(disp.park);
    for (const rid of disp.park) {
      const entry = this.log.get(rid);
      if (entry) {
        entry.status = { type: "parked" };
        entry.update = undefined; // layer drops — unchanged rule (verdict §(d)); entry itself stays
      }
    }
    for (const rid of disp.drop) {
      if (parkedIds.has(rid)) continue; // parked entries are NOT removed from the log
      this.log.delete(rid);
      this.clearTimer(rid);
    }
    this.observedTs = 0; // reset with the session — the ts-gate is only sound over one monotone feed
    this.rebuild();
    return { rejectedInflight: disp.reject, parked: disp.park };
  }

  private armGateTimer(requestId: string): void {
    this.clearTimer(requestId);
    // Event 5 — the gate-timeout valve: no wrong guess and no lost frame can wedge a layer forever.
    const timer = setTimeout(() => {
      this.timers.delete(requestId);
      const entry = this.log.get(requestId);
      if (!entry || entry.status.type !== "completed") return;
      console.warn(`[helipod] mutation "${entry.udfPath}" layer not confirmed within ${this.gateTimeoutMs}ms; dropping it`);
      this.log.delete(requestId);
      this.rebuild();
    }, this.gateTimeoutMs);
    // Don't keep the process alive for a pending gate timer (Node).
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(requestId, timer);
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(requestId);
    }
  }
}
