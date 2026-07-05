/**
 * Tracks live subscriptions (a query + the ranges/tables its read set touched) and answers
 * "which subscriptions does this write invalidate?". Range-bearing subscriptions are indexed in a
 * per-keyspace augmented interval tree (`IntervalIndex`) so matching is O(log N + k) in the number
 * of live subscriptions, not O(N). Subscriptions without read ranges fall back to table-level
 * matching via the `byTable` index. Read ranges are deserialized ONCE at registration, never per
 * write. Semantics are identical to the retired linear scan (proven by the differential oracle test).
 */
import type { JSONValue } from "@helipod/values";
import { deserializeKeyRange, IntervalIndex, type KeyRange, type SerializedKeyRange } from "@helipod/index-key-codec";

export type MatchMode = "table" | "range";

export interface Subscription {
  sessionId: string;
  queryId: number;
  udfPath: string;
  args: JSONValue;
  /** Tables this subscription's read set touched (table-level match key / fallback). */
  tables: string[];
  /** Precise read ranges (range-level match key — surgical invalidation). */
  readRanges: readonly SerializedKeyRange[];
  /**
   * M2c: global (D1) tables this subscription's read set touched (a `.global()` read produces no
   * `readRanges` entry, so these are NOT already covered by `tables`/`readRanges` above). Field +
   * threading only — NOT yet indexed/matched here; Task 4 adds the dedicated `byGlobalTable` index,
   * `findAffectedByRanges` matching, and a `subscribedGlobalTables()` accessor that read it.
   */
  globalTables?: string[];
  /** DIFFABLE_BYID marker + the by-id read descriptor; absent ⇒ RERUN. Set at subscribe (classify). */
  byId?: import("./classify").ByIdRead;
  /** DIFFABLE_RANGE marker + the range read descriptor; absent ⇒ RERUN. Set at subscribe (classify). */
  range?: import("./classify").RangeRead;
  /**
   * DLR Stage 3: the resume-registry key this sub was registered under, captured at subscribe time.
   * Release MUST use this stored key — never a key re-derived from `session.identity` at teardown,
   * because `SetAuth` can mutate `session.identity` in place after subscribe, which would otherwise
   * release a different key than `upsert` created (a silent no-op → permanent registry leak).
   */
  resumeKey?: string;
}

function subKey(sessionId: string, queryId: number): string {
  return `${sessionId} ${queryId}`;
}

export class SubscriptionManager {
  private readonly byKey = new Map<string, Subscription>();
  private readonly byTable = new Map<string, Set<string>>();
  private readonly byRange = new IntervalIndex<string>();
  private readonly tableFallbackKeys = new Set<string>();
  private readonly deserializedRanges = new Map<string, KeyRange[]>();
  /**
   * M2c: index from global (D1) table name -> subscription keys whose read set touched it, via
   * `Subscription.globalTables`. Populated UNCONDITIONALLY in `add` (independent of
   * `readRanges`/`tableFallbackKeys`) so a MIXED subscription — one with both local `readRanges`
   * and a global-table read — still lands here. Matched by a THIRD, ungated loop in
   * `findAffectedByRanges`; the existing table-fallback loop is gated on `tableFallbackKeys`
   * precisely because it must NOT fire for a sub with non-empty `readRanges`, but global-table
   * reads have no `readRanges` entry of their own, so that gate would wrongly exclude a mixed sub.
   */
  private readonly byGlobalTable = new Map<string, Set<string>>();

