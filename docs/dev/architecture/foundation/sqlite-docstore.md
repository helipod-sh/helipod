---
title: Foundation — SQLite DocStore (3-Table MVCC)
slug: sqlite-docstore
status: design (implementation-ready)
audience: engineering (internal)
depends_on: [index-key-codec, document-identity-registry]
clean_room: true
---

# SQLite DocStore (3-Table MVCC)

> **Clean-room.** This design was written from the [internals notes](../internals/README.md)
> (themselves clean-room paraphrases of the published `@concavejs/*` `.d.ts` contracts,
> FSL-1.1-Apache-2.0). We preserve only the handful of **interop facts** that the Convex
> client and the transactor above us depend on (method names the transactor calls, the MVCC
> log shape, table-number reservations). Everything below is our own implementation intent.
> No concave source is copied.
>
> **Grounding:** [system-design](../system-design.md) §5 (the narrow storage seam),
> [strategy](../strategy.md) (SQLite↔Postgres is the canonical scaling path; clean-room MIT),
> [scalability-spectrum](../scalability-spectrum.md) seam rows **1 / 4 / 8**,
> [internals/01-storage](../internals/01-storage.md) (primary),
> [internals/02-transactions-consistency](../internals/02-transactions-consistency.md),
> [internals/04-query-engine](../internals/04-query-engine.md),
> [internals/06-runtimes-topology](../internals/06-runtimes-topology.md).

---

## 1. Purpose & boundaries

The DocStore is **Tier 0's storage backend**: a single-writer, append-only **MVCC document
log** over **three physical SQLite tables**, hidden behind one narrow, timestamp-aware
contract. It is the lowest layer of the engine — the transactor, query engine, index
maintenance, and scheduler are all built on its primitives. It is deliberately **"dumb about
transactions"**: it exposes ordered point-in-time scans, atomic batch writes, revision-chain
lookups, and a change-feed; the *transactor* (a separate component) composes those into
serializable OCC transactions.

### What it OWNS

1. **The append-only MVCC log.** The `documents` table — every write appends a new
   `(ts, table_id, id, …)` revision; nothing is updated in place. A point-in-time read is
   "newest revision per key with `ts <= readTimestamp`."
2. **The three physical tables** — `documents`, `indexes`, `persistence_globals` — and their
   DDL/`PRAGMA` setup. The "one physical table per concern, many logical tables/indexes inside,
   discriminated by an id column, versioned by `ts`" layout. Adding a user table or index is a
   **metadata operation, never a DDL migration**.
3. **The MVCC read primitives.** `index_scan` (ordered point-in-time range read that
   deduplicates to latest-visible-per-key), `get`, `count`, `scan`, `scanPaginated`.
4. **The atomic batch `write`** — applies a batch of `DocumentLogEntry` revisions + their
   `DatabaseIndexUpdate` index rows in **one DB transaction**, under a `conflictStrategy`.
5. **The OCC revision-chain lookups** — `previous_revisions` (find-the-predecessor) and
   `previous_revisions_of_documents` (exact `prev_ts` link). These are the raw material the
   transactor's validation phase consumes; the DocStore does **not** itself validate.
6. **The durable change-feed** — `load_documents(tsRange)`: a gap-free, `ts`-ordered async
   stream of *raw* log entries (including tombstones and superseded revisions). This is the
   replication / reactive-subscription tailing primitive.
7. **The globals KV** — `persistence_globals`: `getGlobal` / `writeGlobal` /
   `writeGlobalIfAbsent` (compare-and-set) for engine bookkeeping.
8. **The per-shard `TimestampOracle`** — the single source of monotonic logical time for this
   one single-writer domain. One oracle instance per DocStore instance.
9. **The three-tier adapter layering** — the adapter-agnostic engine (`BaseSqlDocStore`), the
   narrow platform seam (`DatabaseAdapter`), the concrete `node:sqlite` backend
   (`SqliteDocStore` + `NodeSqliteAdapter` + the serialized transaction runner).

### What it does NOT own (hard boundaries)

- **OCC validation, read/write-set tracking, retry, `CommitResult`, invalidation deltas** →
  the **transactor** ([internals/02](../internals/02-transactions-consistency.md)). The DocStore
  surfaces `previous_revisions*` and atomic `write`; the transactor decides *whether* to commit.
- **The order-preserving index-key byte format** (`encodeIndexKey` / `compareIndexKeys`) →
  dependency **`index-key-codec`**. The DocStore stores and **byte-compares** key bytes; it
  never interprets them. SQLite's default `BLOB` collation is plain `memcmp`, which is exactly
  the order the codec guarantees — that alignment is load-bearing.
- **Developer-facing id strings, `InternalDocumentId`, the table registry, and the
  `table_id`/`index_id` keyspace derivation** → dependency **`document-identity-registry`**.
  The DocStore receives already-derived `TableId` / `IndexId` storage keys and
  `InternalDocumentId` values; it derives `table_id` from an `InternalDocumentId` only via the
  injected keyspace codec.
- **Query planning, `.filter()`/post-processing, cursors-as-Convex-API, reactivity** → the
  query engine and sync tier. The DocStore's `scanPaginated` cursor is an *internal* admin/scan
  cursor, distinct from the query engine's `(indexKey, _id)` `IndexCursor`.
- **Convex value (de)serialization of the document body** → the `convex/values` codec. The
  DocStore stores the body as a serialized `json_value` string via an injected
  `encodeValue`/`decodeValue` pair (handles `bigint`/`Int64`, bytes, etc.); it does not define
  the value format.
- **Compaction / garbage collection** of dead revisions — explicitly out of the core contract
  (see Open Issues).

---

## 2. The data model (MVCC document log)

The fundamental record is the **`DocumentLogEntry`**: a single revision of one document at one
logical timestamp. Per-document `prev_ts` back-pointers form a **backward-linked revision
chain** (`latest → prev_ts → prev_ts → … → null`). A snapshot read walks to the newest link
with `ts <= readTimestamp`.

```
documents (one logical table "messages", document id = X):

  ts=5  id=X  value={body:"hi"}     prev_ts=3   ◄── latest
  ts=3  id=X  value={body:"hey"}    prev_ts=1
  ts=1  id=X  value={body:"yo"}     prev_ts=null ◄── first revision

  read @ readTimestamp=4  ⇒  the ts=3 revision  (newest with ts <= 4)
  read @ readTimestamp=5  ⇒  the ts=5 revision
```

Index entries are versioned the **same way**: an index row is `(index_id, key, ts) →
{NonClustered doc_id | Deleted}`. An index scan at `readTimestamp` reconstructs the index as it
existed at that instant — identical MVCC discipline. Because a document revision **and** its
index updates are written **atomically at the same `ts`** (§5.3), the index is always
self-consistent with the documents at any snapshot: if a document moved out of a key, a
`Deleted` index row exists at that same `ts` and shadows the old entry.

