---
title: Foundation — Query Engine (implementation-ready design)
status: design (implementation-ready)
slice: Foundation (Tier 0)
component: query-engine
depends_on: [sqlite-docstore, index-key-codec]
consumed_by: [transactor-occ, reactive-sync, udf-execution]
clean_room: true
---

# Query Engine

> Clean-room design. We studied the concave `@concavejs/*` `.d.ts` shapes (FSL-1.1,
> in gitignored `.reference/`) **only** to learn the contract *shape* of a
> Convex-compatible query layer. Everything below is our own design and our own
> code. Nothing here is copied; concave is cited only to anchor a behavioral
> expectation. See [`.reference/README.md`](../../../../.reference/README.md).

Grounding: [system-design](../system-design.md) · [strategy](../strategy.md) ·
[scalability-spectrum](../scalability-spectrum.md) · internals
[04-query-engine](../internals/04-query-engine.md) (primary),
[01-storage](../internals/01-storage.md), [02-transactions](../internals/02-transactions-consistency.md),
[03-reactivity-sync](../internals/03-reactivity-sync.md), [05-udf-execution](../internals/05-udf-execution.md).

---

## 1. Purpose & boundaries

The Query Engine is the layer that turns a **serialized Convex query**
(`ctx.db.query(table).withIndex(...).filter(...).order(...).paginate(...)`) into
concrete storage scans against the `DocStore`, and — the load-bearing part —
records *exactly which key ranges it read* so the transactor (OCC) and the sync
tier (reactive invalidation) can reason about overlap.

It is a **pure, deterministic, storage-agnostic** library. It talks to one seam
below (`DocStore.index_scan` / `get`) and one seam above (the database/query
syscalls in the UDF kernel). It never imports a database driver, a socket, a
clock, or randomness.

### It OWNS

1. **Query planning** — lower a `SerializedQuery` into a `QueryPlan`
   (`table-scan | index-range | search`); decide what becomes a pushed-down scan
   interval vs. a residual post-filter (`buildQueryPlan`, `parseIndexName`).
2. **Range lowering** — fold leading equalities + one trailing inequality into a
   single `[start, end)` byte interval (`rangeExpressionsToIndexBounds`).
3. **Index maintenance** — produce the per-write add/delete index mutations for
   every index on a table, with the no-op-on-unchanged-key optimization
   (`IndexManager.generateUpdates` / `extractIndexKey`).
4. **Execution** — drive the MVCC `index_scan` generator, materialize results,
   apply RYOW overlay, post-filter, order, and paginate (`QueryRuntime`).
5. **The read set** — the `KeyRange` / `RangeSet` representation and the act of
   recording the *precise scanned interval* (point / index-range / table-scan)
   during a scan. This is the same structure the transactor validates against and
   the sync tier intersects writes against. (Module `read-write-set`.)
6. **Stable cursors** — `(indexKey, _id)` `IndexCursor` and bare-id `SimpleCursor`
   encode/decode, plus the **`QueryJournal`** that pins reactive pagination.
7. **Filters & post-processing** — the serialized expression-tree evaluator and
   the sort/paginate helpers, with the hard rule that *all ordering goes through
   the codec's `compareIndexKeys`* so sort order and cursor order can never
   disagree.
8. **Developer-ID resolution at query time** — turn an id-valued filter or
   `db.get(id)` into an internal point-read target (`parseDeveloperId`).

### It does NOT own (and must not reimplement)

- **The byte codec itself.** `encodeIndexKey` / `compareIndexKeys` /
  `indexKeyRangeStart` / `indexKeyRangeEnd` belong to the sibling
  **`index-key-codec`** component. We *import* them. (§3.) The Query Engine is the
  largest consumer and the place the codec's ordering contract is *exercised*, but
  not where it is defined.
- **Storage.** Physical layout, SQL, MVCC visibility filtering, and the
  `index_scan` generator belong to **`sqlite-docstore`**. We consume the
  `DocStore` interface.
- **OCC validation / commit.** The transactor (component 02) consumes our
  `RangeSet` and pairs each range with a `ReadVersion` for conflict checking. We
  record *ranges*; we do not allocate timestamps, validate, or commit. We provide
  the read footprint; the transactor decides conflict.
- **Subscription matching / the interval tree / the WebSocket protocol.** The sync
  tier (component 03) consumes our `SerializedKeyRange` + `QueryJournal`. We
  produce them; we do not match or fan out.
- **The UDF sandbox / determinism / syscall transport.** Component 05 owns the
  kernel; it *calls* us through the `queryStream` / `queryPage` syscalls.
- **`UncommittedWrites` construction.** Built by the transactor; we consume it as
  a read-time RYOW overlay (§5.5).
- **Schema/index metadata storage.** We read it through a narrow `IndexCatalog`
  view (§4.6) supplied by the schema service.

---

## 2. Position in the engine (data flow)

```
  user code (guest isolate)
    ctx.db.query("messages").withIndex("by_conversation", q =>
        q.eq("conversationId", id)).order("desc").paginate({numItems, cursor})
        │  serialize  (builder → SerializedQuery)        ← client/runtime facade (comp 05)
        ▼
  queryStream / queryPage syscall  ───────────────────────────────  KernelContext
        │  (string-JSON ABI)                                         (read log = RangeSet)
        ▼
 ┌───────────────────────── QUERY ENGINE ─────────────────────────────────┐
 │  buildQueryPlan(query, schema) → QueryPlan                              │
 │  rangeExpressionsToIndexBounds(expressions, indexFields) → {start,end}  │
 │  QueryRuntime.evaluatePaginated(query, cursor, limit)                   │
 │     └─ executeIndexQuery → docStore.index_scan(...)  ──── MVCC scan ────┼──▶ DocStore
 │           ├─ onDocumentRead → readSet.addIndexRange([start, lastKey))   │   (index_scan,
 │           ├─ RYOW overlay (UncommittedWrites)                           │    get) — comp 01
 │           ├─ post-filter (evaluateFilter)                              │
 │           └─ cursor = IndexCursor(indexKey, _id) ; journal pin          │
 └────────────────────────────────────────────────────────────────────────┘
        │ returns PaginatedResult + readSet (RangeSet) + journal
        ▼
  KernelContext.readRanges ── UdfResult.readRanges (SerializedKeyRange[]) ──▶
        ├──▶ Transactor (comp 02): pair ranges w/ ReadVersion → OCC validate
        └──▶ Sync tier  (comp 03): record read ranges → intersect future writes
  IndexManager.generateUpdates(...)  ── on mutation write ──▶ DocStore.write(docs, indexUpdates)
```

