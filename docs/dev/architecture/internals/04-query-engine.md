---
title: Internals — Query Engine
status: extracted (clean-room notes; concave studied as reference)
---

# Query Engine

> Clean-room note: this document describes the contracts Stackbase will build,
> using concave (FSL-1.1-Apache-2.0) only as a reference for understanding the
> Convex-compatible query semantics. Type and method names below are our own
> restatement of the observed shapes; nothing here is copied verbatim. Where we
> cite concave, it is to anchor a behavioral expectation, not to reproduce code.

## Purpose & relationship to Convex query API

The query engine is the layer that turns a serialized Convex-style query
(`db.query(table).withIndex(...).filter(...).order(...).paginate(...)`) into
actual storage scans, and — critically — records *exactly which key ranges were
read* so the reactivity layer can invalidate the right subscriptions when those
ranges change.

The Convex developer API surface that we must honor:

- `q.eq / q.gt / q.gte / q.lt / q.lte` index bound expressions inside
  `withIndex`, plus `q.and / q.or / q.not` and arithmetic operators inside
  `.filter(...)`.
- `.withIndex(name, rangeBuilder)` — selects an index and constrains a prefix of
  its fields.
- `.order("asc" | "desc")` — scan direction.
- `.filter(predicate)` — a post-filter that runs in the engine but *not* as an
  index bound.
- `.paginate({ numItems, cursor })` / `.take(n)` / `.first()` / `.unique()` /
  `.collect()` — materialization with optional pagination.

In the reference, this maps onto two cooperating module groups:

- `queryengine/*` — the low-level mechanics: index range execution
  (`index-query`), the index key codec (`indexing/index-key-codec`), index
  maintenance (`indexing/index-manager`), read/write set tracking
  (`indexing/read-write-set`), cursor encoding (`cursor`), filter evaluation
  (`filters`), and developer-ID parsing (`developer-id`).
- `query/*` — the higher-level orchestration: planning (`planner`), the runtime
  that executes a plan against the docstore (`query-runtime`), post-processing
  and ordering (`postprocess`, `execution`), search/vector actions (`actions`),
  and the shared plan/result types (`types`).

## Index model & index-key encoding

Every index is defined by a name plus an ordered list of field paths. The
reference's `IndexDefinition` is simply `{ name, fields }`, where `fields` is an
ordered array such as `["author", "_creationTime", "_id"]`. Two observations
matter for us:

1. **Every index implicitly appends `_creationTime` and `_id`** (or at least
   `_id`) as trailing tiebreaker fields, so that the encoded key for any
   document is globally unique and totally ordered. This is what makes
   pagination cursors stable (see below). `getStandardIndexes()` in the
   reference returns the indexes that exist on *all* tables — minimally the
   by-`_creationTime` / by-`_id` ordering that backs an un-indexed table scan.

2. **Composite keys are encoded into a single byte string whose lexicographic
   byte order equals the logical sort order of the tuple.** This is the heart of
   the engine. Stackbase will build an order-preserving binary codec
   (`encodeIndexKey(values: Value[]) -> bytes`) with these properties:

   - Each value is prefixed by a **1-byte type tag**, and the tags are assigned
     so that the cross-type ordering matches Convex's total order:
     `null < boolean < number (float64) < bigint (int64) < string < bytes`.
   - Each value's payload is encoded so that **byte comparison reproduces value
     comparison** within a type: floats via an order-preserving transform of
     their IEEE-754 bits (flip sign bit for positives, invert all bits for
     negatives), bigints similarly sign-normalized, strings/bytes as their raw
     octets, booleans as a single 0/1 byte.
   - Concatenating the per-field encodings yields the composite key; because each
     field is self-delimiting via its tag/length discipline, prefix comparisons
     behave correctly (a shorter prefix sorts before any longer key sharing that
     prefix).

   The codec exposes companions: `compareIndexKeys(a, b) -> -1|0|1`,
   `indexKeysEqual(a, b)`, and the two range-construction helpers below.

**Range construction.** For a query that constrains the first *k* fields of an
index:

- `indexKeyRangeStart(values)` produces the **inclusive lower bound** — the
  exact encoded prefix.
- `indexKeyRangeEnd(values)` produces the **exclusive upper bound** for a prefix
  scan by appending a sentinel (a byte/tag strictly greater than any real
  successor), returning `null` to mean "unbounded to +infinity".

The translation from Convex range expressions to bounds is
`rangeExpressionsToIndexBounds(expressions, indexFields) -> { start, end|null }`.
Its job: walk the index fields in order, consume leading `Eq` expressions as
fixed prefix components, then fold a single trailing inequality
(`Gt/Gte/Lt/Lte`) into the open end of the start/end pair. `Eq` tightens both
ends; `Gte`/`Gt` move the start; `Lte`/`Lt` move the (exclusive) end. A
`RangeExpression` is `{ type: "Eq"|"Gt"|"Gte"|"Lt"|"Lte", fieldPath: string[],
value }`.

