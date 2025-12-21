# DLR Stage 1 — Interval-Indexed Subscription Matcher

> **Status:** approved design (2025-11-28), ready for an implementation plan.
> **Parent:** [`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md) §4.1 (Stage 1). This is the first stage of the DLR reactive-path rework.
> **Gated by:** the Phase-0 benchmark harness (`@stackbase/bench`) — specifically the `fanout-selective-10000` scenario.

---

## 1. Motivation

`SubscriptionManager.findAffectedByRanges` (`packages/sync/src/subscription-manager.ts:88`) answers "which live subscriptions does this write invalidate?" on **every commit**. Today it does so with a linear scan over every subscription. The benchmark harness measured the cost directly: `fanout-selective` propagation p50 climbs **0.31 ms → 7.69 ms** as subscriptions grow 100 → 10 000, even though each write matches exactly one subscription. It is the one measured super-linear cost in the reactive path (`benchmarks/baselines/reactive-main.json`).

Reading the code reveals **three** separable wastes in the current implementation:

1. **The O(N) scan.** `findAffectedByRanges` iterates all of `byKey` per write (`for (const [key, sub] of this.byKey)`), regardless of how selective the write is.
2. **Re-parsing on every write.** For each candidate it calls `deserializeKeyRange` on every stored read range *inside the per-write loop* (`rangesIntersect` → `deserializeKeyRange`), re-parsing ranges that never change after subscribe.
3. **An unused index for the fallback path.** A `byTable` index already exists (`Map<table, Set<subKey>>`) and is used by `findAffectedByTables`, but `findAffectedByRanges` ignores it — even the table-fallback subscriptions (those with empty `readRanges`) are found by linear scan.

This stage removes all three.

## 2. Scope

- **In:** rewrite the internals of `SubscriptionManager`'s range matching to be sub-linear, deserialize read ranges once at registration, and route fallback subscriptions through the existing table index. Add a generic interval-index structure. Prove correctness against the retired linear scan and prove the win against the benchmark baseline.
- **Out (single-node only):** fleet per-shard interval-index *fragments* and the cross-shard consistency vector are **DLR Stage 5** — not this slice. This stage changes only the in-process matcher; the wire protocol, the commit path, and every downstream consumer of `findAffectedByRanges` are untouched.
- **Out (later DLR stages):** row-level diffs (`CommitDiffer`), the drift checksum, `readLogSince`, client `MaterializedCache`. Stage 1 still re-runs each affected query and pushes full results exactly as today — it only changes *which* subscriptions are found, and how fast.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Cutover | **Replace outright.** The interval index is the only path; the old linear scan survives **only as the oracle** in a differential test. No flag, no dead runtime code. Reversible via git. |
| Signature | `findAffectedByRanges(writeRanges, writeTables): Subscription[]` is **unchanged** — same inputs, same result set (as a set), same dedup, same table-fallback semantics. |
| Structure | A **per-keyspace augmented interval tree** (treap keyed by `start`, augmented with subtree-max-`end`), with **deterministic hashed priorities** (no `Math.random`) so tree shape and tests are reproducible while staying balanced against sorted inserts. |
| Home | A generic **`IntervalIndex<V>`** in `packages/index-key-codec` (sibling to `KeyRange`/`RangeSet`; generic over `V` so the codec never knows about subscriptions). |
| Determinism | The matcher is a sync/invalidation concern, **not** a deterministic-replay query path — but we still avoid `Math.random` to keep tests reproducible. |

## 4. Architecture

### 4.1 `IntervalIndex<V>` — `packages/index-key-codec/src/interval-index.ts`

A generic collection of `KeyRange`s each carrying a value `V`, supporting fast overlap queries with incremental insert/delete.

```ts
export class IntervalIndex<V> {
  // Bucketed by keyspace: a write range can only overlap read ranges in the SAME keyspace.
  private readonly byKeyspace = new Map<string, IntervalTree<V>>();

  insert(range: KeyRange, value: V): void;
  remove(range: KeyRange, value: V): void;   // removes the entry matching (range bounds, value)
  queryOverlaps(range: KeyRange): V[];        // all values whose range overlaps `range`
  get size(): number;
}
```

Internals per keyspace: an **augmented interval tree** implemented as a treap.
- **Node:** `{ start: Uint8Array, end: Uint8Array | null, value: V, priority: number, maxEnd: Uint8Array | null, left, right }`.
- **Order key:** `start`, compared with `compareKeyBytes`; ties broken by `end` then by a stable value discriminator so `(start, end, value)` triples are addressable for `remove`.
- **Augmentation:** `maxEnd` = the maximum `end` over the subtree, where `null` (+∞) dominates any concrete key. Maintained on insert, delete, and rotation.
- **Priority:** a deterministic 32-bit hash of `(start bytes, end bytes, value)` — same entry always gets the same priority, so the tree is a deterministic function of its contents (reproducible tests) and balanced in expectation regardless of insertion order.
- **`queryOverlaps(q)`** — standard interval-tree search: at a node, prune the whole subtree when its `maxEnd` cannot reach `q.start` (i.e. `maxEnd` is a concrete key `<= q.start` under half-open `[start,end)` semantics; `null` maxEnd never prunes); otherwise test the node with `rangesOverlap` and recurse left always (starts below) and right when `node.start < q.end`. Collect matching values. O(log N + k).
- **Overlap test:** reuse `rangesOverlap` from `range.ts` verbatim — no new overlap math, so half-open `[start, end)` and `null`-end (+∞) semantics are identical to today.

`IntervalIndex` is exported from `packages/index-key-codec/src/index.ts`.

### 4.2 `SubscriptionManager` rewrite — `packages/sync/src/subscription-manager.ts`

State:

```ts
private readonly byKey = new Map<string, Subscription>();       // unchanged
private readonly byTable = new Map<string, Set<string>>();      // unchanged
private readonly byRange = new IntervalIndex<string>();          // NEW: value = subKey
private readonly tableFallbackKeys = new Set<string>();          // NEW: subKeys with empty readRanges
private readonly deserializedRanges = new Map<string, KeyRange[]>(); // NEW: subKey -> its read ranges, parsed once
```

- **`add(sub)`**: after populating `byKey`/`byTable` as today, if `sub.readRanges.length > 0` → for each range, `deserializeKeyRange(range)` **once**, store the parsed `KeyRange[]` in `deserializedRanges` under `subKey`, and `byRange.insert(keyRange, subKey)`; else → `tableFallbackKeys.add(subKey)`. The `Subscription` interface is **not** modified (the parsed ranges live only in the manager's private `deserializedRanges` map), so no shared type changes.
- **`removeKey(key)`**: for each `KeyRange` in `deserializedRanges.get(key)` (if any), `byRange.remove(keyRange, key)`; then `deserializedRanges.delete(key)` and `tableFallbackKeys.delete(key)`; then the existing `byTable`/`byKey` cleanup.
- **`findAffectedByRanges(writeRanges, writeTables)`**:
  1. For each write range: `deserializeKeyRange` **once**, `byRange.queryOverlaps(writeKeyRange)` → add each returned subKey to a result `Set<string>`. *(This exactly reproduces today's "range subs match by overlapping range only" branch.)*
  2. For the table-fallback path: for each table in `writeTables`, take `byTable.get(table)` ∩ `tableFallbackKeys` → add those subKeys. *(This exactly reproduces today's "empty-readRanges subs match by table only" branch.)*
  3. Map the collected subKeys back through `byKey` → return the deduped `Subscription[]`.

Every other method (`findAffectedByTables`, `forSession`, `removeSession`, `get`, `size`) is unchanged. `removeSession` must still purge `byRange`/`tableFallbackKeys` (it routes through `removeKey`, so this is automatic).

## 5. Semantic equivalence (what MUST NOT change)

The result of `findAffectedByRanges` must be, for every input, the **same set** of subscriptions the linear scan returns today:
- A range-bearing sub matches **iff** a write range overlaps one of its read ranges (never by table).
- An empty-`readRanges` sub matches **iff** a write *table* is in its `tables` (never by range).
- Each matching sub appears exactly once (dedup).
- `writeTables` still drives only the fallback path; `writeRanges` still drives only the range path.

## 6. Correctness strategy: the differential oracle test

The retired linear scan is preserved **as a test-only oracle** (a local `bruteForceFindAffected(subs, writeRanges, writeTables)` mirroring the current logic). The property test:

1. Generates a random population: keyspaces (few, so collisions happen), and subscriptions mixing point ranges (`addKey`), prefix ranges, wide/overlapping ranges, full-keyspace ranges (`start=∅, end=null`), and empty-`readRanges` fallback subs with random `tables`.
2. Interleaves random `add`/`remove` operations to exercise churn.
3. For random write inputs (`writeRanges` + `writeTables`), asserts `set(manager.findAffectedByRanges(...)) === set(bruteForce(...))`.
4. Runs many randomized iterations (seeded/deterministic generation so failures reproduce).

Plus focused unit tests on `IntervalIndex` directly: stabbing a point that lands inside/at-boundary of a range (half-open correctness), overlapping and nested ranges, `null`-end (+∞) ranges, multiple values on identical bounds, and insert/remove churn leaving `size` and query results correct.

The existing `packages/sync` handler/subscription tests must pass unchanged (semantics preserved).

## 7. Acceptance gate (the benchmark)

Same-machine, back-to-back ratios (per the harness discipline — Docker/ratios, never absolutes):

1. On `main`: `bun run build && bun run bench:reactive --save benchmarks/baselines/reactive-main.json`.
2. On this branch, same sitting: `bun run bench:reactive --baseline benchmarks/baselines/reactive-main.json`.

**Success:**
- `fanout-selective-10000` `propP50Ms` collapses from ~7.7 ms toward the `fanout-selective-100` level (~0.3 ms) — matching becomes ~flat in subscription count. This is the headline gate.
- `fanout-selective-1000` likewise improves; `fanout-selective-100` unchanged (already cheap).
- `fanout-broadcast-*` stays within noise — broadcast is inherently O(k=N) *output* (all N subs genuinely fire), which no matcher index can or should reduce.
- No scenario regresses beyond the ±3% band on either store (SQLite and embedded-Postgres).

If the selective-10k row does **not** move materially, Stage 1 has not delivered and the design is revisited before merge (benchmark-first discipline, as with B4 group commit).

## 8. Testing summary

| Layer | Test |
|---|---|
| `IntervalIndex` unit | stabbing, overlap, nesting, null-end, boundary (half-open), churn |
| `SubscriptionManager` | differential oracle (indexed == brute-force) over randomized populations + churn |
| Regression | existing `packages/sync` tests pass unchanged |
| Performance | `bench:compare` selective-10k collapse; no >3% regression elsewhere |

## 9. Risks

- **Interval-tree bugs** (rotation/augmentation/half-open boundaries) — concentrated in one small module and **neutralized by the differential oracle** (any divergence from the brute-force result fails the test).
- **Removal addressing** — `remove(range, value)` must delete the exact entry, not any overlapping one; the `(start, end, value)` discriminator + churn tests cover this.
- **Fallback-path fidelity** — the `byTable ∩ tableFallbackKeys` restriction must exactly mirror today's "empty-readRanges → table match" branch; the oracle test's fallback subs cover it.
- **`null`-end (+∞) in the augmentation** — handled by treating `null` maxEnd as never-prunable; unit-tested explicitly.

## 10. Provenance

Grounded in the current `packages/sync/src/subscription-manager.ts` + `packages/index-key-codec/src/range.ts`, the DLR design (§4.1), and the benchmark baseline captured 2025-11-28. Correctness rests on the retired linear scan as an oracle; the win is proven by the harness, not asserted.
