/**
 * Half-open key ranges `[start, end)` scoped to a keyspace, and a `RangeSet` that
 * accumulates them. This is the substrate for both OCC read/write sets and reactive
 * subscription matching: a write's `RangeSet` intersected with a query's read `RangeSet`
 * tells us exactly which subscriptions to recompute.
 */
import { compareKeyBytes } from "./encode";
import { tableOfKeyspaceId } from "./keyspace";

export interface KeyRange {
  keyspace: string;
  /** Inclusive lower bound. */
  start: Uint8Array;
  /** Exclusive upper bound; `null` means +∞ within the keyspace. */
  end: Uint8Array | null;
}

/** The exclusive successor of a key (`key` followed by a 0x00 byte) — used for point ranges. */
export function keySuccessor(key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out.set(key, 0);
  out[key.length] = 0x00;
  return out;
}

export function keyInRange(key: Uint8Array, range: KeyRange): boolean {
  if (compareKeyBytes(key, range.start) < 0) return false;
  return range.end === null || compareKeyBytes(key, range.end) < 0;
}

/** True iff two ranges in the SAME keyspace overlap (half-open intervals). */
export function rangesOverlap(a: KeyRange, b: KeyRange): boolean {
  if (a.keyspace !== b.keyspace) return false;
  // [as,ae) ∩ [bs,be) ≠ ∅  ⇔  as < be  ∧  bs < ae   (null end = +∞)
  const aStartLtBEnd = b.end === null || compareKeyBytes(a.start, b.end) < 0;
  const bStartLtAEnd = a.end === null || compareKeyBytes(b.start, a.end) < 0;
  return aStartLtBEnd && bStartLtAEnd;
}

/** A mutable collection of key ranges, grouped by keyspace for efficient overlap checks. */
export class RangeSet {
  private readonly byKeyspace = new Map<string, KeyRange[]>();

  add(range: KeyRange): void {
    const list = this.byKeyspace.get(range.keyspace);
    if (list) list.push(range);
    else this.byKeyspace.set(range.keyspace, [range]);
  }

  /** Record a point read/write of a single key. */
  addKey(keyspace: string, key: Uint8Array): void {
    this.add({ keyspace, start: key, end: keySuccessor(key) });
  }

  /** Record reading/writing an entire keyspace (e.g. a full table scan). */
  addKeyspace(keyspace: string): void {
    this.add({ keyspace, start: new Uint8Array(0), end: null });
  }

  /** True if `range` overlaps any range already in this set. */
  intersectsRange(range: KeyRange): boolean {
    const list = this.byKeyspace.get(range.keyspace);
    if (!list) return false;
    return list.some((r) => rangesOverlap(r, range));
  }

  /** True if this set shares any overlapping range with `other`. */
  intersects(other: RangeSet): boolean {
    for (const [keyspace, list] of this.byKeyspace) {
      const otherList = other.byKeyspace.get(keyspace);
      if (!otherList) continue;
      for (const a of list) {
        for (const b of otherList) {
          if (rangesOverlap(a, b)) return true;
        }
      }
    }
    return false;
  }

  toArray(): KeyRange[] {
    const out: KeyRange[] = [];
    for (const list of this.byKeyspace.values()) out.push(...list);
    return out;
  }

  keyspaces(): string[] {
    return [...this.byKeyspace.keys()];
  }

  get size(): number {
    let n = 0;
    for (const list of this.byKeyspace.values()) n += list.length;
    return n;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }
}

/** Distinct table names touched by a set of ranges (for table-level invalidation). */
export function writtenTablesFromRanges(ranges: readonly KeyRange[]): string[] {
  const tables = new Set<string>();
  for (const r of ranges) tables.add(tableOfKeyspaceId(r.keyspace));
  return [...tables];
}