Snapshot isolation therefore reduces to one rule, applied uniformly to documents and indexes:

> **filter to `ts <= readTimestamp`, take the max-`ts` row per key, drop it if it is a
> tombstone.**

---

## 3. Concrete TypeScript contracts

These are the interfaces other components compile against. Package: `@stackbase/docstore`
(contracts + adapter-agnostic engine). Concrete backend: `@stackbase/docstore-node`.

### 3.1 Core value & log types — `contract/types.ts`

```ts
// ── Identifiers (opaque here; produced by @stackbase/document-identity) ──────────────
/** Storage keyspace id for a logical table — the canonical string from
 *  document-identity's `encodeStorageTableId(tableNumber)` (e.g. "t…"). Opaque to the
 *  DocStore: the engine maps it to the `table_id` BLOB via the injected keyspace codec
 *  (§3.7); it never parses it. Branded so it can't be confused with an arbitrary string. */
export type TableId = string & { readonly __brand: "TableId" };
/** Storage keyspace id for a logical index — document-identity's
 *  `encodeStorageIndexId(tableNumber, indexName)`. Same opacity/mapping rule as TableId. */
export type IndexId = string & { readonly __brand: "IndexId" };
/** Order-preserving encoded composite index key (from @stackbase/index-key-codec). */
export type IndexKeyBytes = Uint8Array;
/** Partition identity (owned by @stackbase/document-identity). Tier 0 is always "default";
 *  Tier 2 derives one per conversation. */
export type ShardId = string;

/** Internal document identity (owned by @stackbase/document-identity). */
export interface InternalDocumentId {
  readonly tableNumber: number;      // system 1–9999, user tables 10001+
  readonly internalId: Uint8Array;   // 16 CSPRNG bytes
}

// ── Document bodies ──────────────────────────────────────────────────────────────────
/** A user-facing object: _id + _creationTime + arbitrary Convex-value fields. */
export type DocumentBody = {
  readonly _id: string;            // developer-facing id string
  readonly _creationTime: number;  // wall-clock ms, assigned by the transactor at insert
  readonly [field: string]: unknown;
};

/** The resolved document the store persists/returns: internal identity + body. */
export interface ResolvedDocument {
  readonly id: InternalDocumentId;
  readonly value: DocumentBody;
}

// ── The MVCC log ───────────────────────────────────────────────────────────────────
export interface DocumentLogEntry {
  readonly ts: bigint;                       // logical commit timestamp of this revision
  readonly id: InternalDocumentId;           // which document
  readonly value: ResolvedDocument | null;   // null ⇒ delete tombstone
  readonly prev_ts: bigint | null;           // back-pointer; null ⇒ first revision
}

/** What MVCC reads return: the resolved current-as-of-snapshot revision. */
export interface LatestDocument {
  readonly ts: bigint;
  readonly value: ResolvedDocument;          // non-null: tombstones are filtered before returning
  readonly prev_ts: bigint | null;
}

// ── Index updates ─────────────────────────────────────────────────────────────────────
export type IndexUpdateValue =
  | { readonly type: "NonClustered"; readonly doc_id: InternalDocumentId }
  | { readonly type: "Deleted" };

export interface DatabaseIndexUpdate {
  readonly index_id: IndexId;
  readonly key: IndexKeyBytes;
  readonly value: IndexUpdateValue;
}

/** An index mutation stamped with the commit ts (written atomically with the documents). */
export interface IndexWrite {
  readonly ts: bigint;
  readonly update: DatabaseIndexUpdate;
}

// ── Scan / range primitives ──────────────────────────────────────────────────────────
export type Order = "asc" | "desc";
export type ConflictStrategy = "Error" | "Overwrite";

/** A byte interval over an index keyspace. start inclusive; end exclusive; end=null ⇒ +∞. */
export interface Interval {
  readonly start: IndexKeyBytes;
  readonly end: IndexKeyBytes | null;
}

/** Half-open logical-time window for the change-feed: [min, max). */
export interface TimestampRange {
  readonly min_timestamp_inclusive: bigint;
  readonly max_timestamp_exclusive: bigint;
}

// ── OCC chain-lookup query shapes ─────────────────────────────────────────────────────
export interface PrevRevQuery { readonly id: InternalDocumentId; readonly ts: bigint; }
export interface DocumentPrevTsQuery {
  readonly id: InternalDocumentId;
  readonly ts: bigint;
  readonly prev_ts: bigint | null;
}

// Stable string keys so callers can look results up out of the returned Map.
export function getPrevRevQueryKey(id: InternalDocumentId, ts: bigint): string;
export function getExactRevQueryKey(id: InternalDocumentId, ts: bigint, prev_ts: bigint | null): string;

// ── Admin/scan pagination (NOT the query engine's reactive cursor) ─────────────────────
export interface PaginatedScan {
  readonly documents: ReadonlyArray<readonly [InternalDocumentId, LatestDocument]>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export interface SchemaSetupOptions {
  readonly searchIndexes?: readonly SearchIndexConfig[];   // §3.4 — deferred capability
  readonly vectorIndexes?: readonly VectorIndexConfig[];   // §3.4 — deferred capability
}
```

### 3.2 The `DocStore` contract — `contract/docstore.ts`

The narrow seam. Anything that can satisfy it — SQLite, Postgres, a sharded committer — is a
valid backend. **This is the keystone of deploy-anywhere; a leak of backend-specific behavior
out of this contract is a design bug, not a feature.**