  add(sub: Subscription): void {
    const key = subKey(sub.sessionId, sub.queryId);
    this.removeKey(key); // refresh: drop any stale index entries for this sub
    this.byKey.set(key, sub);
    for (const table of sub.tables) {
      let set = this.byTable.get(table);
      if (!set) { set = new Set(); this.byTable.set(table, set); }
      set.add(key);
    }
    if (sub.readRanges.length > 0) {
      const ranges = sub.readRanges.map(deserializeKeyRange);
      this.deserializedRanges.set(key, ranges);
      for (const range of ranges) this.byRange.insert(range, key);
    } else {
      this.tableFallbackKeys.add(key);
    }
    for (const t of sub.globalTables ?? []) {
      let s = this.byGlobalTable.get(t);
      if (!s) { s = new Set(); this.byGlobalTable.set(t, s); }
      s.add(key);
    }
  }

  private removeKey(key: string): void {
    const existing = this.byKey.get(key);
    if (!existing) return;
    const ranges = this.deserializedRanges.get(key);
    if (ranges) {
      for (const range of ranges) this.byRange.remove(range, key);
      this.deserializedRanges.delete(key);
    }
    this.tableFallbackKeys.delete(key);
    for (const table of existing.tables) this.byTable.get(table)?.delete(key);
    for (const t of existing.globalTables ?? []) {
      const s = this.byGlobalTable.get(t);
      s?.delete(key);
      if (s && s.size === 0) this.byGlobalTable.delete(t);
    }
    this.byKey.delete(key);
  }

  remove(sessionId: string, queryId: number): void {
    this.removeKey(subKey(sessionId, queryId));
  }

  removeSession(sessionId: string): void {
    const prefix = `${sessionId} `;
    for (const key of [...this.byKey.keys()]) if (key.startsWith(prefix)) this.removeKey(key);
  }

  get(sessionId: string, queryId: number): Subscription | undefined {
    return this.byKey.get(subKey(sessionId, queryId));
  }

  /**
   * Subscriptions whose read set intersects the given write ranges (surgical invalidation),
   * unioned with table-fallback subscriptions (empty readRanges) touched by the write tables.
   * Same result set as the retired linear scan, computed in O(log N + k) per write range.
   */
  findAffectedByRanges(writeRanges: readonly SerializedKeyRange[], writeTables: readonly string[]): Subscription[] {
    const keys = new Set<string>();
    // Range subs: overlap query per write range.
    for (const w of writeRanges) {
      const wr = deserializeKeyRange(w);
      for (const key of this.byRange.queryOverlaps(wr)) keys.add(key);
    }
    // Fallback subs (empty readRanges): table match only.
    for (const table of writeTables) {
      const set = this.byTable.get(table);
      if (!set) continue;
      for (const key of set) if (this.tableFallbackKeys.has(key)) keys.add(key);
    }
    // Global-table subs (M2c): ungated by tableFallbackKeys — a mixed sub (non-empty readRanges
    // PLUS a global-table read) must still match, since the global read left no readRanges entry.
    for (const table of writeTables) {
      const set = this.byGlobalTable.get(table);
      if (set) for (const key of set) keys.add(key);
    }
    const out: Subscription[] = [];
    for (const key of keys) {
      const sub = this.byKey.get(key);
      if (sub) out.push(sub);
    }
    return out;
  }

  /** Subscriptions whose read set touched any of the given tables (deduped). */
  findAffectedByTables(tables: readonly string[]): Subscription[] {
    const out = new Map<string, Subscription>();
    for (const table of tables) {
      const keys = this.byTable.get(table);
      if (!keys) continue;
      for (const key of keys) {
        const sub = this.byKey.get(key);
        if (sub) out.set(key, sub);
      }
    }
    return [...out.values()];
  }

  /** All subscriptions for a session (e.g. to re-run them when identity changes). */
  forSession(sessionId: string): Subscription[] {
    const prefix = `${sessionId} `;
    const out: Subscription[] = [];
    for (const [key, sub] of this.byKey) if (key.startsWith(prefix)) out.push(sub);
    return out;
  }

  get size(): number {
    return this.byKey.size;
  }

  /** Global (D1) table names with at least one live subscriber (M2c). */
  subscribedGlobalTables(): string[] {
    return [...this.byGlobalTable.keys()];
  }
}