The engine is invoked **once per query materialization** (or once per page). It is
stateless across invocations except for an optional per-invocation visible-document
cache (§5.6). All durable state is in the `DocStore`; all reactive state is in the
`RangeSet` it hands back.

---

## 3. Dependencies & the codec boundary (precise)

Two Foundation siblings sit directly under us. The boundary is drawn so the two
components compose with **zero overlapping ownership**.

### 3.1 `index-key-codec` (imported, never redefined)

```ts
// from "@stackbase/core/index-key-codec"  — specified & owned by the codec component
export function encodeIndexKey(values: Value[]): Uint8Array;
export function compareIndexKeys(a: Uint8Array, b: Uint8Array): -1 | 0 | 1;
export function indexKeysEqual(a: Uint8Array, b: Uint8Array): boolean;
// prefix-scan helpers: inclusive lower / exclusive upper bound for a value prefix
export function indexKeyRangeStart(prefix: Value[]): Uint8Array;       // == encodeIndexKey(prefix)
export function indexKeyRangeEnd(prefix: Value[]): Uint8Array | null;  // prefix + max sentinel; [] ⇒ null (+∞)
```

Contract we rely on (the codec component proves it; we *re-exercise* it in our
differential tests, §10): **byte order == Convex total order**
`null < boolean < number(float64) < bigint(int64) < string < bytes`, with
`indexKeyRangeEnd(p)` being a byte string strictly greater than every key that has
`p` as a prefix and strictly less than the next sibling prefix.

> **The single rule that makes this component correct:** the Query Engine performs
> **no value comparisons of its own**. Every "is a before b" decision — sort order,
> cursor position, range membership, bounds folding — routes through
> `compareIndexKeys` on encoded bytes. Native JS `<`/`>` on decoded values is
> banned (it disagrees with the codec on `-0`/`+0`, `NaN`, bigint-vs-float, and
> string collation). This is enforced by lint rule + the ordering-agreement
> property test.

`extractIndexKey` (doc → key for *one* index, by field-paths) is **ours**, not the
codec's: it needs document/field-path semantics (§4.3). It *uses* `encodeIndexKey`.

### 3.2 `sqlite-docstore` (imported `DocStore` seam)

The subset we consume:

```ts
// from "@stackbase/core/docstore"
type ScanOrder = "asc" | "desc";
interface IndexInterval { start: Uint8Array; end: Uint8Array | null; } // end:null ⇒ +∞

interface LatestDocument { ts: bigint; value: ResolvedDocument; prev_ts: bigint | null; }
interface ResolvedDocument { id: InternalDocumentId; value: Value; } // value includes _id, _creationTime

interface DocStore {
  index_scan(
    indexId: string, tableId: string, readTimestamp: bigint,
    interval: IndexInterval, order: ScanOrder, limit?: number,
  ): AsyncGenerator<[indexKey: Uint8Array, doc: LatestDocument]>;
  get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null>;
  // write(documents, indexes, conflictStrategy) — consumed by the transactor, fed by IndexManager
}
```

`indexId` / `tableId` are the namespaced keyspace blobs from
`@stackbase/core/keyspace` (`encodeTableId`, `encodeIndexId`) — storage-owned; we
use them to derive both the scan ids and the `KeyRange.tableId` namespace (§4.4).

### 3.3 Consumed-from-above interfaces (declared narrow, owned elsewhere)

- `IndexCatalog` (§4.6) — schema/index metadata, supplied by the schema service (05).
- `UncommittedWrites` (§5.5) — RYOW overlay, built by the transactor (02).
- `ReadLimitTracker` (optional) — headroom accounting (`documentsRead`,
  `databaseQueries`), owned by the transactor (02); we call `recordRead` /
  `recordDatabaseQuery` if present.

---

## 4. Core types & contracts

All types below are **defined by this component**. Signatures are exact.

### 4.1 Serialized query (the input)

The guest-side query builder serializes to this shape; it crosses the syscall ABI
as JSON, so it is plain data (no functions, `bigint`/`bytes` as the codec's JSON
forms).

```ts
export type ScanOrder = "asc" | "desc";

export interface SerializedQuery {
  table: string;                    // logical table name (component-relative)
  source: QuerySource;
  operators: QueryOperator[];       // applied in order, post-source
}

export type QuerySource =
  | { type: "FullTableScan" }
  | { type: "IndexRange"; indexName: string; range: RangeExpression[] }
  | { type: "Search"; indexName: string; search: string; filter?: SearchFilterExpr[] };

export type QueryOperator =
  | { type: "filter"; predicate: ExpressionOrValue }   // residual post-filter
  | { type: "order"; order: ScanOrder }                // scan direction
  | { type: "limit"; n: number };                      // .take(n) lowers to this

// One index-bound predicate. fieldPath is a dotted path already split.
export interface RangeExpression {
  type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
  fieldPath: string[];
  value: Value;
}
```

`.paginate({ numItems, cursor })` is **not** an operator — it is the materialization
mode (§4.5). `.first()` lowers to `limit 1`; `.unique()` to `limit 2` + a
"expected ≤1" assertion; `.collect()`/`.take(n)` to `limit?`.

### 4.2 Query plan (the lowering)

```ts
export type QueryPlan = TableScanPlan | IndexRangePlan | SearchPlan;

interface PlanBase {
  query: SerializedQuery;     // carries the residual filter + order + limit
  tableName: string;          // component-relative
  fullTableName: string;      // `${componentPath}/${tableName}` (root ⇒ tableName)
  tableId: string;            // encodeTableId(tableNumber) — storage keyspace blob
  order: ScanOrder;           // resolved scan direction (default "asc")
}
export interface TableScanPlan extends PlanBase {
  kind: "table-scan";
  // scans the implicit by-creation index (`_creationTime,_id`) over the whole table
}
export interface IndexRangePlan extends PlanBase {
  kind: "index-range";
  indexDescriptor: string;            // index name without table prefix
  indexId: string;                    // encodeIndexId(tableId, indexDescriptor)
  indexFields: string[];              // ordered, incl. trailing _creationTime,_id
  expressions: RangeExpression[];     // the pushed-down bound part only
}
export interface SearchPlan extends PlanBase {
  kind: "search";
  indexDescriptor: string;
  indexIdHex: string;
  searchTerm: string;
  filterMap: Record<string, Value>;   // equality filters folded into the search
}

export function buildQueryPlan(
  query: SerializedQuery, schema: IndexCatalog, componentPath?: string,
): QueryPlan;

export function parseIndexName(wireName: string): { tableName: string; indexDescriptor: string };
```

