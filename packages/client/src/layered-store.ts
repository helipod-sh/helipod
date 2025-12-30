/**
 * S2 — the `LayeredQueryStore`. It splits what was a single `value` slot per subscription into a
 * **`serverValue`** (written only by server ingest) and a **`composedValue`** (= ordered replay of
 * the surviving optimistic updates over that base — what listeners and the cached first delivery
 * see). Change detection is by **reference inequality**, exactly as convex-js does.
 *
 * The **byte-identity invariant** (the no-re-render binding): when NO surviving update touches a
 * query, its `composedValue` must be the *same reference* as its `serverValue`, not merely
 * deep-equal — so a client with zero optimistic updates behaves reference-for-reference like the
 * pre-slice client and triggers no extra renders.
 *
 * `recompose` is the sole place composed values are (re)built. It is transactional per-updater:
 * an updater that throws mid-run contributes NOTHING (its buffered writes are discarded) and is
 * reported for the caller to drop — a mid-rebuild throw never leaves the composed store half-built.
 */
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import { applyChanges, driftChecksum, type Change, type RowVersion } from "@stackbase/sync";
import { getFunctionPath, type FunctionReference } from "./api";
import type { PendingMutation } from "./mutation-log";

/** The query identity hash — `path + ":" + JSON.stringify(argsJson)` (the existing `client.ts` hash). */
export function queryHash(path: string, argsJson: JSONValue): string {
  return `${path}:${JSON.stringify(argsJson)}`;
}

/**
 * DLR Stage 2a — render a by-id DIFFABLE query's value from its keyed row-map: the sole (0-or-1)
 * entry's row decoded to a `Value`, or `undefined` when the map is empty (a `db.get(id)` returning
 * `null` renders as no value, exactly as the RERUN path does today). `jsonToConvex` mints a fresh
 * object every call, so each apply yields a distinct-by-reference value — the identity `recompose`
 * needs to fire listeners.
 */
function renderByIdValue(rows: Map<string, RowVersion>): Value | undefined {
  for (const rv of rows.values()) return jsonToConvex(rv.row) as Value; // first (and only) entry
  return undefined;
}

/**
 * The writeable view of composed state an optimistic updater receives. Reads see the composed
 * state as built so far (prior layers + this updater's own writes); writes stack on top.
 *
 * T5 layers the *public typed* `OptimisticLocalStore` (with `placeholderId(table)`/`now()` derived
 * from the entry `seed`, and dev-mode `Object.freeze` on `getQuery` results) on top of this
 * internal contract — this slice implements the read/write view; those three are additive.
 */
export interface OptimisticStoreView {
  getQuery(ref: FunctionReference | string, args?: Record<string, Value>): Value | undefined;
  setQuery(ref: FunctionReference | string, args: Record<string, Value>, value: Value | undefined): void;
  getAllQueries(ref: FunctionReference | string): Array<{ args: Record<string, Value>; value: Value | undefined }>;
}

/** The optimistic update closure. `store` is a writeable composed view; `args` is the mutation's args. */
export type OptimisticUpdate = (store: OptimisticStoreView, args: Value) => void;

export type QueryListener = (value: Value) => void;
/** Fires when a subscribed query throws server-side (its handler errored). */
export type QueryErrorListener = (error: string) => void;

export interface Listener {
  onUpdate: QueryListener;
  onError?: QueryErrorListener;
}

export interface Subscription {
  queryId: number;
  path: string;
  args: JSONValue;
  hash: string;
  /** The authoritative base — written only by server ingest. */
  serverValue: Value | undefined;
  /** `serverValue` with surviving optimistic updates replayed on top (=== `serverValue` when none). */
  composedValue: Value | undefined;
  /** Has this subscription received ITS FIRST server reply yet — either outcome, `QueryUpdated` OR
   *  `QueryFailed`. Distinct from `serverValue !== undefined`: a `QueryFailed` answer never sets
   *  `serverValue` (there is no base to render), but it IS a delivered reply — nothing further is
   *  coming for it on a quiet deployment. `hasUndeliveredSubscription()` (client.ts) keys off this,
   *  not `serverValue`, so a failed-but-answered subscription doesn't wedge the outbox drain's
   *  baseline await waiting for a Transition that will never arrive (re-review FIX 2).
   *  `QueryUnchanged` (subscription resume) also sets this — it IS a delivered reply too, see
   *  `markUnchanged`. */
  answered: boolean;
  /** Subscription resume (2025-11-28): the server-minted fingerprint of `serverValue` — a
   *  `"sha256:" + hex` string stored verbatim from the most recent `QueryUpdated.hash`. Echoed
   *  back as `resultHash` on resubscribe (`client.ts#resync`) so the server can reply
   *  `QueryUnchanged` instead of resending the full value. A hash-less `QueryUpdated` (old server,
   *  or wire-compat hand-construction) CLEARS this — an old-server session must never echo a stale
   *  hash. Distinct from the query-identity `hash` field above (`path + args` — never changes for
   *  a given subscription); this one is a RESULT fingerprint that changes every time the value does.
   */
  lastHash?: string;
  /** DLR Stage 2a — the by-id materialized cache. For a DIFFABLE query the authoritative base is
   *  this keyed row-map (`docId -> {row, ts}`); `serverValue` is re-DERIVED from it on every
   *  `applyDiff` (for by-id: the sole entry's row, or `undefined` when empty). Absent for a RERUN
   *  query (`serverValue` is set directly by `setServerValue`). Held per-subscription so the client
   *  can compute the drift checksum and apply incremental `QueryDiff`s over the running map. */
  diffRows?: Map<string, RowVersion>;
  listeners: Set<Listener>;
}