```ts
export interface DocStore {
  /** Idempotently create the three tables + their indexes; configure optional FTS/vector meta.
   *  Called once on open. Also seeds the oracle from the persisted high-water ts (§6, §7). */
  setupSchema(options?: SchemaSetupOptions): Promise<void>;

  // ── MVCC reads (the hot path) ────────────────────────────────────────────────────────
  /** Walk an index interval at a snapshot, in key order, yielding the newest visible
   *  revision of each key (skipping tombstoned keys). Ordered, point-in-time, streaming. */
  index_scan(
    indexId: IndexId,
    tableId: TableId,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncIterable<readonly [IndexKeyBytes, LatestDocument]>;

  /** Newest visible revision of one document as of a snapshot, or null (absent/deleted). */
  get(id: InternalDocumentId, readTimestamp: bigint): Promise<LatestDocument | null>;

  /** Count of live (non-tombstoned) documents in a table as of a snapshot. */
  count(tableId: TableId, readTimestamp: bigint): Promise<number>;

  /** Whole-table scan: newest visible revision per id, in id order. */
  scan(
    tableId: TableId,
    readTimestamp: bigint,
    order?: Order,
  ): AsyncIterable<readonly [InternalDocumentId, LatestDocument]>;

  /** Cursor page of a table scan (admin/data-browser/export). Pinned to readTimestamp. */
  scanPaginated(
    tableId: TableId,
    cursor: string | null,
    limit: number,
    order: Order,
    readTimestamp: bigint,
  ): Promise<PaginatedScan>;

  // ── Writes ────────────────────────────────────────────────────────────────────────────
  /** Atomically apply a batch of document revisions + index updates in one DB transaction.
   *  The transactor has already allocated `ts` (stamped on every entry) and built both lists.
   *  shardId is carried from day one (Tier 0: always "default"; asserted == this.shardId). */
  write(
    documents: readonly DocumentLogEntry[],
    indexes: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void>;

  // ── OCC revision-chain lookups (raw material for the transactor's validation) ──────────
  /** For each {id, ts}: the revision current *just before* ts (max ts' < ts), or null.
   *  Result keyed by getPrevRevQueryKey(id, ts). */
  previous_revisions(
    queries: readonly PrevRevQuery[],
  ): Promise<Map<string, LatestDocument | null>>;

  /** Precise single-link lookup: the exact revision at (id, prev_ts). Cheaper than a search.
   *  Result keyed by getExactRevQueryKey(id, ts, prev_ts). */
  previous_revisions_of_documents(
    queries: readonly DocumentPrevTsQuery[],
  ): Promise<Map<string, LatestDocument | null>>;

  // ── Durable change-feed / log tailing ──────────────────────────────────────────────────
  /** Stream EVERY raw log entry whose ts ∈ [min, max), in ts order. Includes tombstones and
   *  superseded revisions (NOT deduplicated). Gap-free and replayable — the change-feed. */
  load_documents(range: TimestampRange, order?: Order): AsyncIterable<DocumentLogEntry>;

  // ── Globals KV ──────────────────────────────────────────────────────────────────────────
  getGlobal(key: string): Promise<string | null>;
  writeGlobal(key: string, value: string): Promise<void>;
  /** Compare-and-set: write only if absent. Returns true if it wrote (one-time bootstrap). */
  writeGlobalIfAbsent(key: string, value: string): Promise<boolean>;

  // ── Identity / time for this single-writer domain ──────────────────────────────────────
  readonly oracle: TimestampOracle;   // one per instance == one per shard (§6)
  readonly shardId: ShardId;          // this storage instance's partition ("default" at Tier 0)
}
```

### 3.3 The `TimestampOracle` — `contract/timestamp-oracle.ts`

The per-shard logical clock. **Per-instance**, by construction: one oracle per DocStore
instance is the single source of logical time for that single-writer domain. (`ts` is purely
logical; `_creationTime` is a separate wall-clock field on the body — they do not share a
source.)

```ts
export interface TimestampOracle {
  /** Peek current logical time WITHOUT advancing — the snapshot timestamp for reads. */
  getCurrentTimestamp(): bigint;
  /** Alias of getCurrentTimestamp, named for the begin-snapshot call site. */
  beginSnapshot(): bigint;
  /** Advance and return a strictly-increasing, unique timestamp (sync). */
  allocateTimestamp(): bigint;
  /** Advance with serialization guarantees so concurrent async callers never collide. */
  allocateTimestampAsync(): Promise<bigint>;
  /** Advance the clock to at least `ts` (recovery on open; failover in Tier 2). Never regresses. */
  observeTimestamp(ts: bigint): void;
}
```

### 3.4 Optional capabilities — `contract/search.ts`

Search and vector are **capability interfaces**, feature-detected — never assumed. The core
`DocStore` is search-agnostic; a backend advertises support by *also* implementing the extra
interface. (Foundation ships **neither**; this reserves the shape so FTS5/`sqlite-vec` land as a
later capability module without touching the core contract.)

```ts
export interface SearchIndexConfig { readonly indexId: IndexId; readonly field: string; }
export interface VectorIndexConfig { readonly indexId: IndexId; readonly field: string; readonly dimensions: number; }
export interface SearchFilter { readonly [field: string]: unknown; }

export interface SearchQuery {
  readonly indexId: IndexId; readonly tableId: TableId; readonly readTimestamp: bigint;
  readonly search: string; readonly filter?: SearchFilter; readonly limit?: number;
}
export interface SearchResult { readonly id: InternalDocumentId; readonly document: LatestDocument; readonly score: number; }
export interface SearchCapable { search(query: SearchQuery): Promise<readonly SearchResult[]>; }

export interface VectorSearchQuery {
  readonly indexId: IndexId; readonly tableId: TableId; readonly readTimestamp: bigint;
  readonly vector: Float32Array; readonly limit?: number; readonly filter?: SearchFilter;
}
export interface VectorSearchResult { readonly id: InternalDocumentId; readonly document: LatestDocument; readonly score: number; }
export interface VectorSearchCapable { vectorSearch(query: VectorSearchQuery): Promise<readonly VectorSearchResult[]>; }

export function isSearchCapable(store: DocStore): store is DocStore & SearchCapable;
export function isVectorSearchCapable(store: DocStore): store is DocStore & VectorSearchCapable;
```

### 3.5 The platform seam — `DatabaseAdapter` — `adapter/database-adapter.ts`

Stackbase's name for the Tier-B I/O seam (concave's `SqliteAdapter`). The **entire** surface a
new backend implements; everything else is inherited from `BaseSqlDocStore`. This is the
SQLite→Postgres scaling path (§7.1).

```ts
export type SqlValue  = string | number | bigint | boolean | null | Uint8Array;
export type SqlParam  = SqlValue;
export type SqlRow    = Record<string, SqlValue>;
export interface RunResult { readonly changes: number | bigint; readonly lastInsertRowid?: number | bigint; }

export interface PreparedStatement {
  // Each may be sync or async — covers synchronous bindings (node:sqlite) and async (D1).
  get(...params: SqlParam[]): SqlRow | undefined | Promise<SqlRow | undefined>;
  all(...params: SqlParam[]): SqlRow[] | Promise<SqlRow[]>;
  run(...params: SqlParam[]): RunResult | Promise<RunResult>;
  /** Optional streaming. BaseSqlDocStore prefers it for large scans; falls back to windowed
   *  all() batches when absent (e.g. D1). */
  iterate?(...params: SqlParam[]): IterableIterator<SqlRow> | AsyncIterableIterator<SqlRow>;
}

export interface DatabaseAdapter {
  exec(sql: string): void | Promise<void>;                       // schema DDL / PRAGMA
  prepare(sql: string): PreparedStatement;                       // cached upstream by the engine
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;          // one DB transaction
  /** Convert engine bytes ⇄ the backend's native blob type (node:sqlite: identity Uint8Array;
   *  D1: ArrayBuffer). Keeps blob handling out of the engine SQL. */
  toBlob(bytes: Uint8Array): SqlParam;
  fromBlob(value: SqlValue): Uint8Array;
  close?(): void | Promise<void>;
}
```