`buildQueryPlan` algorithm in §5.1.

### 4.3 Index maintenance

```ts
export type IndexEntryValue =
  | { type: "Deleted" }
  | { type: "NonClustered"; doc_id: InternalDocumentId };

export interface DatabaseIndexUpdate {
  index_id: string;          // encodeIndexId(tableId, indexDescriptor)
  key: Uint8Array;           // encodeIndexKey(extracted field values)
  value: IndexEntryValue;
}

export interface IndexManager {
  /** Produce the index mutations for one document write. Pure; no IO. */
  generateUpdates(
    tableName: string,
    docId: InternalDocumentId,
    newValue: Value | null,   // null ⇒ delete
    oldValue: Value | null,   // null ⇒ insert
    indexes: IndexDefinition[],
  ): DatabaseIndexUpdate[];
}

export interface IndexDefinition { name: string; fields: string[]; indexId: string; }

/** Encode the index key for a doc, or null if a required field is absent
 *  (⇒ the doc is not present in this index). Field paths resolved by §6 rules. */
export function extractIndexKey(doc: Value, fields: string[]): Uint8Array | null;
```

`generateUpdates` algorithm + the no-op optimization in §5.2.

### 4.4 Read/write set (the reactive currency)

Lives in `read-write-set.ts`. **Owned here**, consumed by 02 (OCC) and 03 (sync).

```ts
export interface KeyRange {
  tableId: string;             // namespaced: "table:<hex>" | "index:<hex>:<descriptor>"
  startKey: Uint8Array;        // inclusive lower bound (encoded)
  endKey: Uint8Array | null;   // exclusive upper bound; null ⇒ +∞; === startKey-equal ⇒ see isPoint
  isPoint: boolean;            // true ⇒ single-key read [key, key]
}

export class RangeSet {
  addDocument(ref: { table: string; internalId: InternalDocumentId }): void; // point
  addIndexRange(tableName: string, indexDescriptor: string,
                startKey: Uint8Array, endKey: Uint8Array | null): void;
  addTableScan(tableId: string): void;                                       // whole-table dep

  getRanges(): KeyRange[];
  getRangesByTable(): Map<string, KeyRange[]>;                                // keyed by tableId namespace
  getTables(): string[];                                                      // distinct logical tables touched
  size(): number; isEmpty(): boolean;
  clone(): RangeSet; replaceWith(other: RangeSet): void; clear(): void;

  /** Membership test used by BOTH OCC conflict and subscription overlap. */
  intersects(write: KeyRange): boolean;                                       // §5.7
}

// Wire form (crosses worker/process/socket boundaries):
export interface SerializedKeyRange {
  tableId: string; startHex: string; endHex: string | null; isPoint: boolean;
}
export function serializeKeyRange(r: KeyRange): SerializedKeyRange;
export function deserializeKeyRange(s: SerializedKeyRange): KeyRange;
export function serializeRangeSet(rs: RangeSet): SerializedKeyRange[];
export function deserializeRangeSet(s: SerializedKeyRange[]): RangeSet;
```

> **Boundary with OCC:** a `RangeSet` answers *"which keyspace regions did I
> touch."* The transactor pairs each region with a `ReadVersion`
> (`{document,version}` / `{index_range, documentIds}` / `{table_scan, documentIds}`)
> — that union and its validation live in component 02, not here. We provide the
> region; they provide the version semantics.

### 4.5 Execution & pagination

```ts
export interface PaginatedResult {
  documents: Value[];            // resolved docs (post RYOW, post-filter, ordered)
  nextCursor: string | null;     // encoded cursor; null only when !hasMore at table end
  hasMore: boolean;              // Convex `isDone` === !hasMore; nextCursor === continueCursor
  journal?: QueryJournal;        // pin for reactive re-execution (§4.7)
}

export interface QueryRuntimeDeps {
  docStore: DocStore;
  schema: IndexCatalog;
  readTimestamp: bigint;         // MVCC snapshot; every scan pinned to this
  readSet: RangeSet;             // where scanned intervals/points are recorded
  uncommittedWrites?: UncommittedWrites;  // RYOW overlay (mutation path)
  limits?: ReadLimitTracker;     // optional headroom accounting
  componentPath?: string;
}

export class QueryRuntime {
  constructor(deps: QueryRuntimeDeps);

  /** Materialize ALL matching docs (collect/take/first/unique lower onto this). */
  evaluate(query: SerializedQuery): Promise<Value[]>;

  /** One page. cursor === null ⇒ first page. */
  evaluatePaginated(
    query: SerializedQuery, cursor: string | null, limit: number,
    journal?: QueryJournal,
  ): Promise<PaginatedResult>;

  /** Point read used by db.get / id-valued resolution; records a point range. */
  getVisibleDocumentById(id: InternalDocumentId): Promise<Value | null>;

  // search/vector wrappers (Foundation: stubs that throw "capability not enabled")
  runSearchAction(q: SearchActionQuery): Promise<{ results: Value[] }>;
  runVectorSearchAction(q: VectorSearchActionQuery): Promise<{ results: Value[] }>;
}
```

Internals (`handleTableScan`, `handleIndexRange`, `executeIndexQuery`,
`onDocumentRead`, the batched visible-doc cache) are private; their algorithms are
§5.3–5.6.

### 4.6 `IndexCatalog` (the narrow schema view we require)

```ts
// Implemented by the schema service (comp 05); we declare only what we need.
export interface IndexCatalog {
  getIndexFields(tableName: string, indexDescriptor: string): string[] | null; // null ⇒ unknown index
  getAllIndexes(tableName: string): IndexDefinition[];
  getStandardIndexes(tableName: string): IndexDefinition[]; // by-creation / by-id present on every table
  getTableNumber(tableName: string): number;
  getTableId(tableName: string): string;                    // encodeTableId(tableNumber)
}
```

### 4.7 Cursors & journal

