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
import { getFunctionPath, type FunctionReference } from "./api";
import type { PendingMutation } from "./mutation-log";

/** The query identity hash — `path + ":" + JSON.stringify(argsJson)` (the existing `client.ts` hash). */
export function queryHash(path: string, argsJson: JSONValue): string {
  return `${path}:${JSON.stringify(argsJson)}`;
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
   *  baseline await waiting for a Transition that will never arrive (re-review FIX 2). */
  answered: boolean;
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
   *  `recompose` owns all listener firing so the base+drop+rebuild happen as one atomic frame. */
  setServerValue(sub: Subscription, value: Value | undefined): void {
    sub.serverValue = value;
    sub.answered = true;
  }

  /** Mark a subscription as having received its first reply WITHOUT a base value (from a
   *  `QueryFailed` modification — there is no server row to render, only an error). See the
   *  `answered` field doc for why this is distinct from `setServerValue`. */
  markAnswered(sub: Subscription): void {
    sub.answered = true;
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
   */
  recompose(
    entries: Iterable<PendingMutation>,
    invokeUpdate: (entry: PendingMutation, view: OptimisticStoreView) => void,
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
    // reference (byte-identity invariant), so they never spuriously fire.
    for (const sub of this.byHash.values()) {
      const next = overlay.has(sub.hash) ? overlay.get(sub.hash) : sub.serverValue;
      if (next !== sub.composedValue) {
        sub.composedValue = next;
        if (next !== undefined) {
          for (const l of sub.listeners) l.onUpdate(next);
        }
      }
    }
    return dropped;
  }
}