### 3.6 Serialized transaction runner — `adapter/transaction-runner.ts`

`node:sqlite` is **synchronous**, but the adapter contract permits async callbacks. MVCC
correctness depends on writes being **serialized on one connection**. The runner threads all
transactions through a single promise-chained queue so async callbacks cannot interleave —
preserving single-writer semantics even when surrounding code is async.

```ts
export interface TransactionHooks {
  begin(): void | Promise<void>;     // e.g. "BEGIN IMMEDIATE"
  commit(): void | Promise<void>;    // "COMMIT"
  rollback(): void | Promise<void>;  // "ROLLBACK"
}
export interface SerializedTransactionRunner {
  run<T>(fn: () => T | Promise<T>): Promise<T>;
}
/** Returns a runner whose run() calls are strictly serialized (no overlap), each wrapping
 *  fn in begin/commit, rolling back + rethrowing on error. */
export function createSerializedTransactionRunner(hooks: TransactionHooks): SerializedTransactionRunner;
```

### 3.7 Concrete Node backend — `@stackbase/docstore-node`

```ts
export interface NodeSqliteDocStoreOptions {
  readonly dbPath: string;                          // ":memory:" for tests
  readonly durability?: "balanced" | "strict";      // default "balanced"
  readonly shardId?: ShardId;                        // default "default"
  /** Injected value codec (from convex/values). Defaults provided by the engine package. */
  readonly encodeValue?: (v: ResolvedDocument) => string;
  readonly decodeValue?: (s: string) => ResolvedDocument;
}

/** Concrete Tier-0 store: composes BaseSqlDocStore over a node:sqlite DatabaseSync. */
export class SqliteDocStore extends BaseSqlDocStore {
  constructor(options: NodeSqliteDocStoreOptions);
  close(): void;
}

/** Tier-C adapter: implements DatabaseAdapter via node:sqlite + the serialized runner. */
export class NodeSqliteAdapter implements DatabaseAdapter {
  constructor(db: import("node:sqlite").DatabaseSync, durability: "balanced" | "strict");
  // exec/prepare/transaction/toBlob/fromBlob/close …
}
```

---

## 4. Physical schema

Three fixed tables. **One physical table per concern, many logical tables/indexes inside,
discriminated by an id column, versioned by `ts`.** No per-user-table DDL ever.

```sql
-- The MVCC document log.
CREATE TABLE IF NOT EXISTS documents (
  ts          INTEGER NOT NULL,        -- bigint logical commit ts (node:sqlite bigint binding)
  table_id    BLOB    NOT NULL,        -- logical table keyspace key (from document-identity)
  id          BLOB    NOT NULL,        -- 16-byte internalId
  json_value  TEXT,                    -- serialized ResolvedDocument; NULL for a tombstone
  deleted     INTEGER NOT NULL DEFAULT 0,
  prev_ts     INTEGER,                 -- chain back-pointer; NULL = first revision
  PRIMARY KEY (ts, table_id, id)
) WITHOUT ROWID;
-- "latest revision of this doc" and per-table scans:
CREATE INDEX IF NOT EXISTS documents_by_doc ON documents (table_id, id, ts);

-- ALL logical indexes live here, discriminated by index_id; MVCC-versioned by ts.
CREATE TABLE IF NOT EXISTS indexes (
  index_id    BLOB    NOT NULL,        -- logical index keyspace key
  key         BLOB    NOT NULL,        -- order-preserving encoded composite key (codec bytes)
  ts          INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  table_id    BLOB    NOT NULL,
  document_id BLOB    NOT NULL,        -- 16-byte internalId the key points at
  PRIMARY KEY (index_id, key, ts)
) WITHOUT ROWID;

-- Engine bookkeeping (schema version, table-registry metadata, oracle high-water, migrations).
CREATE TABLE IF NOT EXISTS persistence_globals (
  key         TEXT PRIMARY KEY,
  json_value  TEXT NOT NULL
) WITHOUT ROWID;
```

**Why these keys.**
- `documents PRIMARY KEY (ts, table_id, id)` gives the log its append/time order and makes
  `load_documents` a contiguous `ts`-range scan. `documents_by_doc (table_id, id, ts)` makes
  "newest revision of this id `<= T`" and per-table scans index-only range probes.
- `indexes PRIMARY KEY (index_id, key, ts)` means a range scan walks `key` order *within* an
  `index_id`; the trailing `ts` lets the engine pick the max-`ts <= readTimestamp` per key.
  **BLOB comparison = `memcmp` = the codec's logical order** — the single alignment the whole
  read path rests on.
- `WITHOUT ROWID` keeps these as clustered B-trees on their composite PKs (no rowid hop).

**Optional FTS5 search table** (created lazily by the search capability module, not Foundation):
a single `search_indexes(index_id, document_id, ts, deleted, search_body)` virtual table where
only `search_body` is tokenized — same "one physical table, many logical indexes" pattern.

---

## 5. Key algorithms

### 5.1 `index_scan` — windowed-streaming MVCC dedup (the hot path)

Given `(indexId, tableId, readTimestamp, interval=[start,end), order, limit?)`, return the
newest **visible** revision of each key. Memory is bounded by scanning in **key windows**, so a
billion-row index streams without materializing the interval.

```
function* index_scan(indexId, tableId, T, [start, end), order, limit):
  cursorKey  = (order == asc) ? start : (end ?? +∞-sentinel)   # window cursor
  produced   = 0
  loop:
    rows = SELECT key, ts, document_id, deleted
           FROM indexes
           WHERE index_id = :indexId
             AND key >= :start AND (:end IS NULL OR key < :end)   # interval bounds
             AND (order==asc ? key >= :cursorKey : key <= :cursorKey)
             AND ts <= :T                                          # MVCC visibility
           ORDER BY key (asc|desc), ts DESC
           LIMIT :WINDOW                                           # bound memory
    if rows is empty: return
    for each maximal run of rows sharing the same `key`:
      head = first row of the run        # max ts <= T, because ts DESC within key
      if head.deleted: continue          # tombstone shadows the key at this snapshot
      doc = resolveLatestVisible(tableId, head.document_id, T)   # §5.2; batched
      if doc is null: continue           # defensive: should not happen (atomic writes)
      yield [head.key, doc]
      produced += 1
      if limit && produced >= limit: return
    cursorKey = successor(lastKeyInBatch, order)   # advance past the window's last key
```