`extractIndexKey(doc, fields) -> bytes | null` produces the encoded key for a
document during writes; it returns `null` when a required field is absent, which
is how the engine decides a document is not present in a given index.

## Index manager

On every write the engine must keep all of a table's indexes consistent. The
reference centralizes this in `generateIndexUpdates(tableName, docId, newValue,
oldValue, indexes) -> DatabaseIndexUpdate[]`:

- For an **insert** (`oldValue === null`): for each index, compute
  `extractIndexKey(newValue, fields)` and emit an update that points the encoded
  key at the document.
- For a **delete** (`newValue === null`): for each index, emit a tombstone for
  the old key.
- For an **update**: compute both old and new keys per index; if they are equal,
  **emit nothing** (no-op optimization); otherwise emit a delete of the old key
  and an insert of the new key.

Each emitted `DatabaseIndexUpdate` is `{ index_id: hex, key: bytes, value }`
where `value` is either `{ type: "Deleted" }` or `{ type: "NonClustered",
doc_id }`. These updates are handed to the docstore's `write(...)` alongside the
document log entries, each tagged with the commit timestamp `ts`. Index entries
are therefore **MVCC-versioned just like documents** — a scan at timestamp `T`
sees the index entries that were live at `T`.

Stackbase will mirror this: a single `IndexManager.generateUpdates(...)` that the
transaction commit path calls once per written document, producing the batch of
keyed index mutations. The no-op-on-unchanged-key optimization is worth keeping
because it directly reduces both write amplification and reactivity churn.

## Query planning

`buildQueryPlan(query, schema, componentPath?) -> QueryPlan` lowers a serialized
query into one of three concrete plans (`QueryPlan` is a discriminated union on
`kind`):

- **`table-scan`** — `{ kind, query, tableName, fullTableName, order }`. No
  usable index; scan the whole table in `_creationTime`/`_id` order. Chosen when
  the query has no `withIndex`.
- **`index-range`** — `{ kind, query, tableName, fullTableName, indexDescriptor,
  indexFields, expressions: RangeExpression[], order }`. The query named an index
  and supplied bound expressions; these become the start/end interval.
- **`search`** — `{ kind, ..., searchTerm, filterMap, indexIdHex }`. Full-text
  search index; executed differently (see Actions).

`parseIndexName("table.index") -> { tableName, indexDescriptor }` splits the
wire-format index name (indexes arrive prefixed with their table).

The key planning distinction Stackbase must preserve is **index-bound predicates
vs. post-filters**:

- Predicates that can be expressed as a contiguous prefix of the chosen index's
  fields (leading equalities plus one trailing inequality) become the **scan
  interval** — they never load non-matching documents.
- Everything else (`.filter(...)` predicates, non-prefix conditions, disjunctions,
  arithmetic) becomes a **post-filter** evaluated per candidate document after it
  is read. The planner records the index `expressions` for the bound part; the
  residual filter travels in `query` and is applied during post-processing.

This split has a direct cost/reactivity consequence: only the index interval is
recorded as the read range (precise), whereas a post-filter still requires having
read every candidate in the interval (so the read set covers the whole interval,
not just the surviving rows).

## Execution & how reads become read-set ranges

`QueryRuntime` is the executor. Its public surface:

- `evaluate(query) -> any[]` — materialize all matching docs.
- `evaluatePaginated(query, cursor, limit) -> PaginatedResult` — one page.
- plus search/vector entry points and a visible-document cache + batched fetch
  (`getVisibleDocumentsForTable`, `getVisibleDocumentById`, and internal
  enqueue/flush batching) to de-duplicate and coalesce point reads.

Internally it dispatches on plan kind: `handleTableScan`, `handleIndexRange`,
`handleSearch`. The index-range path drives the docstore generator
`index_scan(indexId, tableId, readTimestamp, interval, order, limit?)`, which
yields `[indexKeyBytes, latestDocument]` pairs in encoded-key order (or reverse
for `Desc`). `executeIndexQuery(...)` wraps this with pagination and an
`onDocumentRead` callback fired for each materialized document.

**The reactivity tie-in is the whole point.** As the engine scans, it records the
*exact interval it depended on* into a `RangeSet` (read set):

- `addIndexRange(tableName, indexName, startKey, endKey|null)` — the contiguous
  encoded-key interval `[start, end)` actually scanned. `end === null` means the
  scan ran to +infinity (unbounded upper bound).
- `addDocument({ table, internalId })` — a point read, recorded as a degenerate
  interval `[key, key]` with `isPoint: true`.
- `addTableScan(tableId)` — a whole-table dependency (an interval spanning the
  entire table keyspace), used when there is no narrowing index.

