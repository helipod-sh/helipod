/**
 * The compute-saving half of reconnect resume (DLR Stage 3): for every LIVE query
 * (identity+path+args), tracks the read set it last executed with and the timestamp through
 * which its result is known-current (`lastInvalidatedTs`). A commit advances that timestamp for
 * every registry entry whose ranges/tables intersect the write — using the SAME range-indexed
 * matcher as `SubscriptionManager` (an `IntervalIndex` keyed by keyspace plus a `byTable`
 * fallback) so this stays O(log N + k), not a linear scan.
 *
 * Entries are TTL-retained across disconnect: a query with zero live subscribers is not evicted
 * immediately (a reconnect within `TTL_MS` should still be able to resume it), but it MUST stay
 * indexed the whole time it's retained — a write landing during that "gap" still has to advance
 * `lastInvalidatedTs`, or a resuming client would wrongly believe its stale result is current.
 */
import { deserializeKeyRange, IntervalIndex, type KeyRange, type SerializedKeyRange } from "@helipod/index-key-codec";
import type { JSONValue } from "@helipod/values";

export const TTL_MS = 60_000;

export function regKey(identity: string | null, path: string, argsJson: JSONValue): string {
  return `${identity ?? ""} ${path} ${JSON.stringify(argsJson)}`;
}

interface ResumeEntry {
  readRanges: readonly SerializedKeyRange[];
  tables: readonly string[];
  /** M2c: global (D1) tables this entry's query read — carried through resume so a resumed sub
   *  keeps its global-table membership. Not yet indexed here (Task 4 adds the matching side). */
  globalTables: readonly string[];
  lastInvalidatedTs: number;
  wasDiffable: boolean;
  refCount: number;
  /** Set when refCount drops to 0; cleared again on retain. Entry is swept once this passes. */
  expiresAtMs?: number;
}

export interface ResumeLookup {
  readRanges: readonly SerializedKeyRange[];
  tables: readonly string[];
  globalTables: readonly string[];
  lastInvalidatedTs: number;
  wasDiffable: boolean;
}

export class ResumeRegistry {
  private readonly entries = new Map<string, ResumeEntry>();
  private readonly byTable = new Map<string, Set<string>>();
  private readonly byRange = new IntervalIndex<string>();
  private readonly tableFallbackKeys = new Set<string>();
  private readonly deserializedRanges = new Map<string, KeyRange[]>();

  upsert(
    key: string,
    readRanges: readonly SerializedKeyRange[],
    tables: readonly string[],
    atTs: number,
    wasDiffable: boolean,
    globalTables: readonly string[] = [],
  ): void {
    const existing = this.entries.get(key);
    const lastInvalidatedTs = Math.max(existing?.lastInvalidatedTs ?? atTs, atTs);
    const refCount = existing?.refCount ?? 0;
    this.unindex(key); // drop old range/table membership before re-indexing (ranges may have changed)
    this.entries.set(key, { readRanges, tables, globalTables, lastInvalidatedTs, wasDiffable, refCount, expiresAtMs: undefined });
    this.index(key, readRanges, tables);
  }

  private index(key: string, readRanges: readonly SerializedKeyRange[], tables: readonly string[]): void {
    for (const table of tables) {
      let set = this.byTable.get(table);
      if (!set) { set = new Set(); this.byTable.set(table, set); }
      set.add(key);
    }
    if (readRanges.length > 0) {
      const ranges = readRanges.map(deserializeKeyRange);
      this.deserializedRanges.set(key, ranges);
      for (const range of ranges) this.byRange.insert(range, key);
    } else {
      this.tableFallbackKeys.add(key);
    }
  }

  private unindex(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    const ranges = this.deserializedRanges.get(key);
    if (ranges) {
      for (const range of ranges) this.byRange.remove(range, key);
      this.deserializedRanges.delete(key);
    }
    this.tableFallbackKeys.delete(key);
    for (const table of existing.tables) this.byTable.get(table)?.delete(key);
  }

  /**
   * Advances `lastInvalidatedTs` for every entry whose read set intersects the write — including
   * entries with refCount 0 that are only TTL-retained (they remain indexed until swept).
   */
  advanceOnCommit(writtenRanges: readonly SerializedKeyRange[], writtenTables: readonly string[], commitTs: number): void {
    const keys = new Set<string>();
    for (const w of writtenRanges) {
      const wr = deserializeKeyRange(w);
      for (const key of this.byRange.queryOverlaps(wr)) keys.add(key);
    }
    for (const table of writtenTables) {
      const set = this.byTable.get(table);
      if (!set) continue;
      for (const key of set) if (this.tableFallbackKeys.has(key)) keys.add(key);
    }
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (entry) entry.lastInvalidatedTs = Math.max(entry.lastInvalidatedTs, commitTs);
    }
  }

  lookup(key: string): ResumeLookup | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return { readRanges: entry.readRanges, tables: entry.tables, globalTables: entry.globalTables, lastInvalidatedTs: entry.lastInvalidatedTs, wasDiffable: entry.wasDiffable };
  }

  retain(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount++;
    entry.expiresAtMs = undefined;
  }

  release(key: string, nowMs: number): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) entry.expiresAtMs = nowMs + TTL_MS;
  }

  /** Evicts entries with no live subscribers whose TTL has elapsed. Removes them from both indexes. */
  sweep(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.refCount <= 0 && entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs) {
        this.unindex(key);
        this.entries.delete(key);
      }
    }
  }

  /** @internal test/debug only — a live entry's current refCount, or undefined if no such entry. */
  __refCount(key: string): number | undefined {
    return this.entries.get(key)?.refCount;
  }

  /** @internal test/debug only — a live entry's pending TTL expiry, or undefined (not pending / no
   *  such entry). */
  __expiresAtMs(key: string): number | undefined {
    return this.entries.get(key)?.expiresAtMs;
  }
}