```ts
export type Cursor = SimpleCursor | IndexCursor;
export interface SimpleCursor { type: "simple"; id: string; }                 // table scans
export interface IndexCursor { type: "index"; id: string; indexKey: Value[]; } // index scans

export function encodeSimpleCursor(id: string): string;                  // bare id (back-compat)
export function encodeIndexCursor(id: string, indexKey: Value[]): string; // base64 of {id,indexKey}
export function decodeCursor(s: string): Cursor;                         // accepts either form
export function getCursorId(c: Cursor): string;

/** Opaque, serializable. Pins reactive pagination so a re-run stays gapless. */
export type QueryJournal = string | null;

/** Structured form (internal); journal serializes this. */
export interface PaginationJournal {
  /** The end position the loaded window reached on first run. On reactive
   *  re-execution the query re-scans [start, endCursor] so the same logical
   *  window is returned even as rows shift underneath. null ⇒ reached table end. */
  endCursor: Cursor | null;
  order: ScanOrder;
  /** index identity the cursor belongs to — guards against journal/plan mismatch */
  indexDescriptor: string | null; // null ⇒ table scan
}
export function serializeJournal(j: PaginationJournal): QueryJournal;
export function parseJournal(j: QueryJournal): PaginationJournal | null;
```

### 4.8 Filters & post-processing

```ts
export type ExpressionOrValue =
  | { $field: string }                                  // dotted path
  | { $literal: Value }
  | { $eq: [ExpressionOrValue, ExpressionOrValue] } | { $neq: [ExpressionOrValue, ExpressionOrValue] }
  | { $lt: [ExpressionOrValue, ExpressionOrValue] }  | { $lte: [ExpressionOrValue, ExpressionOrValue] }
  | { $gt: [ExpressionOrValue, ExpressionOrValue] }  | { $gte: [ExpressionOrValue, ExpressionOrValue] }
  | { $and: ExpressionOrValue[] } | { $or: ExpressionOrValue[] } | { $not: [ExpressionOrValue] }
  | { $add: [ExpressionOrValue, ExpressionOrValue] } | { $sub: [ExpressionOrValue, ExpressionOrValue] }
  | { $mul: [ExpressionOrValue, ExpressionOrValue] } | { $div: [ExpressionOrValue, ExpressionOrValue] }
  | { $mod: [ExpressionOrValue, ExpressionOrValue] } | { $neg: [ExpressionOrValue] }
  | Value;                                              // bare primitive

export function evaluateFieldPath(path: string, doc: Value): Value | undefined;
export function evaluateFilterValue(doc: Value, expr: ExpressionOrValue): Value | undefined;
export function evaluateFilter(doc: Value, filter: ExpressionOrValue): boolean;
export function evaluateRangeExpression(doc: Value, expr: RangeExpression): boolean; // fallback check

export function sortByCreationTimeAndId(docs: Value[], order: ScanOrder): Value[];
export function sortByIndexFields(docs: Value[], indexFields: string[], order: ScanOrder): Value[];
export function paginateByCursor(docs: Value[], cursor: Cursor | null, limit: number): PaginatedResult;
export function applyQueryOperators(results: Value[], query: SerializedQuery, paginate?: { cursor: Cursor | null; limit: number }): Value[] | PaginatedResult;
```

Comparisons inside `evaluateFilter` (`$lt`, `$gte`, …) **encode both operands via
`encodeIndexKey([v])` and compare with `compareIndexKeys`** — never native `<`.

### 4.9 Developer-ID resolution

```ts
export function parseDeveloperId(s: string): InternalDocumentId; // throws on bad checksum/format
export function parseDeveloperIdWithTableRegistry(s: string, schema: IndexCatalog): InternalDocumentId;
export function parseStorageId(s: string): InternalDocumentId;
```

Uses the storage component's `decodeDocumentId` (§3.2 sibling) for the byte
decode; resolves `tableNumber → tableId` via the catalog.

### 4.10 Errors

```ts
export class InvalidCursorError extends Error {}     // malformed / arity-mismatch / wrong index
export class UnknownIndexError extends Error {}      // withIndex names a non-existent index
export class NotUniqueError extends Error {}         // .unique() saw >1 row
export class QueryLimitError extends Error {}        // documentsRead / databaseQuery headroom exceeded
```

`InvalidCursorError` is recoverable at the client by **full resync** (§8); the
others surface to the developer.

---

## 5. Key data structures & algorithms

### 5.1 `buildQueryPlan`

```
buildQueryPlan(query, schema, componentPath):
  tableId = schema.getTableId(query.table)
  order   = last "order" operator ?? "asc"
  switch query.source.type:
    FullTableScan:
      return { kind:"table-scan", tableName, fullTableName, tableId, order, query }
    IndexRange:
      { tableName, indexDescriptor } = parseIndexName(query.source.indexName)
      indexFields = schema.getIndexFields(tableName, indexDescriptor)
      if indexFields === null: throw UnknownIndexError
      // validate the range expressions form a legal prefix (see §5.1a); the
      // residual (anything not pushable) stays in query.operators as a filter.
      return { kind:"index-range", ..., indexDescriptor,
               indexId: encodeIndexId(tableId, indexDescriptor),
               indexFields, expressions: query.source.range, order, query }
    Search:
      return { kind:"search", ... }   // Foundation: planned; runtime throws if FTS not enabled
```

**§5.1a Bound legality / push-down classification.** Walk `indexFields` in order
against `expressions`:

- Consume `Eq(field_i, v)` while the expression's field equals `indexFields[i]`;
  each appends `v` to the fixed `prefix`.
- At the first non-`Eq`, accept **at most one** trailing inequality
  (`Gt/Gte/Lt/Lte`) on `indexFields[i]`. Two inequalities on the same field
  (a between) are both kept (they bound start and end).
- Anything else — an `Eq` on a non-adjacent field, a second distinct inequality
  field, a disjunction — is **not pushable**: it is dropped from `expressions` and
  re-expressed as a residual `filter` operator (so it post-filters, and the scan
  widens to the legal prefix). Correctness is preserved; only precision is lost.

### 5.2 `rangeExpressionsToIndexBounds` (the [start, end) fold)