Each `KeyRange` is `{ tableId, startKey, endKey|null, isPoint }`, where `tableId`
is a namespaced keyspace string: `table:<tableHex>` for the document/table
keyspace or `index:<tableHex>:<index>` for a specific index. Because the recorded
interval is expressed in the *same* order-preserving encoding the index uses, the
reactivity layer can later test whether a committed write's index key falls
inside any subscriber's interval by simple lexicographic comparison
(`compareArrayBuffers`) — that is the conflict/invalidation test for both OCC and
subscriptions. The same `RangeSet` representation thus serves double duty:
optimistic-concurrency conflict detection on commit and fine-grained
subscription invalidation.

`RangeSet` also offers `getRanges`, `getRangesByTable`, `getTables`, `size`,
`isEmpty`, `clone`, `replaceWith`, and `clear`. Ranges serialize to/from JSON
(`serializeKeyRange` / `deserializeKeyRange`, with bytes hex-encoded) so the read
set can cross the worker/storage boundary.

Crucially, **the read set covers the scanned interval, not just the returned
rows**: if a post-filter rejects rows within `[start, end)`, those rows were
still read and a later insert anywhere in `[start, end)` must still invalidate the
query. Stackbase will record the interval at the granularity the scan actually
consumed (e.g., up to the last key examined for a `limit`-bounded scan), so that
pagination pages depend only on the prefix they touched.

## Cursors & pagination

Cursors encode a stable resume position. The reference distinguishes two shapes:

- **`SimpleCursor`** `{ type: "simple", id }` — full table scans; just the last
  document `_id`. Encoded as the bare id string for backwards compatibility
  (`encodeSimpleCursor`).
- **`IndexCursor`** `{ type: "index", id, indexKey: Value[] }` — index scans;
  carries both the last document's id *and* its decoded index key values, so
  resumption can reconstruct the exact `(indexKey, id)` position even if many
  documents share the same index-field values. Encoded base64 via
  `encodeIndexCursor(id, indexKey)`.

`decodeCursor(cursorString) -> Cursor` accepts either the base64 index form or a
plain id, and `getCursorId(cursor)` extracts the id. `PaginatedResult` is
`{ documents, nextCursor: string|null, hasMore: boolean }`.

Because the index key includes the unique `_id` tiebreaker, pagination is
**stable under concurrent inserts**: the next page resumes strictly after the
`(indexKey, id)` of the last returned row, so a newly inserted document with the
same field values lands deterministically before or after the cursor rather than
causing skips or duplicates. Stackbase will keep this `(indexKey, id)` cursor
discipline and the rule that the recorded read interval for a page ends at the
cursor position, not at the end of the index.

## Filters, post-processing & ordering

Residual filters use a serialized expression tree, `ExpressionOrValue`, with:

- field/literal leaves (`$field`, `$literal`),
- comparisons (`$eq, $neq, $lt, $lte, $gt, $gte`),
- logical combinators (`$and, $or, $not`),
- arithmetic (`$add, $sub, $mul, $div, $mod, $neg`),
- and bare primitives.

Three evaluator functions: `evaluateFieldPath(path, doc)` resolves a dotted path
like `"a.b.c"`; `evaluateFilterValue(doc, expr)` computes the value of a subtree
(for use inside comparisons/arithmetic); `evaluateFilter(doc, filter) -> boolean`
decides whether a document passes. For index-bound expressions there is also a
fallback `evaluateRangeExpression(doc, expr)` so a `RangeExpression` can be
checked directly against a document when it could not be pushed into the scan.

Post-processing (`execution` + `postprocess`):

- `sortByCreationTimeAndId(docs, order)` — the canonical table-scan ordering.
- `sortByIndexFields(docs, indexFields, order)` — re-sort by the index tuple
  (needed when results are gathered from sources that don't already yield index
  order, e.g. merged point reads).
- `paginateByCursor(docs, cursor, limit) -> PaginatedResult` — slice a page after
  a cursor and compute `nextCursor`/`hasMore`.
- `applyQueryOperators(results, query, includePagination?)` — apply the residual
  filter, ordering, and limit/pagination operators of the serialized query to an
  in-memory result array.

Ordering note: for an index scan the storage layer already yields rows in
encoded-key order, so `order` is mostly a scan-direction flag; the explicit
sort helpers exist for the table-scan and merge paths. Stackbase will treat
in-engine ordering as a normalization step that must agree byte-for-byte with the
codec's ordering, so cursor comparisons and sort comparisons can never disagree.

## Actions vs queries here

`query/actions.d.ts` covers the **non-deterministic search paths** that are
modeled as actions rather than transactional queries:

- `executeSearchAction(searchQuery, context, schema, searchStore?)` — full-text
  search over a `SearchStore`. `SearchActionQuery` is `{ indexName, search,
  filter? }`.
