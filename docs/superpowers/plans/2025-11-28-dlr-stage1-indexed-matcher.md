# DLR Stage 1 — Interval-Indexed Matcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the O(N) subscription matcher (`SubscriptionManager.findAffectedByRanges` linear scan) with a per-keyspace augmented interval tree, so reactive invalidation is sub-linear in subscription count.

**Architecture:** Add a generic `IntervalIndex<V>` (augmented interval tree, treap with deterministic hashed priorities) to `@stackbase/index-key-codec`. Rewrite `SubscriptionManager` to insert each subscription's read ranges into that index once at registration, route empty-`readRanges` subscriptions through the existing `byTable` index, and answer `findAffectedByRanges` with overlap queries. Replace the old scan outright, keeping it only as a differential-test oracle.

**Tech Stack:** TypeScript, vitest, Bun. No new dependencies.

## Global Constraints

- **Signature/semantics frozen:** `findAffectedByRanges(writeRanges: readonly SerializedKeyRange[], writeTables: readonly string[]): Subscription[]` keeps the same inputs and returns the **same set** of subscriptions as today (range subs match by overlapping range only; empty-`readRanges` subs match by table only; each sub once).
- **No `Math.random`** anywhere (treap priorities are a deterministic hash; tests use a seeded RNG).
- **Half-open range semantics:** ranges are `[start, end)`; `end === null` means +∞ within the keyspace. Reuse `rangesOverlap`/`compareKeyBytes` from the codec — introduce no new overlap math.
- **`Subscription` interface is not modified** — parsed ranges live only in a private manager map.
- **Single-node only:** no fleet/per-shard fragments (DLR Stage 5). Do not touch the wire protocol, commit path, or any consumer of `findAffectedByRanges`.
- **Deps import from the package root** `@stackbase/index-key-codec` (its `src/index.ts` re-exports everything).

---

### Task 1: `IntervalIndex<V>` in `@stackbase/index-key-codec`

**Files:**
- Create: `packages/index-key-codec/src/interval-index.ts`
- Modify: `packages/index-key-codec/src/index.ts` (export `IntervalIndex`)
- Test: `packages/index-key-codec/test/interval-index.test.ts`

**Interfaces:**
- Consumes: `KeyRange` (`{ keyspace: string; start: Uint8Array; end: Uint8Array | null }`), `compareKeyBytes(a,b): -1|0|1`, `rangesOverlap(a,b): boolean`, `keySuccessor(key): Uint8Array` — all from this package.
- Produces:
  - `class IntervalIndex<V>` with `constructor(valueKey?: (v: V) => string)` (default `(v) => String(v)`), `insert(range: KeyRange, value: V): void`, `remove(range: KeyRange, value: V): void`, `queryOverlaps(range: KeyRange): V[]`, `get size(): number`.

- [ ] **Step 1: Write the failing unit test**

