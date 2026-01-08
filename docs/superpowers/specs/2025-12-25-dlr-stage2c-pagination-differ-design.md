# DLR Stage 2c — The Key-Range-Pinned Pagination Differ

> **Status:** approved design (2025-12-25), ready for an implementation plan.
> **Parent:** [`docs/dev/architecture/reactivity-differential-log-tail.md`](../../dev/architecture/reactivity-differential-log-tail.md) §4 (line 106 lists **"pagination with known boundary keys"** as DIFFABLE). Builds on **2b — the single-index-range `collect()` differ** (shipped v1.1.0).
> **Position:** the third and final query-shape slice of DLR Stage 2. 2a = by-id `get`; 2b = single-index-range `collect()`; **2c = a paginated query's page**.

---

## 1. Motivation & strategy

A `.paginate()` query re-runs the whole page and re-sends it on every relevant write (the RERUN path). 2c makes a page receive incremental row diffs instead — reusing 2b's range differ **verbatim**.

The design turns on one modeling decision, taken from the reference (Convex) and confirmed by our own DLR doc:

**Pin each page by its KEY BOUNDS, not by a row count.** After the initial `paginate({cursor, pageSize})` load, the page occupies a fixed key interval `[startBound, endBound)` (`startBound` = the input cursor's successor, `endBound` = the returned `nextCursor`'s key, or +∞ on the last page). Reactively, that page IS a fixed-key-range `DIFFABLE` query — identical in shape to a 2b range `collect()`, just with a two-sided bound instead of a single `.eq(...)`.

This **dissolves the pull-in problem** that a count-bounded ("first N rows") page has. In a count-bounded page a delete forces an unknown neighbor row to pull in from beyond the page (a store read DLR forbids). In a key-bounded page there is no "top N" — the page is *all rows in `[startBound, endBound)`* — so:
- an **insert** in-bounds → `add` (the page simply grows past its initial `pageSize`),
- a **delete** in-bounds → `remove` (the page shrinks),
- an **edit** in-bounds → `edit`, a **move** in-bounds → `edit` with a new `orderKey`,
- a write **out of bounds** → no-op.

**Every** write is diffable, with **zero store reads** — 2b's `rangeChangesFor` applies directly. The only semantic change: a page's row count drifts from its initial `pageSize` under live edits. This is *correct* reactive-pagination behavior — exactly what Convex does (its `splitCursor`/`SplitRecommended` rebalances a page that grows unboundedly), and what a live feed wants (new items appear; deleted items vanish; the page boundary stays put so page N+1 stays contiguous).

Feasibility (verified against the code):
- **The end boundary already exists.** `QueryRuntime.paginate` returns `nextCursor` = the last included row's key (`lastIncluded`); the recorded read-set is `[interval.start, successor(peekRow))` (non-last page) or the full interval (last page). So `[startBound, endBound]` is known after the first load. The read-set is slightly wider than the page bounds (it peeks one row past `endBound`); that only causes a few harmless no-op invalidations, never a missed one.
- **The differ is 2b's.** `rangeChangesFor(range, prevMap, writtenDocs)` already does membership over a `RangeRead`'s `bounds` (a `SerializedKeyRange`) + filters + `orderKey`. A page is a `RangeRead` whose `bounds` are two-sided. No new differ.
- **The client cache is 2b's, wrapped.** `renderRangeValue` sorts the row-map into an array; a page renders `{ page: <that array>, nextCursor, hasMore, scanCapped }` — the pagination metadata is captured once and stays fixed (see §4.4).
- **Resume + checksum + `orderKey` + the passthrough-identity brand** all carry over unchanged from 2b.

## 2. Scope