Key points:
- **Dedup is `ORDER BY key, ts DESC` + "first row per key".** The `LIMIT :WINDOW` bounds memory;
  `cursorKey` resumes strictly after the last key so windows never overlap or skip.
- **`limit` counts distinct visible documents, not raw rows** — hence dedup-then-count, never a
  raw SQL `LIMIT n` over the versioned rows.
- **`order: desc`** flips the key ORDER BY *and* the window direction; per-key dedup is
  unchanged (still max-`ts` first).
- If the adapter exposes `iterate()`, the engine streams a single ordered cursor instead of
  windowing — same dedup logic, one pass.
- The read **interval actually consumed** (start … last key examined) is what the query engine
  records as its read range; the DocStore yields keys in order so the engine can stop early and
  record a tight `[start, lastKey]` for a `limit`/page (avoids over-invalidation at fan-out
  scale).

### 5.2 `resolveLatestVisible` / `get` — newest visible revision of one id

```sql
SELECT ts, json_value, deleted, prev_ts
FROM documents
WHERE table_id = :tableId AND id = :id AND ts <= :T
ORDER BY ts DESC
LIMIT 1;
-- deleted=1 ⇒ return null (get) / skip (scan); else decodeValue(json_value) → LatestDocument
```

`get` derives `table_id` from `InternalDocumentId.tableNumber` via the injected keyspace codec,
then runs the above. Point reads issued during an `index_scan` are **batched**: the engine
collects the surviving `document_id`s of a window and resolves them with one
`WHERE table_id=? AND id IN (…) AND ts <= ?` query, deduplicating per id in memory.

### 5.3 `write` — atomic batch apply

```
async write(documents, indexes, conflictStrategy, shardId="default"):
  assert(shardId == this.shardId)                  # Tier 0: single shard
  await adapter.transaction(() => {                # ONE DB transaction (serialized runner)
    for entry in documents:
      table_id = keyspace.encodeTableId(entry.id.tableNumber)
      verb = conflictStrategy == "Overwrite" ? "INSERT OR REPLACE" : "INSERT"
      stmt(`${verb} INTO documents (ts,table_id,id,json_value,deleted,prev_ts) VALUES (?,?,?,?,?,?)`)
        .run(entry.ts, toBlob(table_id), toBlob(entry.id.internalId),
             entry.value ? encodeValue(entry.value) : null,
             entry.value ? 0 : 1, entry.prev_ts)
    for { ts, update } in indexes:
      deleted = update.value.type == "Deleted"
      stmt(`${verb} INTO indexes (index_id,key,ts,deleted,table_id,document_id) VALUES (?,?,?,?,?,?)`)
        .run(toBlob(update.index_id), toBlob(update.key), ts, deleted ? 1 : 0,
             toBlob(table_id_of(update)), toBlob(docIdOf(update) ?? ZERO16))
  })
```

- **All-or-nothing.** Documents and index rows commit together; a mid-batch failure rolls the
  whole transaction back (no half-written revision, no orphan index entry).
- **`conflictStrategy`.** `"Error"` is a plain `INSERT` — a duplicate `(ts, table_id, id)` PK
  raises (defensive; with a monotonic oracle the commit `ts` is always fresh, so this never
  fires on the happy path). `"Overwrite"` is `INSERT OR REPLACE` for idempotent replay/recovery.
- The DocStore does **not** allocate `ts` or compute index deltas — the transactor (with the
  `IndexManager` from the query-engine slice) did that and handed over finished lists.

### 5.4 `previous_revisions` & `previous_revisions_of_documents` (OCC raw material)

```sql
-- previous_revisions({id, ts}):  the predecessor (max ts' < ts)
SELECT ts, json_value, deleted, prev_ts FROM documents
WHERE table_id = :tableId AND id = :id AND ts < :ts
ORDER BY ts DESC LIMIT 1;            -- → LatestDocument | null,  keyed by getPrevRevQueryKey

-- previous_revisions_of_documents({id, ts, prev_ts}):  the EXACT link
SELECT ts, json_value, deleted, prev_ts FROM documents
WHERE table_id = :tableId AND id = :id AND ts = :prev_ts
LIMIT 1;                              -- → LatestDocument | null,  keyed by getExactRevQueryKey
```

A `null` result is meaningful — it tells the transactor the read saw *absence* (no predecessor),
which validation treats as a phantom-sensitive condition. Both methods batch their input set
into chunked `IN (…)` queries and return a `Map` keyed by the documented key helpers, so the
transactor can correlate each result to its query without relying on array position.

### 5.5 `load_documents` — the durable, ordered change-feed

```sql
SELECT ts, table_id, id, json_value, deleted, prev_ts FROM documents
WHERE ts >= :min AND ts < :max
ORDER BY ts ASC;        -- (or DESC); a contiguous range on the documents PK
```

Returns **raw** `DocumentLogEntry` rows — *every* revision and tombstone in the window, NOT
deduplicated. Properties that make it a change-feed (not just a query):
- **Gap-free & replayable.** Because commits use strictly-increasing oracle timestamps and the
  PK leads with `ts`, the entries in `[min, max)` are exactly the commits in that logical
  interval, in order. A consumer that remembers the last `ts` it saw resumes at
  `[lastTs+ε, …)` with no gaps or duplicates.
- **Streaming.** Backed by `iterate()` where available; otherwise paged by `ts` windows.
- **Tombstones included** — a tailer must learn about deletes.

### 5.6 The concrete `TimestampOracle` (`LogicalTimestampOracle`)

```
state: current: bigint            # strictly increasing; seeded on open
queue:  Promise chain             # serializes allocateTimestampAsync

getCurrentTimestamp(): return current
allocateTimestamp():   current = current + 1n; return current
allocateTimestampAsync(): enqueue(() => allocateTimestamp())     # never collide across async
observeTimestamp(ts):  if ts > current: current = ts             # monotone; never regress
```

On `setupSchema`/open, the engine seeds the oracle: `observeTimestamp(max(ts))` read from
`documents` **and** the persisted `persistence_globals["oracle.high_water"]` (whichever is
larger), guaranteeing the first new allocation is strictly greater than any committed `ts` — so
a restart never reuses or regresses logical time. (The high-water global is updated on commit so
recovery is O(1) and robust even if the newest revisions were compacted.)

---

## 6. How it works at Tier 0 (single binary) NOW

One `SqliteDocStore` over a single WAL file (or `:memory:` in tests), composed inside the
`EmbeddedRuntime` ([internals/06](../internals/06-runtimes-topology.md)) alongside the
transactor, executor, sync handler, and HTTP handler — **all in one process, no sidecar, no
network hop.**