`packages/index-key-codec/test/interval-index.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { IntervalIndex } from "../src/interval-index";
import type { KeyRange } from "../src/range";
import { keySuccessor } from "../src/range";

const KS = "t/idx";
const b = (...n: number[]) => new Uint8Array(n);
function point(key: Uint8Array, ks = KS): KeyRange { return { keyspace: ks, start: key, end: keySuccessor(key) }; }
function span(start: Uint8Array, end: Uint8Array | null, ks = KS): KeyRange { return { keyspace: ks, start, end }; }

describe("IntervalIndex", () => {
  it("stabs a point that lands inside a span", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["A"]);
    expect(idx.queryOverlaps(point(b(9)))).toEqual([]); // end is exclusive
    expect(idx.queryOverlaps(point(b(0)))).toEqual([]);
  });

  it("returns all overlapping ranges including nested and wide", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(0), null), "ALL");           // whole keyspace, +∞
    idx.insert(span(b(1), b(9)), "WIDE");
    idx.insert(span(b(4), b(6)), "NARROW");
    idx.insert(point(b(2)), "PT2");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["ALL", "NARROW", "WIDE"]);
    expect(idx.queryOverlaps(point(b(2))).sort()).toEqual(["ALL", "PT2", "WIDE"]);
  });

  it("keeps values in different keyspaces independent", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9), "ks1"), "A");
    idx.insert(span(b(1), b(9), "ks2"), "B");
    expect(idx.queryOverlaps(span(b(5), b(6), "ks1"))).toEqual(["A"]);
    expect(idx.queryOverlaps(span(b(5), b(6), "ks2"))).toEqual(["B"]);
  });

  it("supports two values on identical bounds", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    idx.insert(span(b(1), b(9)), "B");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["A", "B"]);
  });

  it("insert is idempotent for the same (bounds,value); remove deletes the exact entry", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    idx.insert(span(b(1), b(9)), "A"); // idempotent
    expect(idx.size).toBe(1);
    idx.insert(span(b(1), b(9)), "B");
    idx.remove(span(b(1), b(9)), "A");
    expect(idx.queryOverlaps(point(b(5)))).toEqual(["B"]);
    expect(idx.size).toBe(1);
    idx.remove(span(b(1), b(9)), "B");
    expect(idx.size).toBe(0);
    expect(idx.queryOverlaps(point(b(5)))).toEqual([]);
  });

  it("survives churn and stays correct (insert/remove interleaved)", () => {
    const idx = new IntervalIndex<string>();
    for (let i = 0; i < 200; i++) idx.insert(point(b(i)), `v${i}`);
    for (let i = 0; i < 200; i += 2) idx.remove(point(b(i)), `v${i}`);
    expect(idx.size).toBe(100);
    expect(idx.queryOverlaps(point(b(3)))).toEqual(["v3"]);
    expect(idx.queryOverlaps(point(b(4)))).toEqual([]); // removed
  });

  it("handles +∞ (null end) in the augmentation prune", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(10), null), "TAIL"); // [10, +∞)
    idx.insert(span(b(1), b(2)), "LOW");
    expect(idx.queryOverlaps(point(b(50))).sort()).toEqual(["TAIL"]);
    expect(idx.queryOverlaps(point(b(1))).sort()).toEqual(["LOW"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run --filter @stackbase/index-key-codec test interval-index`
Expected: FAIL — `Cannot find module "../src/interval-index"`.

- [ ] **Step 3: Implement `IntervalIndex`**

`packages/index-key-codec/src/interval-index.ts`:

```ts
/**
 * A collection of `KeyRange`s each carrying a value, with fast overlap queries and incremental
 * insert/delete. Bucketed by keyspace (a write range can only overlap read ranges in the SAME
 * keyspace); within a keyspace, an augmented interval tree (a treap keyed by `start`, each node
 * augmented with its subtree's max `end`, `null` = +∞). Priorities are a deterministic hash of the
 * entry's identity, so the tree shape is a pure function of its contents (reproducible) while
 * staying balanced in expectation regardless of insertion order. Overlap uses `rangesOverlap`
 * verbatim, so `[start, end)` half-open + `null`-end (+∞) semantics match the rest of the codec.
 */
import { compareKeyBytes } from "./encode";
import { rangesOverlap, type KeyRange } from "./range";

interface Node<V> {
  start: Uint8Array;
  end: Uint8Array | null; // exclusive; null = +∞
  value: V;
  valueKey: string;
  priority: number;
  maxEnd: Uint8Array | null; // subtree max end; null = +∞ present in subtree
  left: Node<V> | null;
  right: Node<V> | null;
}

/** FNV-1a 32-bit over (start, end-or-∞marker, valueKey) — deterministic, well-distributed. */
function hashPriority(start: Uint8Array, end: Uint8Array | null, valueKey: string): number {
  let h = 0x811c9dc5;
  const mix = (byte: number): void => {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const byte of start) mix(byte);
  mix(0x00);
  if (end === null) mix(0xff);
  else for (const byte of end) mix(byte);
  mix(0x00);
  for (let i = 0; i < valueKey.length; i++) mix(valueKey.charCodeAt(i) & 0xff);
  return h >>> 0;
}

/** `null` end = +∞ dominates any concrete key. */
function maxEnd2(a: Uint8Array | null, b: Uint8Array | null): Uint8Array | null {
  if (a === null || b === null) return null;
  return compareKeyBytes(a, b) >= 0 ? a : b;
}

/** Total order on entries so `(start,end,valueKey)` triples are addressable. `null` end sorts last. */
function cmpEntry<V>(
  aStart: Uint8Array, aEnd: Uint8Array | null, aKey: string,
  node: Node<V>,
): -1 | 0 | 1 {
  const cs = compareKeyBytes(aStart, node.start);
  if (cs !== 0) return cs;
  if (aEnd === null || node.end === null) {
    if (aEnd !== node.end) return aEnd === null ? 1 : -1; // one is +∞
  } else {
    const ce = compareKeyBytes(aEnd, node.end);
    if (ce !== 0) return ce;
  }
  if (aKey < node.valueKey) return -1;
  if (aKey > node.valueKey) return 1;
  return 0;
}

function recalcMax<V>(n: Node<V>): void {
  let m = n.end;
  if (n.left) m = maxEnd2(m, n.left.maxEnd);
  if (n.right) m = maxEnd2(m, n.right.maxEnd);
  n.maxEnd = m;
}

function rotateRight<V>(n: Node<V>): Node<V> {
  const l = n.left!;
  n.left = l.right;
  l.right = n;
  recalcMax(n);
  recalcMax(l);
  return l;
}

function rotateLeft<V>(n: Node<V>): Node<V> {
  const r = n.right!;
  n.right = r.left;
  r.left = n;
  recalcMax(n);
  recalcMax(r);
  return r;
}

/** One keyspace's augmented interval treap. */
class Treap<V> {
  root: Node<V> | null = null;
  size = 0;

  insert(start: Uint8Array, end: Uint8Array | null, value: V, valueKey: string): void {
    const before = this.size;
    this.root = this.insertAt(this.root, start, end, value, valueKey);
    // size is bumped inside insertAt only on a genuine new node
    void before;
  }

  private insertAt(
    node: Node<V> | null, start: Uint8Array, end: Uint8Array | null, value: V, valueKey: string,
  ): Node<V> {
    if (node === null) {
      this.size++;
      return { start, end, value, valueKey, priority: hashPriority(start, end, valueKey), maxEnd: end, left: null, right: null };
    }
    const c = cmpEntry(start, end, valueKey, node);
    if (c === 0) return node; // idempotent: identical (bounds,value)
    if (c < 0) {
      node.left = this.insertAt(node.left, start, end, value, valueKey);
      if (node.left.priority > node.priority) node = rotateRight(node);
    } else {
      node.right = this.insertAt(node.right, start, end, value, valueKey);
      if (node.right.priority > node.priority) node = rotateLeft(node);
    }
    recalcMax(node);
    return node;
  }

  remove(start: Uint8Array, end: Uint8Array | null, valueKey: string): void {
    const before = this.size;
    this.root = this.removeAt(this.root, start, end, valueKey);
    void before;
  }

  private removeAt(node: Node<V> | null, start: Uint8Array, end: Uint8Array | null, valueKey: string): Node<V> | null {
    if (node === null) return null;
    const c = cmpEntry(start, end, valueKey, node);
    if (c < 0) node.left = this.removeAt(node.left, start, end, valueKey);
    else if (c > 0) node.right = this.removeAt(node.right, start, end, valueKey);
    else {
      if (node.left === null) { this.size--; return node.right; }
      if (node.right === null) { this.size--; return node.left; }
      if (node.left.priority > node.right.priority) {
        node = rotateRight(node);
        node.right = this.removeAt(node.right, start, end, valueKey);
      } else {
        node = rotateLeft(node);
        node.left = this.removeAt(node.left, start, end, valueKey);
      }
    }
    if (node) recalcMax(node);
    return node;
  }

  collect(keyspace: string, q: KeyRange, out: V[]): void {
    this.collectAt(this.root, keyspace, q, out);
  }

  private collectAt(node: Node<V> | null, keyspace: string, q: KeyRange, out: V[]): void {
    if (node === null) return;
    // Prune: if the whole subtree's max end cannot exceed q.start, nothing overlaps (half-open).
    if (node.maxEnd !== null && compareKeyBytes(node.maxEnd, q.start) <= 0) return;
    this.collectAt(node.left, keyspace, q, out);
    if (rangesOverlap({ keyspace, start: node.start, end: node.end }, q)) out.push(node.value);
    // Right subtree starts are >= node.start; overlap needs start < q.end.
    if (q.end === null || compareKeyBytes(node.start, q.end) < 0) this.collectAt(node.right, keyspace, q, out);
  }
}

export class IntervalIndex<V> {
  private readonly byKeyspace = new Map<string, Treap<V>>();
  private readonly valueKey: (v: V) => string;

  constructor(valueKey: (v: V) => string = (v) => String(v)) {
    this.valueKey = valueKey;
  }

  insert(range: KeyRange, value: V): void {
    let tree = this.byKeyspace.get(range.keyspace);
    if (!tree) { tree = new Treap<V>(); this.byKeyspace.set(range.keyspace, tree); }
    tree.insert(range.start, range.end, value, this.valueKey(value));
  }

  remove(range: KeyRange, value: V): void {
    const tree = this.byKeyspace.get(range.keyspace);
    if (!tree) return;
    tree.remove(range.start, range.end, this.valueKey(value));
    if (tree.size === 0) this.byKeyspace.delete(range.keyspace);
  }

  queryOverlaps(range: KeyRange): V[] {
    const tree = this.byKeyspace.get(range.keyspace);
    if (!tree) return [];
    const out: V[] = [];
    tree.collect(range.keyspace, range, out);
    return out;
  }

  get size(): number {
    let n = 0;
    for (const tree of this.byKeyspace.values()) n += tree.size;
    return n;
  }
}
```