- **In:** a single-index `.paginate({cursor, pageSize})` query whose result the handler returns **unmodified** takes the diff path: a `DIFFABLE_PAGE` classifier (a paginate passthrough capturing the page's `[startBound, endBound]` key interval + filters + order + the fixed `nextCursor`/`hasMore`/`scanCapped` metadata), the range CommitDiffer applied over those two-sided bounds, a client renderer that reconstructs the `{ page, nextCursor, hasMore, scanCapped }` object, and a `diffbytes-paginate` benchmark scenario. `.where()` filters and any `order` carry over from 2b.
- **Out (deferred):** **page rebalancing / `splitCursor`** — a page that grows unboundedly under heavy in-bounds inserts is accepted as-is in v1 (rendered whole); Convex-style split-recommendation is an advisory follow-up. A `pageSize`/`maxScan` **cap that re-pages** on growth is out of scope. The `overlay` (read-your-own-writes) paginate path inside a mutation is unaffected (it's not a subscription).
- **Out (later DLR stages):** log-tail catch-up (Stage 3), optimistic-over-diffs (Stage 4), fleet per-shard fragments (Stage 5).
- **Untouched:** the 2a by-id path, the 2b range-collect path, and the RERUN full-result path all remain exactly as shipped. A paginate query that isn't a clean single-index passthrough (multi-read, read policy, post-processed result) → RERUN.

## 3. Locked decisions

| Decision | Choice |
|---|---|
| Page model | **Key-bounded, not count-bounded.** Pin `[startBound, endBound)` after the initial load; reactively the page is a fixed-key-range DIFFABLE query. (Reference-confirmed: Convex `(cursor, continueCursor]`; DLR doc "known boundary keys".) |
| Differ | **Reuse 2b's `rangeChangesFor`** over a two-sided `bounds`. No new diff logic; the page's `RangeRead.bounds` just has a real `start` AND `end`. |
| Page-size drift | A page grows/shrinks from its initial `pageSize` under live edits — correct reactive semantics. Unbounded-growth rebalancing (`splitCursor`) is deferred. |
| Metadata | `nextCursor`/`hasMore`/`scanCapped` are captured at classification and stay **fixed** for the life of the pinned page (the boundary doesn't move). Only `.page` diffs. Carried on the `QueryDiff` reset. |
| Passthrough | Reuse 2b's **identity brand**: `paginate()` brands the `PaginationResult` object it returns; `DIFFABLE_PAGE` classifies only when the handler returns that exact branded object. Any transform (`{...result}`, `result.page`, mapped page) → RERUN. |
| Fallback | Any classification/diff uncertainty, `writtenDocs` absent (fleet/forwarded), or a page whose `endBound` can't be pinned → RERUN. |

## 4. Architecture

### 4.1 Classification — `DIFFABLE_PAGE` (executor + `packages/sync`)

Extend the executor's diffable classification (2b's `classifyDiffableRange`) with a paginate arm. During a query run, the `db.paginate` syscall records a paginate trace analogous to the collect trace: `{ keyspace, startBound, endBound, filters, order, fields, brand-token, nextCursor, hasMore, scanCapped }`. `startBound`/`endBound` come from the resolved scan interval + `nextCursor` (or the full interval on the last page). After the handler returns, the run is `DIFFABLE_PAGE` iff: exactly one `db.paginate` (no other read syscall), no read policy, and the returned value is the branded `PaginationResult` for that paginate, unmodified. The executor surfaces a `DiffablePage` (structurally a `DiffableRange` with two-sided `bounds`, plus the fixed `{ nextCursor, hasMore, scanCapped }`). The sync tier records it on the `Subscription` as `range` (the existing field — a page is a range) plus a small `pageMeta`.

### 4.2 The differ (server, `packages/sync/src/commit-differ.ts`)

**No new function.** `rangeResetChanges(range, orderedPageRows, ts)` builds the seed map from the initial page's rows; `rangeChangesFor(range, prevMap, writtenDocsForTable)` computes the incremental diff — both already handle a `RangeRead` with two-sided `bounds` (membership is `inBounds(key, bounds) ∧ passesFilters`). The per-sub result-set map (2b's `byIdRowMap`) holds the page's rows. A page that grows simply has a larger map.

### 4.3 Wire (`packages/sync/src/protocol.ts`)

Reuse `QueryDiff`. The **reset** descriptor gains a `page` variant: `reset?: true | { mode: "byid" } | { mode: "range"; orderDir } | { mode: "page"; orderDir; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }`. Incremental diffs stay row-only (no `reset`) — the metadata is fixed, so it never needs re-sending. `hash` (resume) carries over.

### 4.4 Client (`packages/client/src/layered-store.ts`)

Add a `"page"` render mode. On the reset, store `renderMode = "page"`, `orderDir`, and the fixed `pageMeta = { nextCursor, hasMore, scanCapped }`. `renderPageValue(rows, orderDir, pageMeta)` = `{ page: renderRangeValue(rows, orderDir), nextCursor: pageMeta.nextCursor, hasMore: pageMeta.hasMore, scanCapped: pageMeta.scanCapped }` — a fresh object each apply (fires listeners). The by-id/range modes are unchanged. `applyDiff`'s clear-on-reset (2b) applies as-is.

### 4.5 Resume + checksum + passthrough

All 2b: the drift checksum folds `orderKey` (unchanged — the page's rows are the checksum domain; the fixed metadata isn't part of it, which is sound because it never changes); `QueryUnchanged` resume works (the page's fingerprint is over its rows); the passthrough-identity brand is extended from the collect array to the `PaginationResult` object.

## 5. Correctness strategy

- **Server differential oracle (primary net):** for a `DIFFABLE_PAGE` sub, `wrap(sort(applyChanges(oldMap, rangeChangesFor(...))), pageMeta)` must equal a fresh `paginate` re-run over the pinned `[startBound, endBound]` bounds — a property test over randomized in-bounds insert / update / delete / move / filter-cross / **out-of-bounds (no-op)** sequences. (Same discipline as 2b's range oracle, which this extends.)
- **Classifier tests:** a pure single-index `.paginate()` returned unmodified → `DIFFABLE_PAGE` (bounds + metadata captured); a post-processed result (`result.page`, `{...result}`), a read-policy table, a multi-read handler → RERUN.
- **Client tests:** `renderPageValue` reconstructs `{ page, nextCursor, hasMore }`, page grows on `add` / shrinks on `remove` / re-sorts on move; a fresh object each apply; empty page renders `{ page: [], ...metadata }`.
- **E2E through the real dev server** (`packages/cli/test/`): a paginated subscription (a) gets a `QueryDiff` `page`-reset on subscribe (not `QueryUpdated`), carrying the correct `nextCursor`/`hasMore`; (b) an in-bounds insert grows the page via an incremental `QueryDiff` at the right sorted position; (c) an in-bounds delete shrinks it; (d) an edit/move updates in place; (e) an **out-of-bounds** write (beyond `endBound`) does NOT change the page; (f) checksum self-heal; (g) old-client back-compat (`QueryUpdated`).
- **Regression:** the 2a/2b/RERUN suites pass unchanged.

## 6. Acceptance gate (a benchmark, like 2b)

- `bench:reactive` gains a **`diffbytes-paginate`** scenario (a page subscription of ~20 rows under a write stream); its `bytesPerUpdate` must collapse from the full-page re-send (~2.6 KB, the `diffbytes-scan` order) to roughly one row's worth, mirroring 2b — with **no regression** on `diffbytes-point`/`diffbytes-scan`/`fanout-*`/`propagation-*`.
- The server oracle proves diff+apply(wrapped) ≡ re-run over the pinned bounds across the randomized sequences.
- The E2E proves a real page `QueryDiff` round-trip (reset + each incremental kind + out-of-bounds no-op + self-heal + old-client compat) through the dev server.
- Full monorepo + typecheck green.

## 7. Risks

- **Unbounded page growth.** Heavy in-bounds inserts grow a pinned page without limit (no `splitCursor` in v1). Mitigation: accepted as correct-but-unbounded for v1; document it; `splitCursor`-style rebalancing is the named follow-up. A `maxPageRows` safety cap that degrades to RERUN is a cheap optional guard if we want a ceiling.
- **Read-set wider than page bounds.** The recorded read-set peeks one row past `endBound`; a write at that peek row wakes the sub but is out-of-bounds → the differ no-ops it. Harmless (a few extra wakes), never a missed diff. Confirm the differ's `inBounds` uses the PAGE bounds (`endBound`), not the wider read-set.
- **Metadata staleness.** `nextCursor`/`hasMore` are pinned at load and never updated. Sound because the boundary is a fixed key — page N+1 (starting at `endBound`) stays contiguous regardless of in-bounds edits. The one edge: if `hasMore` was `false` (last page) and rows are later inserted *beyond* the (then-open) end — but the last page's `endBound` is +∞, so those are in-bounds and diffed in. Consistent.
- **Object-return passthrough.** A paginate handler returns an object, not an array; the identity brand must be on the `PaginationResult` and survive the executor's value path uncloned (as 2b's array brand does). Guarded by the classifier tests.
- **Fleet/forwarded** (no `writtenDocs`) → RERUN, same as 2b.

## 8. Provenance

Grounded in `.reference/convex-backend/npm-packages/convex/src/server/pagination.ts` (the `(cursor, continueCursor]` key-bounded page + `splitCursor` model), `docs/dev/architecture/reactivity-differential-log-tail.md` line 106 ("pagination with known boundary keys" = DIFFABLE), `packages/query-engine/src/query-runtime.ts` (`paginate` — `nextCursor`/`lastIncluded`/read-set), and the entire 2b pipeline (`classify.ts`/`commit-differ.ts`/`change.ts`/`layered-store.ts`) which this reuses with a two-sided bound + an object wrapper. The `diffbytes-paginate` gate mirrors 2b's `diffbytes-scan`.