- **One shard.** The whole DB is shard `"default"`, with exactly **one
  `LogicalTimestampOracle`**. `index_scan`/`get`/`write` are in-process function calls — the
  "database round-trip" is a memory access.
- **Single writer, serialized.** `node:sqlite`'s synchronous `DatabaseSync` is wrapped by
  `NodeSqliteAdapter`; every `write` runs inside `adapter.transaction(...)` via the
  **serialized transaction runner**, so even under async concurrency exactly one transaction
  touches the single connection at a time. WAL mode allows readers to proceed concurrently with
  the single writer.
- **Durability.** Default `"balanced"` = `journal_mode=WAL`, `synchronous=NORMAL`,
  `busy_timeout`. Opt-in `"strict"` = `synchronous=FULL`. We keep an **honest durable log** by
  default (no data-loss-by-default — system-design §9); relaxed flushing is the opt-in, not the
  default.
- **Commit → reactivity.** The transactor commits via `DocStore.write`, then publishes a
  `WriteInvalidation` through the in-memory `EmbeddedWriteFanout` to the in-process sync handler
  ([scalability-spectrum §2.4](../scalability-spectrum.md)). The **durable** `load_documents`
  feed exists and is correct, but Tier 0 doesn't need to tail it — direct in-process fan-out is
  enough. That the feed is *already* the durable backing is what makes Tier 2 free (§7.2).