- [ ] **Step 4: Export it**

In `packages/index-key-codec/src/index.ts`, after the `range` export block, add:

```ts
export { IntervalIndex } from "./interval-index";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun run --filter @stackbase/index-key-codec test`
Expected: PASS (all `interval-index` cases + the existing `encode`/`range` tests).

- [ ] **Step 6: Typecheck**

Run: `bun run --filter @stackbase/index-key-codec typecheck`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add packages/index-key-codec/src/interval-index.ts packages/index-key-codec/src/index.ts packages/index-key-codec/test/interval-index.test.ts
git commit -m "feat(index-key-codec): IntervalIndex<V> — augmented interval tree over KeyRanges"
```

---

### Task 2: Rewrite `SubscriptionManager` to use the index + differential oracle test

**Files:**
- Modify: `packages/sync/src/subscription-manager.ts` (full rewrite of the matching internals)
- Test: `packages/sync/test/subscription-manager.test.ts` (new — the differential oracle)

**Interfaces:**
- Consumes: `IntervalIndex` (Task 1), `deserializeKeyRange`, `KeyRange`, `SerializedKeyRange` from `@stackbase/index-key-codec`.
- Produces: `SubscriptionManager` with the **same public API** (`add`, `remove`, `removeSession`, `get`, `findAffectedByRanges`, `findAffectedByTables`, `forSession`, `size`) and identical `findAffectedByRanges` result sets.

- [ ] **Step 1: Write the failing differential oracle test**

`packages/sync/test/subscription-manager.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SubscriptionManager, type Subscription } from "../src/subscription-manager";
import {
  serializeKeyRange, deserializeKeyRange, rangesOverlap, keySuccessor,
  indexKeyspaceId, tableOfKeyspaceId, type SerializedKeyRange, type KeyRange,
} from "@stackbase/index-key-codec";