/** An updater that threw during replay — the caller drops the entry and warns. */
export interface ReplayDrop {
  requestId: string;
  error: unknown;
}

export class LayeredQueryStore {
  readonly byHash = new Map<string, Subscription>();
  readonly byId = new Map<number, Subscription>();

  create(queryId: number, path: string, args: JSONValue, hash: string): Subscription {
    const sub: Subscription = {
      queryId,
      path,
      args,
      hash,
      serverValue: undefined,
      composedValue: undefined,
      answered: false,
      lastHash: undefined,
      listeners: new Set(),
    };
    this.byHash.set(hash, sub);
    this.byId.set(queryId, sub);
    return sub;
  }

  remove(hash: string): void {
    const sub = this.byHash.get(hash);
    if (!sub) return;
    this.byHash.delete(hash);
    this.byId.delete(sub.queryId);
  }

  /** Set a subscription's authoritative base (from a `QueryUpdated` modification). Does NOT fire —
   *  `recompose` owns all listener firing so the base+drop+rebuild happen as one atomic frame.
   *  `hash` is the server-minted result fingerprint carried on the same modification — stored
   *  verbatim (undefined clears `lastHash`, e.g. an old server that never sends `hash`). */
  setServerValue(sub: Subscription, value: Value | undefined, hash?: string): void {
    sub.serverValue = value;
    sub.lastHash = hash;
    sub.answered = true;
  }

  /** Mark a subscription as having received its first reply WITHOUT a base value (from a
   *  `QueryFailed` modification — there is no server row to render, only an error). See the
   *  `answered` field doc for why this is distinct from `setServerValue`. */
  markAnswered(sub: Subscription): void {
    sub.answered = true;
  }

  /** Ingest a `QueryUnchanged` modification (subscription resume, design 2025-11-28): the fresh
   *  server-side re-run's hash matched what this session echoed, so there is no new value on the
   *  wire — `serverValue`/`lastHash`/`composedValue` all stay exactly as they were. It still counts
   *  as a delivered reply (`answered = true`, same as `setServerValue`/`markAnswered`) — see the
   *  `answered` field doc. The caller (`reconcile.ts`) is responsible for passing this sub's `hash`
   *  into `recompose`'s `forceNotify` set — see that method's doc for why a `QueryUnchanged` must
   *  still fire listeners to introduce no new observable difference for app code. */
  markUnchanged(sub: Subscription): void {
    sub.answered = true;
  }

  /**
   * DLR Stage 2a — apply a `QueryDiff`'s changes to a DIFFABLE query's keyed row-map, re-derive the
   * rendered `serverValue` as a FRESH reference (so `recompose`'s reference-inequality check fires
   * listeners), and report whether the client-recomputed drift checksum diverged from the server's.
   * The caller (the reconciler) triggers a scoped resync on `drift === true`.
   *
   * A reset (the initial subscribe answer) is just add-all over an empty map; an incremental diff
   * mutates the running map. `applyChanges` is copy-on-write, so `diffRows` becomes a new Map each
   * apply — the client never mutates a map a listener may still hold. `lastHash` is cleared: the diff
   * path renders from the row-map, not the resume fingerprint, so a stale hash must never be echoed.
   */
  applyDiff(sub: Subscription, changes: readonly Change[], checksum: string): { drift: boolean } {
    const next = applyChanges(sub.diffRows ?? new Map<string, RowVersion>(), changes);
    sub.diffRows = next;
    sub.serverValue = renderByIdValue(next);
    sub.lastHash = undefined;
    sub.answered = true;
    return { drift: driftChecksum(next) !== checksum };
  }

