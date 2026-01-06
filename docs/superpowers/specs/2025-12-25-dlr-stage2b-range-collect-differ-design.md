# DLR Stage 2b — The Single-Index-Range `collect()` Differ

> **Status:** approved design (2025-12-25), ready for an implementation plan.
> **Parent:** [`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md) §4.2–4.4/4.6 (Stage 2). Builds on **2a — the by-id diff pipeline skeleton** (shipped `03f6a92`).
> **Position:** Stage 2 is decomposed into vertical slices by query shape. 2a shipped the whole pipeline on the trivial `db.get(id)` shape. **This is 2b — the single-index-range `collect()` shape**, the one the benchmark actually measures (`diffbytes-scan`). 2c handles pagination.

---

## 1. Motivation & strategy

2a built the entire DLR row-diff pipeline (`Change` vocab + shared `applyChanges`/`driftChecksum` · written-docs through the fan-out · classifier · CommitDiffer · `QueryDiff` wire · client `MaterializedCache` + capability negotiation) but only exercised it on `db.get(id)`, where a write's new value simply *is* the query's new value. **2b reuses that entire pipeline verbatim and only adds the harder differ** — the one that turns a commit's written docs into a row diff over an *ordered list* result.

This is the slice where the win becomes measurable. A single-index-range `collect()` today re-runs the query and re-sends the **whole list** on every write (`bench:reactive` `diffbytes-scan` ≈ **2647 bytes/update** for a 20-row channel). 2b sends **just the changed row(s)** — so unlike 2a (whose gate was correctness-only, since by-id doesn't change wire bytes), **2b's acceptance gate IS a benchmark delta**.

**Scope decision (2025-12-25):** DIFFABLE_RANGE includes collect()s with the engine's declarative **structured `.where()` filters** (`.where(op, field, value)`), not just unfiltered range scans. This engine's `QueryBuilder` (`packages/executor/src/guest.ts`) has NO opaque JS `.filter(fn)` — filters are serialized comparison ops the engine applies during the scan, so the differ can re-apply them to a written doc **with no store read**. `.take(n)`/limit, `paginate`, ordered-top-N, and any **JS post-processing of the collect result in the handler** remain RERUN.

Feasibility (verified against the code):
- **Per-write index keys already exist at commit.** `packages/executor/src/kernel.ts:299–305` computes `extractIndexKey(oldDoc, idx.fields)` / `extractIndexKey(newDoc, idx.fields)` and `indexKeyspaceId(...)` for every index on every write (that is how `writtenRanges` — the Stage-1 matcher's index-keyspace ranges — are built). So the differ can compute a written doc's index-key position from `newRow` + the catalog's index field list, reusing `extractIndexKey`/`encodeIndexKey`/`compareKeyBytes`. No new key machinery.
- **Old membership needs no old row value.** The server holds a per-sub result-set map (2a's `byIdRowMap`, generalized). `map.has(docId)` *is* the "was in the result before" oracle — so the differ never needs the old doc or old-filter re-eval, exactly as 2a sidestepped it for the 0-or-1 case.
- **The client can order.** `compareKeyBytes`/`deserializeKeyRange` are exported from `@stackbase/index-key-codec` (already a client dep via classify). The client renders the ordered array by sorting its row-map on a carried index-key.
- **The wire is unchanged.** `QueryDiff{queryId, changes, checksum}` already carries `Change[]`; `Change` gains one optional field.

## 2. Scope

- **In:** a single-index-range `.collect()` (with optional structured `.where()` filters, any `.order()` direction) whose result the handler returns **unmodified** takes the diff path: a `DIFFABLE_RANGE` classifier, a range CommitDiffer (add/edit/remove/move via membership), an `orderKey` on the `Change` vocab, client range rendering (sorted), and the drift checksum extended to fold `orderKey`.
- **Out (later slices):** pagination-boundary diffs (**2c**). `.take(n)`/limit and ordered-top-N (a write near the boundary can push out the boundary row → needs a store read, per arch doc §RERUN) stay RERUN. Any handler that **post-processes** the collect result in JS (`.filter`/`.map`/`.slice`/re-sort) or performs any additional read stays RERUN.
- **Out (later DLR stages):** log-tail catch-up / `readLogSince` (Stage 3), optimistic-over-diffs (Stage 4), fleet per-shard fragments (Stage 5).
- **Untouched:** the entire 2a by-id path and the RERUN full-result path — both remain exactly as shipped.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Slice shape | Single-index-range `collect()` — the benchmark-measured shape; the diff win is real here (unlike 2a). |
| Filter scope | Include structured `.where()` filters (differ re-applies the SAME engine evaluator to each written doc). JS post-processing → RERUN. |
| Old-state oracle | The server's per-sub **result-set map** (`Map<docId, {row, orderKey, ts}>`), generalizing 2a's `byIdRowMap`. `map.has(docId)` = old membership. No old row value, no old-filter re-eval. |
| Ordering | `Change.add`/`edit` carry an optional **`orderKey`** (base64 index-key bytes; the engine's composite index key already appends the primary key, so it is fully orderable even for non-unique indexes). Client sorts the row-map by `orderKey` via `compareKeyBytes`, honoring order direction. |
| Checksum | Extend the drift fold to `(key, ts, orderKey)` so a missed **move/reorder** (orderKey changed, value/ts may not signal it) is caught — not just a value change. By-id passes `orderKey = ""`, so 2a's checksum is unchanged in effect. |
| Passthrough guard | The classifier tags DIFFABLE_RANGE **only if the executor confirms the handler returned exactly the one collect syscall's ordered docs, unmodified** (§4.1). This is correctness-critical — the drift checksum does NOT catch a wrongly-diffed post-filtered handler (both sides agree on the same wrong set). |
| Fallback | Any classification/diff uncertainty, and any commit whose `writtenDocs` are absent (fleet/forwarded), degrade to RERUN — the always-available oracle. |

## 4. Architecture

### 4.1 Classification — `DIFFABLE_RANGE` (server, `packages/sync`)

Extend the classifier (currently `classifyByIdRead`) so `execSub` can return a `RangeRead` classification. A sub is `DIFFABLE_RANGE` iff **all** hold:

1. **Exactly one read-range, in an *index* keyspace** (`index:<enc>`), not the primary `table:` keyspace and not multiple ranges.
2. **No limit / no pagination** — the query had no `.take(n)` and this was a `collect`, not a `paginate`.
3. **Passthrough** — the handler's returned value is byte-identical (same ordered doc-ids) to the single `db.query` syscall's output. Enforced by the executor surfacing, per subscription run, whether "exactly one `db.query` collect ran, no other reads, and the return value === its docs." Any JS post-processing, or any additional read (a second collect, a `db.get`), fails this and the sub is RERUN. **Rationale:** the read-ranges only *over-approximate* an imperatively post-filtered result (arch doc §2); a checksum can't catch it because the server differ and the client would compute the same wrong set — so it must be excluded at classify time.

The `RangeRead` records on the `Subscription`: the index `keyspace`, the serialized range **bounds** (start/end), the **structured filters** (the `.where()` ops, serialized), and the **order** direction. (The structured filters are already in the serialized query; the executor threads them out alongside `readRanges`.)

`.where()`-less collects are the degenerate case (empty filter list) — same path.

### 4.2 The range differ (server, `packages/sync/src/commit-differ.ts`)

Generalize the per-sub state from 2a's `byIdRowMap` (0-or-1 rows) to a **result-set map** `Map<docId, RowVersion & { orderKey: string }>`. `RowVersion` stays `{ row, ts }`; the differ tracks `orderKey` alongside for ordering + checksum.

`rangeChangesFor(rangeRead, prevMap, writtenDocsForTable)`:
- For each `WrittenDoc` whose table matches the sub's table:
  - Compute `newKey = extractIndexKey(newRow, idxFields)` (via the catalog's index def for `rangeRead.keyspace`); `newOrderKey = base64(newKey)`.
  - **member-after** = `newRow !== null` ∧ `inBounds(newKey, rangeRead.bounds)` ∧ `passesFilters(newRow, rangeRead.filters)`.
  - **member-before** = `prevMap.has(docId)`.
  - Emit: `!before ∧ after` → `add`(row, ts, orderKey); `before ∧ after` → `edit`(row, ts, orderKey) — a *move* is just an edit whose orderKey differs; `before ∧ !after` → `remove`(key); else no-op.
- Return `{ changes, next }` (via `applyChanges`, which is unchanged — it is keyed, order-independent; `orderKey` rides on the change and is stored in the map).
- **Reuse the engine's own filter evaluator** for `passesFilters` (the same code path the scan uses) — never a reimplementation, or the differ and `execSub` could diverge on filter semantics.

`rangeResetChanges(rangeRead, orderedDocs, ts)` — the initial subscribe answer: one `add` per doc in `execSub`'s ordered result (each with its `orderKey`), building the seed map. Mirrors 2a's `byIdResetChanges` (which is the 0-or-1 special case).

### 4.3 The `Change` ordering key (shared, `packages/sync/src/change.ts`)

```ts
export type Change =
  | { t: "add"; key: string; row: JSONValue; ts: number; orderKey?: string }
  | { t: "remove"; key: string }
  | { t: "edit"; key: string; row: JSONValue; ts: number; orderKey?: string };

export interface RowVersion { row: JSONValue; ts: number; orderKey?: string }
```

`applyChanges` stores `orderKey` into the map entry (one line). `driftChecksum` folds `hash(key) ⊕ ts ⊕ hash(orderKey ?? "")` — order-independent XOR, now sensitive to a moved row. By-id changes omit `orderKey` (→ `""`), so the by-id checksum value is unchanged.

### 4.4 Client `MaterializedCache` (`packages/client`)

`LayeredQueryStore.applyDiff` is unchanged (it already applies keyed changes + recomputes the checksum). The `Subscription` gains a **render descriptor** — `{ mode: "byid" | "range"; orderDir?: "asc" | "desc" }` — that MUST be carried explicitly on the `QueryDiff` **reset** (an empty range result has no rows to infer the mode/order from, so it cannot be inferred; see §4.5). Add:

```ts
function renderRangeValue(rows: Map<string, RowVersion>, orderDir: "asc" | "desc"): Value {
  const entries = [...rows.values()].sort((a, b) => compareKeyBytes(decode(a.orderKey), decode(b.orderKey)));
  if (orderDir === "desc") entries.reverse();
  return entries.map((e) => jsonToConvex(e.row)) as Value; // a fresh array each apply (recompose fires)
}
```

`applyDiff` picks `renderByIdValue` vs `renderRangeValue` by the sub's recorded mode. An empty range renders `[]` (a range value is always an array, never `undefined` — distinct from by-id, where an absent doc renders `undefined`). The array is a fresh reference each apply (the byte-identity invariant that fires `recompose` — same as 2a's by-id render).

#### 4.5 Wire + drift + resync

No new `StateModification` — `QueryDiff` is reused; `Change` gains `orderKey`, and the `QueryDiff` **reset** gains an optional render descriptor `{ mode: "byid" | "range"; orderDir?: "asc" | "desc" }` (present only on a reset — the first answer to a subscribe/resync; absent on incremental diffs). An old client that predates 2b ignores unknown fields; a 2a-only client never sees `mode: "range"` because it only ever subscribed to by-id shapes. The drift checksum + scoped resync are 2a's, unchanged in mechanism; a range sub that drifts resyncs exactly as a by-id sub does (re-subscribe → fresh ordered reset that re-establishes `mode`/`orderDir`).

## 5. Correctness strategy

- **Server differential oracle (the primary net):** for a `DIFFABLE_RANGE` sub, `sort(applyChanges(oldMap, rangeChangesFor(...)))` must equal a fresh `execSub` collect (ordered) — a property test over randomized sequences of **insert / update-in-place / delete / move (index-key change within range) / cross-in / cross-out (a `.where()` predicate or range boundary that a write crosses)**. Same oracle discipline that de-risked Stage 1 and 2a.
- **Classifier tests:** unfiltered collect → RANGE; `.where()` collect → RANGE (filters + order recorded); `.take`/`paginate`/JS-post-filtered-handler/second-read handler → RERUN. Explicitly test that a handler doing `(await q.collect()).filter(...)` is RERUN (the checksum-blind hazard).
- **`applyChanges`/checksum unit tests:** orderKey stored + folded; a move (same key, new orderKey) changes the checksum and re-sorts; by-id (no orderKey) checksum unchanged from 2a.
- **Drift self-heal:** a forced checksum mismatch on a range diff triggers exactly one scoped resync and recovers (reuses 2a's path).
- **E2E through the real `stackbase dev` server** (`packages/cli/test/`): a range `collect()` subscription (a) gets an ordered `QueryDiff` reset on subscribe (not `QueryUpdated`), (b) an `insert` into the range arrives as an incremental `add` at the correct sorted position, (c) an in-range `edit`, a `remove` (delete or filter-cross-out), and a **move** each arrive as the right incremental change, (d) a write that a `.where()` predicate excludes never reaches the client, (e) forced-drift self-heal, (f) old-client back-compat (no `supportsQueryDiff` → `QueryUpdated`).
- **Regression:** the full 2a by-id suite + the RERUN suites pass unchanged.

## 6. Acceptance gate

**Unlike 2a, 2b's gate IS a benchmark delta.** 2b passes when:
- `bench:reactive` shows **`diffbytes-scan` bytesPerUpdate collapses** from ≈2647 B to roughly one row's worth (a single-row diff frame), with **no regression** on any other scenario (by-id, fanout-selective, propagation — the RERUN and 2a paths are untouched). Measured via `bench:reactive` + a same-session baseline compare.
- The server oracle proves diff+apply (sorted) ≡ re-run over the randomized move/filter-cross sequences.
- The E2E proves a real range `QueryDiff` round-trip (reset + each incremental kind + filter-exclusion + self-heal + old-client compat) through the dev server.
- Full monorepo + typecheck green.

## 7. Risks

- **Passthrough misclassification** (the checksum-blind hazard, §4.1) — a JS-post-filtered handler wrongly tagged DIFFABLE_RANGE renders wrong data *silently*. Mitigation: the executor-confirmed "returned value === the one collect's ordered docs" gate; conservative — any doubt → RERUN. Guarded by an explicit classifier test.
- **Read-set shape** — the classifier assumes a `collect` over an index records **exactly one index-keyspace range**. If the MVCC collect also records per-row primary-key point reads (for the doc fetches), the classifier's "exactly one range" test must be refined to "exactly one *index* range, ignoring primary-key fetch points" (or the read-set model changes). **Plan Task 1 verifies the exact recorded read-set of a filtered/unfiltered collect before the classifier is written.**
- **Filter-evaluator divergence** — `passesFilters` MUST call the engine's own predicate evaluation, not a reimplementation, or the differ's membership can disagree with `execSub`. Mitigation: reuse the shared evaluator; the oracle test catches any divergence.
- **Move semantics** — an index-key change that keeps a doc in range is an `edit` with a new `orderKey`; the checksum folds `orderKey` so a missed move is caught. Guarded by the oracle's move case.
- **Order direction + render mode on the client** — the client must know range-vs-byid and asc/desc to render, and cannot infer them from an empty result. The checksum is order-independent (XOR by design), so it does NOT catch a wrong direction — the descriptor must be delivered explicitly and tested, not left to drift. **The `QueryDiff` reset carries `{ mode, orderDir }` (§4.5).**
- **Result-set map size** — per-sub server state now holds the whole result set (not 0-or-1). Bounded by what the client holds anyway; ephemeral, dropped on unsubscribe; NOT a durable CVR (DLR forbids that). Same story as 2a §7, at list scale.
- **Fleet/forwarded** — no `writtenDocs` → affected range subs fall back to RERUN for that commit, exactly as 2a.

## 8. Provenance

Grounded in `packages/executor/src/guest.ts` (the declarative `QueryBuilder` — `.where`/`.order`/`.take`, no JS filter), `packages/executor/src/kernel.ts:299–305` (per-write index-key computation already at commit), `packages/sync/src/classify.ts` + `commit-differ.ts` + `change.ts` (the 2a pipeline this extends), `packages/client/src/layered-store.ts` (`applyDiff` + the render seam), `@stackbase/index-key-codec` (`extractIndexKey`/`encodeIndexKey`/`compareKeyBytes`), and the DLR design §4.2–4.4/4.6. The row-diff-from-write-entries approach and the RERUN oracle are the arch doc's prescription (§4.1 table). The benchmark `scan` shape (`benchmarks/runner/src/cores/fanout.ts:40`) is the exact `.eq(...).collect()` this slice diffs.