```
rangeExpressionsToIndexBounds(expressions, indexFields) -> { start: bytes, end: bytes|null }:
  prefix = []                         // Value[] of consumed Eq values
  lower  = undefined                  // trailing lower-bound ineq (Gt/Gte)
  upper  = undefined                  // trailing upper-bound ineq (Lt/Lte)
  for each expr in expressions (already prefix-legal per §5.1a):
    if expr.type == "Eq":  prefix.push(expr.value)
    if expr.type in {Gt,Gte}: lower = expr
    if expr.type in {Lt,Lte}: upper = expr

  // start (inclusive lower bound)
  if lower is Gte: start = encodeIndexKey([...prefix, lower.value])
  elif lower is Gt: start = indexKeyRangeEnd([...prefix, lower.value])  // first key strictly after
  else:             start = indexKeyRangeStart(prefix)                  // whole-prefix lower

  // end (exclusive upper bound; null ⇒ +∞)
  if upper is Lt:  end = encodeIndexKey([...prefix, upper.value])
  elif upper is Lte: end = indexKeyRangeEnd([...prefix, upper.value])   // up to & incl the value-prefix
  else:            end = indexKeyRangeEnd(prefix)                       // whole-prefix upper
                                                                        //   ([] prefix ⇒ null = +∞)
  // empty/impossible interval (compareIndexKeys(start, end) >= 0 with end != null)
  //   ⇒ caller short-circuits to an empty result, recording the empty range.
  return { start, end }
```

This is the **leading-equality + one-trailing-inequality → single `[start, end)`
scan** the responsibility statement mandates. Worked examples:

| Query (`by_conv` = `[conversationId,_creationTime,_id]`) | start | end |
|---|---|---|
| `eq(conversationId, c1)` | `enc([c1])` | `rangeEnd([c1])` |
| `eq(conversationId,c1).gt(_creationTime,T)` | `rangeEnd([c1,T])` | `rangeEnd([c1])` |
| `eq(conversationId,c1).lte(_creationTime,T)` | `enc([c1])` | `rangeEnd([c1,T])` |
| `eq(conversationId,c1).gte(_creationTime,A).lt(_creationTime,B)` | `enc([c1,A])` | `enc([c1,B])` |
| (full index) | `enc([])` | `null` |

### 5.3 `generateIndexUpdates` (per-write index maintenance + no-op opt)

```
generateUpdates(tableName, docId, newValue, oldValue, indexes) -> DatabaseIndexUpdate[]:
  out = []
  for index in indexes:
    oldKey = oldValue ? extractIndexKey(oldValue, index.fields) : null
    newKey = newValue ? extractIndexKey(newValue, index.fields) : null
    if oldKey && newKey && indexKeysEqual(oldKey, newKey):
        continue                                  // ── NO-OP: unchanged key, emit nothing
    if oldKey: out.push({ index_id: index.indexId, key: oldKey, value: {type:"Deleted"} })
    if newKey: out.push({ index_id: index.indexId, key: newKey, value: {type:"NonClustered", doc_id: docId} })
  return out
```

- insert (`oldValue=null`): one `NonClustered` per index whose key is non-null.
- delete (`newValue=null`): one `Deleted` per index whose old key was non-null.
- update: per index, delete-old + insert-new **unless keys are byte-equal** → the
  no-op skip. This directly cuts both write amplification *and* reactivity churn
  (an update that doesn't move a row in `by_conversation` never invalidates a
  subscriber paginating that index).

The returned batch is handed to `DocStore.write(documents, indexUpdates, "Error")`
by the transactor, tagged with the single commit `ts` (MVCC-versioned like docs).

### 5.4 `executeIndexQuery` + precise interval recording (the scaleSeam core)

```
executeIndexQuery(plan, { cursor, limit }, onDocumentRead) -> PaginatedResult:
  { start, end } = rangeExpressionsToIndexBounds(plan.expressions, plan.indexFields)
  // resume: tighten `start` (asc) / `end` (desc) to strictly after the cursor
  if cursor: (start|end) = advancePastCursor(cursor, plan.order, start, end)

  scanned = 0 ; survivors = [] ; lastKey = null ; reachedEnd = false
  gen = docStore.index_scan(plan.indexId, plan.tableId, readTimestamp,
                            {start, end}, plan.order, /*limit*/ limit)
  for await ([indexKeyBytes, latest] of gen:
      scanned++ ; lastKey = indexKeyBytes
      limits?.recordRead(latest.value)
      doc = ryowOverlay(latest)                 // §5.5 — may replace/remove
      if doc !== REMOVED && passesResidualFilter(doc, plan.query):
          survivors.push(doc)
      onDocumentRead(indexKeyBytes, latest)     // point-dedup cache hook
      if scanned >= limit: break
  reachedEnd = (scanned < limit)                // generator exhausted before limit

  // ── RECORD THE PRECISE INTERVAL (not the whole index) ──
  recordEnd =
      reachedEnd ? end                          // proved exhaustion ⇒ depend out to the bound (maybe +∞)
                 : successorKeyExclusive(lastKey, plan.order) // depend only up to last EXAMINED key
  readSet.addIndexRange(plan.tableName, plan.indexDescriptor,
                        intervalLow(start, recordEnd, plan.order),
                        intervalHigh(start, recordEnd, plan.order))

  nextCursor = reachedEnd ? (end===null ? null : encodeCursorFrom(lastKey, plan))
                          : encodeCursorFrom(lastKey, plan)
  return { documents: survivors, nextCursor, hasMore: !reachedEnd }
```

The recorded read interval is **exactly the span the page consumed**:

- **`hasMore` (page filled `limit` index entries):** end = exclusive successor of
  the last examined key. A write *beyond* that key does **not** invalidate this
  page — older/other pages are untouched. This is what stops reactive pagination
  from over-invalidating at fan-out scale (seam row 7).
- **`!hasMore` (scan exhausted before `limit`):** end = the index bound (`end`,
  possibly `null`/+∞). A new insert at the tail *does* invalidate the last page
  (correct — it now has more rows). Recording `null` here is deliberate: the last
  page depends on "nothing newer exists past where I stopped."

**Page size semantics (decided):** a page scans **exactly `limit` index entries**
(Convex parity), then applies the post-filter — so a filtered page may return
`< limit` documents with `hasMore: true`. This bounds per-page read amplification
to `limit` entries and makes the recorded interval precise and `limit`-sized. The
cursor advances past the last *examined* entry (not the last survivor), so the next
page never re-examines.

### 5.5 RYOW overlay (read-your-own-writes, mutation path)