// --- seeded RNG (mulberry32) so failures reproduce; no Math.random ---
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TABLES = ["users", "messages", "posts"];
const INDEXES = ["by_a", "by_b"];
function keyspaceFor(r: () => number): string {
  return indexKeyspaceId(TABLES[Math.floor(r() * TABLES.length)]!, INDEXES[Math.floor(r() * INDEXES.length)]!);
}
function keyBytes(r: () => number): Uint8Array {
  return new Uint8Array([Math.floor(r() * 8)]); // small alphabet => collisions/overlaps happen
}
function randomRange(r: () => number): KeyRange {
  const ks = keyspaceFor(r);
  const roll = r();
  if (roll < 0.5) { const k = keyBytes(r); return { keyspace: ks, start: k, end: keySuccessor(k) }; } // point
  if (roll < 0.7) return { keyspace: ks, start: new Uint8Array(0), end: null }; // whole keyspace
  const a = keyBytes(r), c = keyBytes(r);
  const [lo, hi] = a[0]! <= c[0]! ? [a, c] : [c, a];
  return { keyspace: ks, start: lo, end: new Uint8Array([hi[0]! + 1]) }; // span
}

// --- the ORACLE: the retired linear-scan semantics ---
function bruteForce(subs: Subscription[], writeRanges: SerializedKeyRange[], writeTables: string[]): Set<string> {
  const out = new Set<string>();
  const wr = writeRanges.map(deserializeKeyRange);
  for (const sub of subs) {
    const key = `${sub.sessionId} ${sub.queryId}`;
    if (sub.readRanges.length > 0) {
      const rr = sub.readRanges.map(deserializeKeyRange);
      if (wr.some((w) => rr.some((r) => rangesOverlap(w, r)))) out.add(key);
    } else {
      if (writeTables.some((t) => sub.tables.includes(t))) out.add(key);
    }
  }
  return out;
}

function makeSub(r: () => number, id: number): Subscription {
  const isFallback = r() < 0.25;
  const ranges: KeyRange[] = isFallback ? [] : Array.from({ length: 1 + Math.floor(r() * 2) }, () => randomRange(r));
  const tables = isFallback
    ? [TABLES[Math.floor(r() * TABLES.length)]!]
    : [...new Set(ranges.map((rg) => tableOfKeyspaceId(rg.keyspace)))];
  return {
    sessionId: `s${id % 5}`, queryId: id, udfPath: "q", args: null,
    tables, readRanges: ranges.map(serializeKeyRange),
  };
}