- **Registry & identity.** `document-identity-registry` supplies `InternalDocumentId`, the
  `MemoryTableRegistry` (dev) or DocStore-backed durable registry (persists the `_tables`
  mapping *through this very store's globals/system table*), and the `table_id`/`index_id`
  keyspace derivation. `index-key-codec` supplies the `IndexKeyBytes` the `indexes.key` column
  stores and `memcmp`-orders.

Deployment = copy one file / `docker run` one container with a mounted volume for the DB. That
is the entire default product.

---

## 7. The scale seam — reserved so Endpoint B attaches with NO app-code/engine rewrite

The Foundation obligation is to keep three seams *present but trivial* at Tier 0 so the
WhatsApp-scale path is adapters + config, never a rewrite. The DocStore carries exactly these
three (scalability-spectrum rows **8 / 4 / 1**).

### 7.1 Substrate swap: `DocStore`/`DatabaseAdapter` is the SQLite→Postgres path (row 8)

`BaseSqlDocStore` holds **all** the engine logic (SQL builders, MVCC dedup, oracle, prepared-
statement cache) and delegates **every** I/O call to the narrow `DatabaseAdapter`
(exec/prepare/transaction/toBlob/fromBlob). Reaching Postgres is therefore:

```
@stackbase/docstore-postgres:
  class PostgresDocStore extends BaseSqlDocStore { /* ctor wires a PostgresAdapter */ }
  class PostgresAdapter implements DatabaseAdapter { /* pg pool: exec/prepare/transaction/blob */ }
```

**Zero engine change, zero app change.** The engine never learns whether it is on SQLite or
Postgres — the storage-contract invariant from [scalability-spectrum §4](../scalability-spectrum.md).
Postgres then supplies the durable, replica-backed substrate that **row 8 read-scaling** rides
on: a stateless executor pool reads at a snapshot `readTimestamp` against read replicas, scaling
reads horizontally while the contract is unchanged. (Dialect deltas — `INSERT OR REPLACE` →
`ON CONFLICT … DO UPDATE`, `BLOB` → `bytea`, `WITHOUT ROWID` → ordinary PK, the windowed dedup →
`DISTINCT ON (key) … ORDER BY key, ts DESC` — are isolated to a small dialect hook on the base,
identified in Open Issues; the *contract* and the SQL *shape* are portable by construction.)

### 7.2 `load_documents(tsRange)` is the change-feed a Tier 2 change-stream tails (row 4)

The same durable, gap-free, `ts`-ordered feed Tier 0 already has is exactly what the distributed
fan-out needs. At Tier 2, a committer's commit emits an `OplogDelta`
(`{commit_ts, shard_id, written_ranges, written_tables}`, wire-serializable) onto a **change
stream**; every sync node runs a `ChangeStreamConsumer` (`start`/`stop`/`onChanges`/
`getCurrentPosition`) that **tails `load_documents` from its last position forward** to learn
what changed and calls its *local* `notifyWrites`. Because `load_documents` is replayable:
- a sync node that restarts resumes from `getCurrentPosition()` with **no gaps, no dupes**;
- the transactor fans out to N nodes through the stream instead of N point-to-point posts;
- the payload is serializable (`SerializedKeyRange`) from day one.

Tier 0's in-process `EmbeddedWriteFanout` and Tier 2's durable-tail are the **same shape**; only
the transport differs. Foundation's job is simply to make `load_documents` honestly durable,
ordered, and resumable — which it is.

### 7.3 The per-instance `TimestampOracle` is per-shard (row 1)

The DocStore owns **exactly one** `TimestampOracle` — by construction it is *per shard*. Tier 0:
one DocStore = the whole DB = one shard `"default"` = one oracle. Tier 2:
`ShardRouter.getShardForDocument(conversationId)` routes each conversation to a committer that
owns **its own** `SqliteDocStore`/`PostgresDocStore` + **its own** oracle over **its own** shard
keyspace. Consequences already baked into the contract:
- `write(documents, indexes, strategy, shardId?)` and the instance's `readonly shardId` thread
  partition identity from day one (Tier 0 asserts `shardId === "default"`).
- `observeTimestamp` guarantees a shard never issues a `ts` behind one it has observed — the
  monotonicity needed for **restart and Tier-2 failover** of a committer.
- Per-conversation single-writer-per-shard ⇒ unbounded write scale: add shards (each a DocStore
  + oracle), never make a shard faster. **Cross-shard atomic writes are out of scope** (a
  transaction is shard-local — documented constraint, not a hidden limit).

---

## 8. Failure & edge handling

| Condition | Handling |
|---|---|
| **Oracle reuse/regress after crash** | On open, `observeTimestamp(max(documents.ts, globals.oracle.high_water))` before the first allocation. First new `ts` is strictly greater than any committed `ts`. High-water global updated per commit for O(1), compaction-robust recovery. |
| **`write` partial failure** | Whole batch runs in one `adapter.transaction`; any error rolls back — no half-written revision, no orphan index row. The serialized runner rethrows after `ROLLBACK`. |
| **Duplicate `(ts, table_id, id)` under `"Error"`** | Raises (defensive). Cannot happen on the happy path (fresh oracle ts). Signals a transactor bug or a recovery double-apply — surfaced, not swallowed. |
| **Idempotent replay / recovery** | `conflictStrategy: "Overwrite"` = `INSERT OR REPLACE`; re-applying a committed batch is a no-op-equivalent. |
| **Concurrent async writes** | Serialized transaction runner ⇒ exactly one transaction on the single connection at a time. Engine must **never** open a second writer connection (audited). |
| **Tombstone reads** | `deleted=1`/`value=null`: `get` → `null`, `index_scan`/`scan` skip the key. `load_documents` **includes** tombstones (a tailer must see deletes). |
| **Empty / open-ended interval** | `end=null` ⇒ scan to `+∞`. Empty interval (`start==end`) ⇒ yields nothing. Point read ⇒ `start==key, end=successor(key)`. |
| **Read of absence** | `get`/`previous_revisions` return `null`; the transactor's validation treats null specially (phantom-sensitive). The DocStore reports absence faithfully — it does not invent rows. |
| **Huge scans / OOM** | Windowed-streaming `index_scan`/`scan`/`load_documents` bound memory regardless of interval size; `iterate()` used when present. |
| **`bigint` ↔ SQLite INTEGER** | `node:sqlite` bigint binding enabled; `ts`/`prev_ts` round-trip as `bigint`. Adapter normalizes number↔bigint at the seam so the engine always sees `bigint`. |
| **Value codec edge types** | `json_value` via the injected Convex value codec (handles `Int64`/`bigint`, bytes, nested). DocStore never `JSON.parse`s a raw body itself. |
| **`:memory:` / fresh DB** | `setupSchema` is idempotent (`IF NOT EXISTS`); oracle seeds to `0n`; first allocation is `1n`. |
| **FTS5 / vector unavailable** | Backend **does not advertise** the capability (`isSearchCapable` false) rather than failing at query time; probed at `setupSchema`. |
| **WAL growth / checkpoint** | Default WAL auto-checkpoint; `close()` checkpoints. Compaction/retention of dead revisions is a **separate later policy** (Open Issues), not a read-path concern. |

---

## 9. Test strategy

Two backends are tested against **one shared conformance suite** so the seam is proven portable:
the suite runs against `NodeSqliteAdapter` now, and later against `PostgresAdapter` / a D1 mock
unchanged. (`:memory:` for speed; a temp-file run for durability/recovery cases.)

### 9.1 Unit — primitives

- **Schema idempotency:** `setupSchema` twice is a no-op; tables/indexes exist.
- **Write/get round-trip:** insert → `get@ts` returns the body; update appends a revision;
  `get` at an older `ts` returns the old body, at the new `ts` the new body.
- **Delete:** tombstone → `get` returns `null`; `load_documents` still includes the tombstone.
- **`previous_revisions`:** predecessor lookup across interleaved revisions of several ids;
  absence → `null`; map keyed by `getPrevRevQueryKey`. **`previous_revisions_of_documents`:**
  exact `(id, prev_ts)` link hits; wrong `prev_ts` → `null`.
- **Globals:** `getGlobal`/`writeGlobal`; `writeGlobalIfAbsent` returns `true` once then `false`
  (CAS), value unchanged on the second call.
- **`count` / `scan` / `scanPaginated`:** live-count excludes tombstones; scan yields
  latest-visible per id in id order; pagination is stable and pinned to `readTimestamp`
  (concurrent inserts after the page's snapshot do not appear mid-scroll).
- **`conflictStrategy`:** `"Error"` raises on duplicate PK; `"Overwrite"` re-applies idempotently.

### 9.2 Property — MVCC correctness (model-based)

A reference in-memory model (`Map<idKey, sorted revisions>`) is the oracle; generate random
op sequences (insert/update/delete across random ids/keys/fields at increasing `ts`) and assert:

- **Snapshot equivalence:** for random `readTimestamp` `T`, `index_scan(T)` / `scan(T)` /
  `get(T)` equal the model's latest-visible-per-key set as of `T`.
- **Snapshot stability:** the same scan at `T` is byte-identical *after* later writes land
  (immutability of the past).
- **Phantom visibility:** a row inserted at `ts2 > T` is invisible at `T` and visible at `ts2`
  (this underpins the transactor's phantom/OCC validation, which consumes these primitives).
- **Tombstone shadowing:** a key deleted at `ts_d <= T` is absent at `T`, present again at `T'`
  if re-inserted at `ts_r ∈ (ts_d, T']`.

### 9.3 Property — ordering & range semantics (cross-check with `index-key-codec`)

The codec's own exhaustive ordering proofs live in its package; here we prove the **store honors
that order end-to-end**:

- For random value tuples, `index_scan` emits keys in `compareIndexKeys` order for `asc`, and the
  exact reverse for `desc`. (Catches any `memcmp` ≠ codec-order drift, e.g. a backend whose BLOB
  collation isn't byte-order.)
- **Interval bounds:** `start` inclusive, `end` exclusive, `end=null` ⇒ to `+∞`; point interval
  yields exactly the one key; empty interval yields nothing.
- **`limit`:** returns the first `N` *distinct visible* documents (never `N` raw rows); the
  recorded read interval ends at the last key examined (page-tight, not whole-index).
- **Window seam:** results are identical whether scanned via `iterate()` (one cursor) or via
  forced small `WINDOW` batches (no overlaps/skips at window boundaries) — property-tested across
  random `WINDOW` sizes.

### 9.4 Change-feed — `load_documents`

- Returns **all** raw entries (every revision + tombstone) with `ts ∈ [min, max)`, in `ts` order
  (`asc` and `desc`).
- **Resumability:** tailing in chunks from the last-seen `ts` reproduces the full ordered stream
  with **no gaps, no duplicates** (random chunk boundaries) — the Tier-2 change-stream guarantee.

### 9.5 Oracle

- Strict-monotonic **uniqueness** under many concurrent `allocateTimestampAsync` (no collisions,
  fully ordered).
- `observeTimestamp` never regresses; an observed future `ts` advances subsequent allocations.
- **Restart recovery:** open a DB with prior revisions (and a high-water global) → first new
  allocation `>` every existing `ts`; verify even when the newest revisions are simulated-
  compacted (high-water still governs).

### 9.6 Transaction runner & durability

- Interleaved async `run()` callbacks never overlap (instrument with a shared "in-transaction"
  flag that must never be observed `>1`).
- Throwing inside `run()` rolls back: the DB shows **no** partial rows; the error propagates.
- **Crash/recovery (temp-file):** `write` then reopen (no `close`) → committed data present under
  `"strict"`; `balanced` documented as WAL-durability semantics. (`"strict"` sets
  `synchronous=FULL`.)

### 9.7 OCC-relevant integration (with the transactor harness)

Although OCC *validation* lives in the transactor, its correctness rests on these primitives, so
we test the conflict shapes at the boundary:

- **Stale point read:** read `id@T`, another commit advances `id` to `ts2 > T`,
  `previous_revisions({id, ts2})` reveals the intervening change → the transactor's validation
  flags a conflict. (Replay-on-conflict is the transactor's; we verify the *signal* the DocStore
  provides is correct.)
- **Lost-absence / phantom:** read absence of `id@T`; an insert lands at `ts2 > T`;
  `get(id, ts2)`/`previous_revisions` expose it → phantom conflict detectable.
- **Self-write exclusion:** a committed batch's own rows are visible to `get@commit_ts` (the
  transactor excludes them from conflict checks).

### 9.8 Capabilities

- A store without search: `isSearchCapable(store) === false`, no `search`/`vectorSearch` method.
- (When the capability module lands) the guards flip to `true` and the FTS5/vector path is
  exercised behind the same `DocStore` instance.

---

## 10. Package / module / file layout

```
packages/
  docstore/                          # @stackbase/docstore — contracts + adapter-agnostic engine
    src/
      contract/
        types.ts                     # DocumentLogEntry, LatestDocument, ResolvedDocument,
                                     #   DatabaseIndexUpdate, IndexWrite, IndexUpdateValue,
                                     #   Interval, TimestampRange, Order, ConflictStrategy,
                                     #   ShardId, TableId, IndexId, PrevRev*/PrevTs queries,
                                     #   PaginatedScan, key-helper fns
        docstore.ts                  # DocStore interface
        timestamp-oracle.ts          # TimestampOracle interface
        search.ts                    # SearchCapable / VectorSearchCapable + guards + configs
      engine/
        base-docstore.ts             # BaseSqlDocStore (abstract) implements DocStore
        schema.ts                    # the three-table DDL + PRAGMA-independent setup
        sql.ts                       # parameterized SQL builders / statement text
        index-scan.ts                # §5.1 windowed-streaming MVCC dedup
        mvcc.ts                      # resolveLatestVisible, batched point reads, prev-rev walks
        serialize.ts                 # json_value <-> ResolvedDocument (injected value codec)
        oracle.ts                    # LogicalTimestampOracle (concrete per-instance oracle)
        prepared-cache.ts            # prepared-statement cache keyed by SQL text
      adapter/
        database-adapter.ts          # DatabaseAdapter, PreparedStatement, SqlParam/Row, RunResult
        transaction-runner.ts        # createSerializedTransactionRunner
      index.ts                       # public barrel (contracts + base engine)
    tests/
      conformance/                   # the shared suite (run per adapter)
      property/                      # model-based MVCC + ordering + change-feed fuzz
      oracle.test.ts
      transaction-runner.test.ts
    package.json                     # deps: @stackbase/index-key-codec, @stackbase/document-identity

  docstore-node/                     # @stackbase/docstore-node — node:sqlite concrete backend
    src/
      node-sqlite-docstore.ts        # SqliteDocStore extends BaseSqlDocStore (+ close, options)
      node-sqlite-adapter.ts         # NodeSqliteAdapter implements DatabaseAdapter
      pragmas.ts                     # WAL / synchronous(NORMAL|FULL) / busy_timeout per durability
      index.ts
    tests/
      node-conformance.test.ts       # runs @stackbase/docstore conformance suite vs NodeSqliteAdapter
      durability.test.ts             # temp-file crash/recovery, strict vs balanced

  # (later, no engine change — proves the seam)
  # docstore-postgres/  @stackbase/docstore-postgres  — PostgresDocStore + PostgresAdapter
```

**Dependency direction:** `docstore-node` → `docstore` → `{ index-key-codec,
document-identity-registry }`. The transactor and query engine depend only on
`@stackbase/docstore`'s `contract/` exports — **never** on `docstore-node`. That is what makes a
backend swap invisible above the seam.

---

## 11. Open issues

(Carried from [internals/01](../internals/01-storage.md) / [internals/02](../internals/02-transactions-consistency.md)
plus decisions this design surfaces.)

1. **Compaction / retention policy.** The append-only log + index tombstones grow unbounded.
   Need GC keyed off the **oldest live read snapshot**, and it must not race `load_documents`
   tailers (a Tier-2 sync node resuming from an old position). This is the single biggest
   unspecified area. Decide: minimum retention window for the change-feed; how the oldest-snapshot
   watermark is tracked; whether compaction is online (background) or stop-the-world at Tier 0.
2. **`load_documents` retention vs. Tier-2 change-stream lag.** How far back may a restarted sync
   node resume? Couples directly to (1). Must define the durable retention horizon before Tier 2.
3. **Postgres dialect hook surface.** Confirm the minimal set of dialect deltas the base must
   expose (`INSERT OR REPLACE`→`ON CONFLICT`, `BLOB`→`bytea`, windowed dedup→`DISTINCT ON`,
   bigint binding, `WITHOUT ROWID`→PK) and that the windowed-streaming `index_scan` translates
   cleanly to a single keyset-paginated `DISTINCT ON` query — i.e. the SQL *shape* really is
   portable, not just the contract.
4. **Oracle durability proof.** Pin down that `max(committed ts)` is *always* read before the
   first allocation (including the compacted-newest-revisions case the high-water global guards),
   and decide whether `ts` stays a pure logical counter or becomes a hybrid logical/wall-clock
   value (affects nothing app-visible since `_creationTime` is separate, but affects debuggability
   and Tier-2 failover skew).
5. **Value-codec ownership boundary.** Fix the exact `encodeValue`/`decodeValue` seam to the
   `convex/values` codec (`Int64`/`bigint`, bytes, nested) and whether `json_value` is TEXT JSON
   or a binary value encoding — the store must not silently `JSON.parse` a raw body.
6. **`table_id` / `index_id` single canonical derivation.** With the legacy hex-table-name form
   dropped, audit every compare/serialize site so `table_id` is derived *only* via the
   `document-identity-registry` keyspace codec — one canonical path, no drift between write and
   scan.
7. **`index_scan` read-interval precision under `limit`/pagination.** Confirm "record up to the
   last key examined" (page-tight) with the query engine so reactive pages don't over-invalidate;
   property-test the boundary.
8. **Async-adapter concurrent-connection audit.** Guarantee no code path opens a second writer
   connection or interleaves transactions (critical once the async D1 adapter exists); the
   serialized runner covers one connection only.
9. **Phantom-validation mechanism cost.** Whether `previous_revisions` + a re-scan is the cheapest
   sound phantom check, or the `indexes` table needs an explicit range-version probe — affects how
   much the transactor must re-read at commit (and headroom).
10. **FTS5 / `sqlite-vec` capability probe.** Define the `setupSchema` feature-probe and the
    degrade-by-not-advertising path, so a backend without the extension fails closed at capability
    detection, never at query time.
```