- `executeVectorSearchAction(vectorQuery, context, schema, vecStore?)` — vector
  / nearest-neighbor search over a `VecStore`. `VectorSearchActionQuery` is
  `{ indexName, vector, limit?, expressions? }`.

Both return `{ results }`. `QueryRuntime` exposes thin wrappers
(`runSearchAction`, `runVectorSearchAction`). The distinction that matters: text
and vector search hit external/secondary stores and do **not** produce the same
clean `[start, end)` index intervals — their read-set/reactivity story is coarser
(typically the whole search index or a filter-scoped subset, captured via
`SearchPlan.filterMap` / `indexIdHex`), which is why they live behind the action
boundary instead of the transactional index-range path. The `search` query plan
(`SearchPlan`) is the in-transaction counterpart for the simpler filtered-search
case.

`developer-id.d.ts` is a supporting concern: it parses developer-facing document
IDs (legacy `hexTable:hexInternalId` and Convex base32-with-checksum forms) into
the internal `{ table, internalId, tableNumber? }` shape, with registry-aware
resolution (`parseDeveloperIdWithTableRegistry`) and storage-ID handling
(`parseStorageId`). The query engine needs this to turn an id-valued filter or a
`db.get(id)` into the right internal key for a point read.

## How Stackbase reimplements this

1. **Order-preserving key codec first.** Build and exhaustively property-test
   `encodeIndexKey` so that `compareIndexKeys(encode(a), encode(b))` matches the
   Convex total order (`null < bool < number < bigint < string < bytes`) for all
   value pairs, including float sign/NaN edges and bigint sign boundaries. Every
   other subsystem (indexes, read sets, cursors, OCC) depends on this being
   exactly right — it is the load-bearing primitive.
2. **Index maintenance** via an `IndexManager` that produces keyed add/delete
   updates per write, keeps the unchanged-key no-op optimization, and versions
   index entries by commit timestamp for MVCC scans.
3. **Planner** that classifies a query into `table-scan | index-range | search`,
   pushes the maximal leading-equality + single-inequality prefix into a scan
   interval, and leaves the rest as a residual filter.
4. **Runtime executor** that scans via an MVCC `index_scan(indexId, tableId,
   readTimestamp, interval, order, limit)` generator and, *as it scans*, records
   the exact `[start, end)` interval (or point/table-scan) into a `RangeSet`.
5. **RangeSet** as the single shared read/write-set representation, namespaced
   `table:<hex>` / `index:<hex>:<name>`, serializable, and queried by
   lexicographic comparison for both OCC conflict checks and subscription
   invalidation.
6. **Stable cursors** carrying `(indexKey, id)` for index scans and bare `id` for
   table scans, with the read interval for a page bounded by the cursor.
7. **Filter/post-process** evaluators for the serialized expression tree plus the
   sort/paginate helpers, with ordering guaranteed to agree with the codec.
8. **Search/vector as actions**, behind a separate store interface, with the
   understanding that their reactivity granularity is coarser.

## Open questions / risks

- **Exact byte format of the codec.** The `.d.ts` only states the ordering
  contract and the type tag scheme; the precise per-type encoding (length framing
  for strings/bytes vs. a terminator, the float/bigint bit transforms, the
  `indexKeyRangeEnd` sentinel) must be re-derived. Getting it wrong silently
  corrupts ordering, cursors, and reactivity. Needs a comprehensive ordering
  fuzz/property test as the acceptance gate.
- **Read-set granularity vs. limit.** For a `limit`-bounded or paginated scan, do
  we record the interval only up to the last key examined, or to the requested
  upper bound? Recording too wide over-invalidates; too narrow misses
  invalidations. The reference's `onDocumentRead` + interval recording implies
  "up to last examined" — we must confirm and test this precisely.
- **Post-filter read amplification.** Heavily-filtered index scans read (and
  therefore depend on) the whole interval. We may want a cost notion or a warning
  when a query's index bound is much wider than its result, but the reference
  shows no such mechanism.
- **`Eq` on multiple non-adjacent fields / multi-range queries.** The bounds
  builder appears to assume a contiguous prefix with one trailing inequality;
  confirm behavior for queries that imply disjoint ranges (likely degraded to a
  wider scan + post-filter).
- **Search/vector reactivity.** How precisely (if at all) text/vector searches
  participate in subscription invalidation is unclear from these contracts; the
  coarse `filterMap`/`indexIdHex` hints suggest whole-index dependencies. Needs a
  decision for Stackbase.
- **Tiebreaker fields.** Whether every index appends `_creationTime` then `_id`,
  or only `_id`, affects cursor stability and default ordering; confirm against
  `getStandardIndexes()` behavior before locking the schema-to-index lowering.