describe("SubscriptionManager — indexed matcher equals the linear-scan oracle", () => {
  it("matches brute force across randomized populations, churn, and writes", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const mgr = new SubscriptionManager();
      const live = new Map<number, Subscription>();
      let nextId = 0;
      // build + churn
      for (let op = 0; op < 120; op++) {
        if (r() < 0.7 || live.size === 0) {
          const sub = makeSub(r, nextId++);
          mgr.add(sub);
          live.set(sub.queryId, sub);
        } else {
          const ids = [...live.keys()];
          const victim = ids[Math.floor(r() * ids.length)]!;
          const sub = live.get(victim)!;
          mgr.remove(sub.sessionId, sub.queryId);
          live.delete(victim);
        }
      }
      const subs = [...live.values()];
      // random writes
      for (let w = 0; w < 30; w++) {
        const writeRanges = Array.from({ length: 1 + Math.floor(r() * 2) }, () => serializeKeyRange(randomRange(r)));
        const writeTables = [...new Set(writeRanges.map((s) => tableOfKeyspaceId(s.keyspace)))];
        const got = new Set(mgr.findAffectedByRanges(writeRanges, writeTables).map((s) => `${s.sessionId} ${s.queryId}`));
        const want = bruteForce(subs, writeRanges, writeTables);
        expect([...got].sort()).toEqual([...want].sort());
      }
    }
  });

  it("removeSession purges range + fallback subs from the index", () => {
    const mgr = new SubscriptionManager();
    const ks = indexKeyspaceId("users", "by_a");
    const k = new Uint8Array([3]);
    const ranged: Subscription = {
      sessionId: "s1", queryId: 1, udfPath: "q", args: null, tables: ["users"],
      readRanges: [serializeKeyRange({ keyspace: ks, start: k, end: keySuccessor(k) })],
    };
    const fallback: Subscription = {
      sessionId: "s1", queryId: 2, udfPath: "q", args: null, tables: ["users"], readRanges: [],
    };
    mgr.add(ranged); mgr.add(fallback);
    const wr = [serializeKeyRange({ keyspace: ks, start: k, end: keySuccessor(k) })];
    expect(mgr.findAffectedByRanges(wr, ["users"]).length).toBe(2);
    mgr.removeSession("s1");
    expect(mgr.findAffectedByRanges(wr, ["users"])).toEqual([]);
    expect(mgr.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run build && bun run --filter @stackbase/sync test subscription-manager`
Expected: FAIL — the new test file compiles but the current `SubscriptionManager` has no `subscription-manager.test.ts` companion yet; the oracle test runs against the CURRENT linear-scan impl and PASSES the equality (old == old). That is fine — it establishes the oracle. To make Step 2 a genuine red, first confirm the file runs; the real gate is Step 4 (the rewrite must keep it green). If the test errors on import/setup, fix the test before proceeding.

> Rationale: this task's "test-first" artifact is the oracle itself. It must pass against the current implementation (proving the oracle is faithful) and continue to pass against the rewrite (proving equivalence). Treat a green Step 2 as "oracle faithful," then do the rewrite and keep it green.

- [ ] **Step 3: Rewrite `subscription-manager.ts`**

Replace the entire file `packages/sync/src/subscription-manager.ts` with:

```ts
/**
 * Tracks live subscriptions (a query + the ranges/tables its read set touched) and answers
 * "which subscriptions does this write invalidate?". Range-bearing subscriptions are indexed in a
 * per-keyspace augmented interval tree (`IntervalIndex`) so matching is O(log N + k) in the number
 * of live subscriptions, not O(N). Subscriptions without read ranges fall back to table-level
 * matching via the `byTable` index. Read ranges are deserialized ONCE at registration, never per
 * write. Semantics are identical to the retired linear scan (proven by the differential oracle test).
 */
import type { JSONValue } from "@stackbase/values";
import { deserializeKeyRange, IntervalIndex, type KeyRange, type SerializedKeyRange } from "@stackbase/index-key-codec";

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
}
```

- [ ] **Step 4: Run the oracle test + the full sync suite**

Run: `bun run build && bun run --filter @stackbase/sync test`
Expected: PASS — the new `subscription-manager.test.ts` (oracle equality holds against the rewrite) AND every existing sync test (`sync.test.ts`, `session-controllers.test.ts`, `origin-frontier.test.ts`, etc.) unchanged.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @stackbase/sync typecheck`
Expected: 0 errors (note: `MatchMode` is still exported; `rangesOverlap` import was removed — confirm no unused-import error).

- [ ] **Step 6: Commit**

```bash
git add packages/sync/src/subscription-manager.ts packages/sync/test/subscription-manager.test.ts
git commit -m "feat(sync): index findAffectedByRanges with IntervalIndex (O(log N) matcher)"
```

---

### Task 3: Prove the win against the benchmark baseline

**Files:**
- No source changes. Produces the measured delta (recorded in the task report / commit note).

**Interfaces:**
- Consumes: the `@stackbase/bench` runner (`bun run bench:reactive` / `bench:compare`) and the committed `benchmarks/baselines/reactive-main.json`.

- [ ] **Step 1: Build and run the candidate (this branch, indexed matcher)**

Run: `bun run build && bun benchmarks/runner/src/cli.ts run --store both --seconds 5 --label stage1-candidate`
Expected: writes `benchmarks/results/stage1-candidate.json`; all scenarios `errors=0`. Note the `fanout-selective-10000` and `fanout-selective-1000` `propP50Ms`.

- [ ] **Step 2: Capture a same-machine baseline from the pre-change code**

The committed `benchmarks/baselines/reactive-main.json` may have been captured on a different machine (the `compare` staleness guard will say so). For an honest same-machine ratio, run the pre-change engine on THIS machine via a throwaway worktree at the branch's base commit:

```bash
BASE=$(git merge-base main HEAD)
git worktree add /tmp/dlr-base "$BASE"
( cd /tmp/dlr-base && bun install && bun run build && bun benchmarks/runner/src/cli.ts run --store both --seconds 5 --save /tmp/baseline-samemachine.json --label baseline-main )
git worktree remove /tmp/dlr-base --force
```

Expected: `/tmp/baseline-samemachine.json` written with `errors=0`; this reflects the OLD linear-scan matcher on the same hardware.

- [ ] **Step 3: Compare and confirm the collapse**

Run: `bun benchmarks/runner/src/cli.ts compare /tmp/baseline-samemachine.json benchmarks/results/stage1-candidate.json`
Expected (success criteria per spec §7):
- `fanout-selective-10000·propP50Ms` shows a large 🟢 improvement — collapsing from ~7–8 ms toward the sub-millisecond `fanout-selective-100` level.
- `fanout-selective-1000·propP50Ms` also improves 🟢.
- `fanout-broadcast-*` stays ⚪ within the ±3% band (broadcast is inherently O(k=N) output).
- No scenario regresses 🔴 beyond ±3% on either store.

If `fanout-selective-10000` does NOT improve materially, STOP and report — Stage 1 has not delivered and the design must be revisited before merge (benchmark-first discipline).

- [ ] **Step 4: Record the result**

Append the compare table (the `fanout-selective-*` and `fanout-broadcast-*` rows) to the task report so the delta is captured. No source commit is required for this task; the deliverable is the measured evidence.

---

## Self-Review

**Spec coverage:**
- §4.1 `IntervalIndex<V>` (per-keyspace augmented interval treap, deterministic hashed priorities, `insert`/`remove`/`queryOverlaps`/`size`, exported) → Task 1. ✅
- §4.2 `SubscriptionManager` rewrite (`byRange`, `tableFallbackKeys`, `deserializedRanges`, deserialize-once, fallback via `byTable`, unchanged public API) → Task 2. ✅
- §5 semantic equivalence → enforced by Task 2's oracle test. ✅
- §6 differential oracle + `IntervalIndex` unit tests → Tasks 1 (unit) + 2 (oracle). ✅
- §7 acceptance gate (selective-10k collapse, broadcast noise, no >3% regression) → Task 3. ✅
- §3 replace-outright, no flag, signature frozen → Tasks 2 (rewrite replaces the scan) + the frozen signature in Global Constraints. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every run step has an exact command + expected result. Task 2 Step 2 is the one nuance (the oracle passes against the *current* impl by design) — explained inline with rationale, not a placeholder.

**Type consistency:** `IntervalIndex<V>` API (`insert`/`remove`/`queryOverlaps(range): V[]`/`size`) is defined in Task 1 and consumed with `IntervalIndex<string>` in Task 2. `deserializeKeyRange`, `KeyRange`, `SerializedKeyRange`, `rangesOverlap`, `keySuccessor`, `indexKeyspaceId`, `tableOfKeyspaceId`, `serializeKeyRange` are all real exports of `@stackbase/index-key-codec` (verified in its `src/index.ts`). The `Subscription` interface (`sessionId`, `queryId`, `udfPath`, `args`, `tables`, `readRanges`) is unchanged between the current file and the rewrite. `subKey` format `"${sessionId} ${queryId}"` matches the oracle's key derivation in the test.