  private serverValueOf(hash: string): Value | undefined {
    return this.byHash.get(hash)?.serverValue;
  }

  /**
   * Rebuild every subscription's `composedValue` = replay the surviving updates (in `requestId`
   * order) over the current `serverValue`s, then fire listeners wherever the composed value's
   * reference changed. Transactional per-updater: a throwing updater is buffered-and-discarded and
   * returned as a `ReplayDrop` (the caller removes it from the log); the rebuild always completes.
   *
   * @param entries    surviving pending mutations, in replay order
   * @param invokeUpdate runs one entry's updater against the view (kept in the reconciler so the
   *                     entry `seed` can feed `placeholderId()`/`now()` when T5 wires them)
   * @param forceNotify  subscription `hash`es (subscription resume) to fire listeners for even when
   *                     the composed reference didn't change — a `QueryUnchanged` ingest has no new
   *                     value to swap in (`serverValue` is retained as-is), yet this store has NEVER
   *                     done content-based dedup for a plain `QueryUpdated` either: `setServerValue`
   *                     unconditionally overwrites `serverValue`, and — because `jsonToConvex` mints
   *                     a fresh object on every decode — the reference-inequality check below ALWAYS
   *                     fires for a content-identical `QueryUpdated` today (verified in
   *                     `test/resume-client.test.ts`'s Step-1 comment). `forceNotify` reproduces
   *                     that same always-fires behavior for `QueryUnchanged`, so it introduces no new
   *                     observable difference for app code. One nuance worth flagging: a
   *                     `QueryUnchanged` notify hands listeners the RETAINED `serverValue` reference
   *                     (nothing new was decoded), whereas a value-equal `QueryUpdated` today mints a
   *                     fresh object every time — so a reference-equality consumer (e.g. React's
   *                     `useState`, which bails out of a re-render when the new state === the old
   *                     state) may legitimately skip one redundant re-render on this path that it
   *                     wouldn't skip on an equivalent full send. Content identity is hash-proven
   *                     either way; only the object identity differs.
   */
  recompose(
    entries: Iterable<PendingMutation>,
    invokeUpdate: (entry: PendingMutation, view: OptimisticStoreView) => void,
    forceNotify?: ReadonlySet<string>,
  ): ReplayDrop[] {
    // Committed overlay: hash -> value, accumulated across updaters in order. Absent hash === base.
    const overlay = new Map<string, Value | undefined>();
    const dropped: ReplayDrop[] = [];

    for (const entry of entries) {
      if (!entry.update) continue;
      const local = new Map<string, Value | undefined>(); // this updater's writes, isolated until it succeeds
      const touched = new Set<string>();
      const read = (hash: string): Value | undefined =>
        local.has(hash) ? local.get(hash) : overlay.has(hash) ? overlay.get(hash) : this.serverValueOf(hash);
      const view: OptimisticStoreView = {
        getQuery: (ref, args = {}) => read(queryHash(getFunctionPath(ref), convexToJson(args as Value))),
        setQuery: (ref, args, value) => {
          const h = queryHash(getFunctionPath(ref), convexToJson(args as Value));
          local.set(h, value);
          touched.add(h);
        },
        getAllQueries: (ref) => {
          const path = getFunctionPath(ref);
          const out: Array<{ args: Record<string, Value>; value: Value | undefined }> = [];
          for (const s of this.byHash.values()) {
            if (s.path === path) out.push({ args: jsonToConvex(s.args) as Record<string, Value>, value: read(s.hash) });
          }
          return out;
        },
      };
      try {
        invokeUpdate(entry, view);
      } catch (error) {
        dropped.push({ requestId: entry.requestId, error }); // local writes discarded — overlay untouched
        continue;
      }
      for (const h of touched) overlay.set(h, local.get(h));
      entry.touched = touched;
    }

    // Apply composed values + fire on reference change. Untouched subs get the SAME serverValue
    // reference (byte-identity invariant), so they never spuriously fire — UNLESS `forceNotify`
    // names them (a `QueryUnchanged` resume, matching today's always-fires `QueryUpdated` behavior).
    for (const sub of this.byHash.values()) {
      const next = overlay.has(sub.hash) ? overlay.get(sub.hash) : sub.serverValue;
      if (next !== sub.composedValue || forceNotify?.has(sub.hash)) {
        sub.composedValue = next;
        if (next !== undefined) {
          for (const l of sub.listeners) l.onUpdate(next);
        }
      }
    }
    return dropped;
  }
}