When `uncommittedWrites` is present (we're inside a mutation), scanned persisted
rows are corrected by the transaction's staged writes before filter/sort:

```
ryowOverlay(latest):
  w = uncommittedWrites.getDocumentWrite(developerId(latest.value._id))
  if w === undefined: return latest.value      // no staged write
  if w === null:      return REMOVED            // staged delete
  return w                                       // staged insert/update value
```

For a scan we additionally fold in staged rows that fall in `[start,end)` but were
not yet persisted, via `UncommittedWrites.applyToVisibilityMap`, then re-sort by
the index fields (`sortByIndexFields`) so order is correct pre-commit. The
`UncommittedWrites` container is built by the transactor; we only *apply* it.
`mergeUncommittedWrites(persisted, uncommitted, { range, indexFields, order })`
is the single helper that does map-build → apply → filter → sort.

### 5.6 Visible-document cache & point-read batching

`QueryRuntime` keeps a per-invocation `Map<docKey, Value|null>` so repeated
`db.get(sameId)` or id-joins within one function don't re-hit storage, and a small
enqueue/flush batcher coalesces concurrent point reads into one `get`-batch. Each
distinct point read still records its own `addDocument` point range (so reactivity
is correct), but storage is touched once. The cache is dropped when the invocation
ends.

### 5.7 `RangeSet.intersects` (the one overlap test)

```
intersects(write):                 // write is a KeyRange (a committed write key/range)
  for r in ranges where r.tableId === write.tableId:
     if rangesOverlap(r, write): return true
  return false

rangesOverlap(a, b):               // half-open [start,end), null end = +∞, isPoint = [k,k]
  aLo=a.startKey; aHi = a.isPoint ? a.startKey : a.endKey   // null ⇒ +∞
  bLo=b.startKey; bHi = b.isPoint ? b.startKey : b.endKey
  // overlap iff aLo <= bHi && bLo <= aHi  (compareIndexKeys; null treated as +∞)
  return cmp(aLo, bHi) <= 0 && cmp(bLo, aHi) <= 0
```

This exact predicate is what the transactor uses for OCC ("did a write land in my
read region?") and the sync tier uses for invalidation ("which subscriptions read
this written region?"). Same bytes, same comparator — they can never disagree.
(The sync tier may put these ranges in an interval tree for `O(log n)` matching;
that is its optimization, built on the same `rangesOverlap`.)

---

## 6. Field-path & ordering rules (must be exact)

- **Field paths** resolve dotted segments (`"a.b.c"`) left-to-right; a missing
  segment yields `undefined`. For index extraction, `_creationTime` and `_id` are
  top-level system fields always present on a stored doc.
- **Every index implicitly appends `_creationTime` then `_id`** as trailing
  tiebreakers (confirmed as our schema-lowering rule; `getStandardIndexes` returns
  the by-creation/by-id ordering that backs a table scan). This guarantees every
  encoded index key is globally unique and totally ordered → stable cursors.
- **Table-scan order** is `by_creation` = `[_creationTime, _id]`. `sortByCreationTimeAndId`
  is `sortByIndexFields(docs, ["_creationTime","_id"], order)`.
- **Ordering is a normalization, not a re-sort, for index scans:** storage yields
  encoded-key order already, so `order` is a scan-direction flag. The explicit
  `sortBy*` helpers exist only for table-scan/merge/RYOW paths and they sort by
  `compareIndexKeys(encodeIndexKey(extract(a)), encodeIndexKey(extract(b)))` — the
  identical comparator the cursor uses.

---

## 7. Module / file layout

Ships inside the engine core package **`@stackbase/core`** (directory
`packages/core`; the `packages/server` slice in CLAUDE.md composes core into the
running server). Public import subpaths mirror the enduser-facing seam
(`@stackbase/core/docstore`, `@stackbase/core/index-key-codec`).

```
packages/core/src/
  query/                        # high-level orchestration (the "query/*" group)
    types.ts                    # SerializedQuery, QuerySource, QueryOperator, QueryPlan*, Cursor, ScanOrder
    planner.ts                  # buildQueryPlan, parseIndexName, §5.1a push-down classifier
    query-runtime.ts            # QueryRuntime (evaluate / evaluatePaginated / point reads / search wrappers)
    postprocess.ts              # sortByCreationTimeAndId, sortByIndexFields, paginateByCursor, applyQueryOperators
    execution.ts                # executeIndexQuery, advancePastCursor, interval-recording glue, RYOW merge call
    actions.ts                  # executeSearchAction / executeVectorSearchAction (Foundation: capability stubs)
  queryengine/                  # low-level mechanics (the "queryengine/*" group)
    index-query.ts              # the index_scan driver + onDocumentRead callback contract
    cursor.ts                   # SimpleCursor/IndexCursor encode/decode, getCursorId
    journal.ts                  # QueryJournal / PaginationJournal serialize/parse
    filters.ts                  # ExpressionOrValue + evaluate* (codec-backed comparisons)
    developer-id.ts             # parseDeveloperId(+WithTableRegistry/Storage)
    indexing/
      index-manager.ts          # IndexManager.generateUpdates, extractIndexKey
      range-bounds.ts           # RangeExpression, rangeExpressionsToIndexBounds
      read-write-set.ts         # KeyRange, RangeSet, (de)serialize  ← OWNED HERE, consumed by 02/03
      index-key-codec.ts        # ⟵ SIBLING COMPONENT owns this file; we only import it
  __tests__/
    codec-agreement.property.ts # ordering ⇔ sort ⇔ cursor differential (§10)
    pagination.property.ts      # gapless / stable-under-insert (§10)
    index-manager.property.ts   # no-op + add/delete invariants
    rangeset-overlap.property.ts# intersects vs brute-force oracle
    occ-conflict.spec.ts        # the conflict/no-conflict matrix (§10)
```

`index-key-codec.ts` physically sits under `queryengine/indexing/` (matching the
internals layout) but is **specified and owned by the `index-key-codec` Foundation
component**; the Query Engine imports it and must not edit it. This is the only
shared file and the boundary is documented at the top of that file.

---

## 8. Tier 0 (single binary) — how it works NOW

At Tier 0 everything is in one process over embedded Node SQLite. Concretely:

1. A query function runs in the inline executor. Its `ctx.db.query(...)` builder
   serializes to a `SerializedQuery` and crosses the **`queryStream`/`queryPage`
   syscalls** (string-JSON) into the kernel.
2. The kernel constructs a `QueryRuntime` with `docStore` = the Node
   `SqliteDocStore`, `readTimestamp` = the invocation's snapshot, and `readSet` =
   the `KernelContext`'s read log `RangeSet`. For a mutation it also passes the
   transaction's `UncommittedWrites`.
3. `buildQueryPlan` lowers the query; `executeIndexQuery` drives
   `index_scan` (an in-process, in-memory SQLite call — the round-trip is a memory
   access, SpacetimeDB's speed win for free); each examined row records into the
   shared `RangeSet`.
4. On return, `KernelContext.readRanges` becomes `UdfResult.readRanges`
   (`SerializedKeyRange[]`). For a query the sync handler records them as the
   subscription's dependency set; for a mutation the transactor pairs them with
   `ReadVersion`s and validates at commit. The **shard is always `"default"`** —
   one SQLite DB, one `TimestampOracle` — but the ranges are already
   keyspace-namespaced and serializable, i.e. shard-ready.
5. Index maintenance: a mutation's writes call `IndexManager.generateUpdates`
   once per written doc; the batch goes into `DocStore.write` atomically with the
   doc revisions at the single commit `ts`.
6. Pagination + journal: `evaluatePaginated` returns a `(indexKey,_id)`
   `nextCursor` and a `journal`. The loopback sync handler stores the journal on
   the `QueryUpdated` and replays it on reactive re-run — identical mechanics to
   Tier 2, just over an in-memory transport.

No network, no isolate boundary required for correctness (the syscall ABI is
already serialized so the isolate can drop in later). A 100-row dev table and the
billion-row case run the **same code path**.

---

## 9. The scaleSeam, reserved (seam-table row 7 — infinite scrollback)

> *"The `(indexKey,_id)` cursor + `QueryJournal` are the infinite-scrollback
> mechanism: `paginate()` over a billion-message conversation is byte-for-byte the
> same app code as over a 100-row dev table and stable under concurrent
> head-inserts; recording the precise page interval (not the whole index) keeps
> reactive pagination from over-invalidating at fan-out scale."*

The WhatsApp-scale path attaches later with **no app-code and no engine rewrite**
because every mechanism that scaling needs is already the Tier-0 mechanism:

1. **The cursor is tier-invariant bytes.** `(indexKey, _id)` is encoded by the
   codec; `_id` is the globally-unique tiebreaker. Resuming a page is "scan
   strictly after these bytes." A concurrent **head-insert** (a new message,
   `.order("desc")`) shares field values with existing rows but gets a distinct
   `_id`, so it lands *deterministically* relative to any cursor — it can never
   shift, skip, or duplicate a row in a page already loaded. Same encoding at 100
   rows and 10¹¹ rows. App code (`useQuery(...).paginate(...)`) is byte-for-byte
   identical; nothing in it knows the tier.
2. **Precise page intervals, not whole-index dependencies.** §5.4 records
   `[start, lastExaminedKey)` per page. At fan-out scale a single conversation
   commit touches one tiny interval; only subscriptions whose *page interval*
   contains it recompute. Older pages (disjoint intervals) are provably
   unaffected and never recompute. Without this, every new message would
   invalidate every loaded page of every scrollback in the group — the exact
   over-invalidation the seam forbids. The interval is recorded in the same byte
   encoding regardless of tier, and travels as `SerializedKeyRange`.
3. **The MVCC snapshot seam is the only storage coupling.** `index_scan(...,
   readTimestamp, ...)` is the entire storage contract a page needs. A long
   scroll pins one `readTimestamp` → snapshot-consistent. Swapping Tier-0 SQLite
   for a Tier-2 sharded committer changes *which* `DocStore` instance answers, not
   the `QueryRuntime`. A scan hits exactly one shard (the conversation's),
   so recorded ranges are shard-local by construction; the `shardId` rides
   alongside without the engine changing.
4. **The `QueryJournal` is an opaque serializable string in the protocol.** It
   pins the loaded window's end cursor so a *reactive* paginated list stays
   gapless as data shifts. It is produced/consumed identically whether the sync
   handler is a loopback (Tier 0) or a fleet Durable Object (Tier 2) — the journal
   is just bytes the client echoes back in its `Add`.
5. **Wire-encoding independence.** Results leave as `Value[]`; the read footprint
   leaves as `SerializedKeyRange[]`. A later binary-delta protocol diffs results
   without touching planning, scanning, cursors, or interval recording — those are
   below the wire.

What is deferred (and provably layer-on, not rewrite): retention/compaction policy
(never GC a live revision while compacting dead intermediate ones, keyed off the
oldest live snapshot) — the *read path* is complete in Foundation; only the GC
*policy* is later. Range-precise **subscription matching** (interval tree) is the
sync tier's optimization over the same `RangeSet` we already emit.

---

## 10. Failure & edge handling

| Case | Behavior |
|---|---|
| `withIndex` names unknown index | `UnknownIndexError` (developer error, surfaced with index name + table). |
| No `withIndex` | `table-scan` plan; `readSet.addTableScan(tableId)` — whole-table dependency (coarse but correct). |
| Non-prefix `Eq` / 2nd inequality field / disjunction in `withIndex` range | Not pushable: widened to the legal prefix + moved to residual `filter` (§5.1a). Correct, less precise. |
| Impossible interval (`gt(5).lt(3)` ⇒ start ≥ end) | Empty result; record the (empty) interval so nothing invalidates. No scan issued. |
| `extractIndexKey` returns `null` (missing field) | Doc absent from that index: on write emit no entry; on read it never surfaces. |
| Corrupt / truncated cursor | `InvalidCursorError` → client treats as **full resync** (re-paginate from first page). |
| Cursor `indexKey` arity ≠ plan `indexFields` arity, or journal `indexDescriptor` ≠ plan's | `InvalidCursorError` (cursor belongs to a different query/index) → resync. |
| Cursor order ≠ query order | `InvalidCursorError` → resync (prevents silent gaps). |
| `.unique()` sees 2 rows | `NotUniqueError`. `.first()` on empty ⇒ `null`. |
| Selective post-filter (page returns `< limit`) | `hasMore: true`, cursor past last *examined* entry; documented read-amplification = `limit` index entries/page. |
| Scan hits index end before `limit` | `hasMore: false`; recorded interval end = index bound (`null` ⇒ +∞) so tail inserts invalidate the last page. |
| Headroom exceeded mid-scan (`documentsRead`/`databaseQueries`) | `QueryLimitError`; partial read set discarded by the caller (transaction aborts, not a conflict). |
| `_id`-valued `db.get` of absent doc | `null`; record a **point** range `[key,key]` so a later phantom insert conflicts/invalidates (version=`null` recorded by the transactor). |
| RYOW: staged delete of a row inside a scanned range | Row removed from results; the range is still recorded (a later real insert there must invalidate). |
| `NaN` / `-0`/`+0` / bigint-vs-float keys | Never compared natively; codec defines the order, `compareIndexKeys` is the sole arbiter for sort, cursor, and range membership. |
| Search/vector query at Tier 0 (FTS not enabled) | `runSearchAction` throws "search capability not enabled"; the planner still produces a `SearchPlan` so wiring is ready. |

---

## 11. Test strategy

The codec's own round-trip/ordering proof is the **`index-key-codec`
component's** acceptance gate. This component adds the tests that prove the *query
engine* uses it correctly and that the reactive contracts hold.

### 11.1 Unit

- **`rangeExpressionsToIndexBounds`** table-driven over the §5.2 examples + sign
  boundaries (negative floats, bigint > 2⁵³, empty prefix → `null` end, Gt
  successor vs Gte inclusive).
- **`generateUpdates`**: insert ⇒ N `NonClustered`; delete ⇒ N `Deleted`; update
  with unchanged index fields ⇒ **0 updates** (no-op); update that moves a key ⇒
  exactly 1 delete + 1 insert for the moved index, 0 for unmoved indexes;
  `extractIndexKey` → `null` on missing field ⇒ no entry.
- **Cursor & journal** encode/decode round-trip; arity-mismatch and
  wrong-index/wrong-order journals raise `InvalidCursorError`.
- **`evaluateFilter`** truth tables incl. nested `$and/$or/$not`, arithmetic,
  dotted paths, missing fields → `undefined` semantics; comparisons agree with
  `compareIndexKeys`.
- **Planner**: push-down classification for each shape in §5.1a; unknown index
  throws.

### 11.2 Property (the load-bearing ones)

- **Ordering agreement (P1).** For random docs + a random index: the order of
  `evaluate()` results == `sortByIndexFields` order ==
  `compareIndexKeys`-on-encoded-keys order == the order `index_scan` yields. Any
  disagreement fails. (Guards the "sort and cursor can never disagree" rule.)
- **Gapless pagination (P2).** For random docs, random `limit`, both orders:
  concatenating all pages via `nextCursor` == the full `collect()` result, exactly
  once each, in order, with no gaps or duplicates.
- **Stable under concurrent head-insert (P3) — the seam test.** Snapshot a
  conversation; paginate `.order("desc")` page-by-page while interleaving inserts
  at the head (new `_id`s, same/incrementing `_creationTime`) and tail. Assert:
  (a) every row of the *original snapshot* is returned exactly once across the
  scroll; (b) no original row is skipped or duplicated; (c) pages read at a pinned
  `readTimestamp` are snapshot-consistent; (d) head inserts never appear in pages
  whose interval is below them.
- **Precise interval (P4).** After a page, assert the recorded `KeyRange`:
  contains every examined key; for `hasMore` excludes any key strictly past the
  last examined (a synthetic write there yields `intersects()===false`); for
  `!hasMore` end is the index bound (a tail write yields `intersects()===true`).
- **`RangeSet.intersects` differential (P5).** Random read ranges + random write
  keys: `intersects` agrees with a brute-force "is the write key within any
  recorded `[lo,hi)` (null=+∞, point=[k,k])" oracle.
- **No-op churn (P6).** Random update streams: the count of emitted index updates
  equals the number of indexes whose extracted key actually changed (never more).

### 11.3 OCC conflict cases (the matrix — proves read-set correctness)

Drive a record→commit-elsewhere→validate loop using only the `RangeSet` +
synthetic writes (transactor stubbed):

| Scenario | Expected |
|---|---|
| Insert a row **inside** a scanned page interval | CONFLICT / invalidate |
| Insert a row **after** last-examined key (page `hasMore`) | NO conflict |
| Insert at tail when page was `hasMore:false` | CONFLICT (interval ⇒ +∞) |
| **Head insert** while paginating older (disjoint-interval) pages | NO conflict on older pages (stable scrollback) |
| Update a row in-page so its index key moves **out** of the interval | CONFLICT (delete from interval) |
| Update a row's *non-indexed* field only (key unchanged) | NO index update emitted (P6) ⇒ NO invalidation of index subscribers |
| Point `db.get(absent)` then that id inserted | CONFLICT (phantom; point range matched) |
| Write to a **different table** | NO conflict (tableId namespace mismatch) |

These assert the same `RangeSet`/`intersects` machinery is simultaneously correct
for OCC (component 02) and subscription invalidation (component 03) — the
double-duty that makes the reactive core cheap.

---

## 12. Open issues

- **Boundary with `index-key-codec` on `extractIndexKey`.** We place
  `extractIndexKey` (doc+field-paths → key) in the Query Engine and keep the pure
  value-tuple codec in the sibling. Confirm the sibling exposes exactly
  `encodeIndexKey`/`compareIndexKeys`/`indexKeysEqual`/`indexKeyRangeStart`/
  `indexKeyRangeEnd` and nothing doc-aware, so there is no overlap.
- **Tiebreaker shape.** We lower every index to append `_creationTime` **then**
  `_id`. Confirm against the schema-lowering component that table scans use the
  same `[_creationTime,_id]` standard index, so cursor stability and default
  ordering match end to end. (Affects `getStandardIndexes`.)
- **Page-size = `limit` index entries (Convex parity) vs. fill-to-`limit`
  survivors.** We chose "scan exactly `limit` entries" to bound read amplification
  and keep the interval precise; verify this matches Convex client expectations
  for `.paginate()` (filtered pages can be short with `isDone:false`).
- **`RangeSet` ownership vs. the transactor's `ReadVersion`.** We own the range
  representation; component 02 owns the version union and validation. Confirm 02
  imports `KeyRange`/`RangeSet` from here rather than redefining, so there is one
  canonical structure.
- **Range coalescing.** Many adjacent point/range reads could be merged into
  fewer `KeyRange`s to shrink the serialized footprint. Deferred; measure first
  (premature coalescing can hide a real dependency and cause missed invalidations).
- **Multi-range / disjoint queries.** Currently degraded to a wider scan +
  post-filter. If real workloads need true `OR`-of-ranges precision, a later
  multi-interval plan can emit several `KeyRange`s — additive, no contract change.
- **Search/vector reactivity granularity.** `SearchPlan.filterMap`/`indexIdHex`
  imply whole-index dependencies; the precise read-set story for FTS/vector is a
  later (Search slice) decision. Foundation ships the plan shape and capability
  stubs only.
- **Headroom limit values.** The concrete `documentsRead`/`databaseQueries` caps
  and where mid-scan enforcement fires are owned by the transactor; we call the
  tracker but do not set the numbers.
