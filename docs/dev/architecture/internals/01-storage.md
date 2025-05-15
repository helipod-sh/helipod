---
title: Internals — Storage Layer & Document Identity
status: extracted (clean-room notes; concave studied as reference)
---
# Storage Layer & Document Identity

> Clean-room note: this document describes contracts **Stackbase** will build for its
> storage tier. We studied concave's published TypeScript `.d.ts` declarations
> (FSL-1.1-Apache-2.0) to understand the data flow and to preserve the handful of
> interface/type/field names that are facts required for Convex client interop
> (document-ID wire format, table-number reservations, `DocStore` method names that
> the transactor calls). Everything below is paraphrased as our own design intent,
> not copied from their source.

## Purpose & where it sits

The storage layer is the lowest tier of Stackbase: a single-writer, multi-version
document log that everything above it (the transactor, query engine, index
maintenance, scheduler) is built on. It has two jobs:

1. **Persist an append-only, timestamp-ordered log of document revisions** so that any
   committed transaction can be replayed and any point in logical time can be read back
   consistently (MVCC snapshot reads).
2. **Serve reads through indexes** — given an index id, a read timestamp, and a key
   range, walk the index in order and hand back the *latest visible* document revision
   for each key as of that timestamp.

Above this layer, a transactor performs optimistic concurrency control (OCC): it reads
at a snapshot, stages writes, validates that nothing it read changed, then commits a
batch of new revisions plus their index updates atomically. The storage layer itself is
deliberately "dumb" about transactions — it exposes the primitives (point-in-time index
scans, revision-chain lookups, atomic batch write) that the transactor composes into
serializable transactions. This separation is the seam we keep.

Document **identity** is the other half of this subsystem: every document carries an
internal 16-byte id plus a numeric table id, and there is a codec that turns that into
the human-facing, checksummed, Convex-compatible id string clients see (`k57x3n8j...`).

## The DocStore adapter contract

The central interface is `DocStore` (concave: `core/dist/docstore/interface.d.ts`).
Stackbase's storage adapter exposes the same shape so our transactor and the Convex
client protocol stay compatible. The methods group into six concerns.

### 1. Schema setup
- `setupSchema({ searchIndexes?, vectorIndexes? })` — idempotently create the physical
  tables and configure any full-text / vector index metadata. Called once on open.

### 2. MVCC reads (the hot path)
- `index_scan(indexId, tableId, readTimestamp, interval, order, limit?)` — the primary
  read primitive. Returns an **async generator** of `[indexKeyBytes, LatestDocument]`
  pairs, walking the index `interval` (a `{start, end}` byte range, `end: null` =
  open-ended) in `Asc`/`Desc` `Order`, but only surfacing the newest revision of each
  key that is **visible at `readTimestamp`** (i.e. `ts <= readTimestamp`, skipping
  tombstoned/deleted keys). This is how snapshot isolation is delivered: the same scan
  at the same `readTimestamp` always yields the same result regardless of later writes.
- `get(id, readTimestamp?)` — fetch one document's latest revision as of a timestamp,
  returning a `LatestDocument` or `null`.
- `count(tableId)` and `scan(tableId, readTimestamp?)` — whole-table count and full
  scan (latest visible revisions).
- `scanPaginated(tableId, cursor, limit, order, readTimestamp?)` — cursor-based page of
  a table scan, returning `{ documents, nextCursor, hasMore }`. Used for admin/data
  browsing and large exports.

### 3. Writes
- `write(documents, indexes, conflictStrategy)` — the atomic commit primitive. Takes an
  array of `DocumentLogEntry` revisions and a set of `{ts, update}` index mutations
  (`DatabaseIndexUpdate`), applied together in one transaction. `conflictStrategy` is
  `"Error"` (fail if a row at that `(ts, table, id)` already exists — the normal commit
  path) or `"Overwrite"` (idempotent replay / recovery). The transactor allocates the
  commit timestamp and builds both lists; the store just persists them.

### 4. Revision-chain lookups for OCC
- `previous_revisions(queries)` — given a set of `{id, ts}`, return for each the
  revision that was current *just before* `ts`. Keyed by a stable string
  (`getPrevRevQueryKey`). The transactor uses this to know prior values when computing
  index deltas and to validate read sets.
- `previous_revisions_of_documents(queries)` — same idea but the caller already knows the
  exact `prev_ts` it expects (`DocumentPrevTsQuery {id, ts, prev_ts}`, keyed via
  `getExactRevQueryKey`); a precise single-link lookup rather than a "find the predecessor"
  search.

### 5. Log tailing
- `load_documents(range, order)` — async generator over **every** `DocumentLogEntry`
  whose `ts` falls in a `TimestampRange` (`{min_timestamp_inclusive,
  max_timestamp_exclusive}`), in `ts` order. This is the change-feed / replication /
  reactive-subscription primitive: consumers tail the log forward from a known
  timestamp to learn what changed. Unlike `index_scan`, it returns *raw* log entries
  (including deletes), not deduplicated latest values.

### 6. Globals KV + capabilities
- `getGlobal(key)`, `writeGlobal(key, value)`, `writeGlobalIfAbsent(key, value)` — a
  tiny string→JSON key/value side table for engine bookkeeping (schema version, table
  registry metadata, migration flags). `writeGlobalIfAbsent` returns a boolean and is
  the compare-and-set primitive used for one-time bootstrap.
- **Search / vector are optional capabilities.** `DocStore` carries deprecated
  `search()` and `vectorSearch()` methods, but the forward-looking design (concave:
  `search-interfaces.d.ts`) splits these into separate `SearchCapable` and
  `VectorSearchCapable` interfaces with `isSearchCapable(store)` / `isVectorSearchCapable(store)`
  type guards. Stackbase adopts the capability-interface approach from day one: the core
  adapter contract is search-agnostic, and a backend advertises FTS/vector support by
  implementing the extra interface. Callers must feature-detect, never assume.

### Timestamp oracle
Writes need monotonic commit timestamps. The `TimestampOracle` interface
(`getCurrentTimestamp`, `allocateTimestamp`, optional async `allocateTimestampAsync`,
`observeTimestamp`) supplies a logical clock. The concrete `TimestampOracle`
(`utils/timestamp.d.ts`) is a per-instance logical clock that:
- allocates strictly-increasing, unique `bigint` timestamps, serialized through a queue
  so concurrent async callers never collide;
- `beginSnapshot()` returns the current time as a read snapshot;
- `observeTimestamp(ts)` advances the clock to at least a value seen from storage on
  startup/recovery, so restarts never reuse or go backwards in logical time.

One oracle instance per storage instance (per Durable Object / per process) — it is the
single source of logical time for that single-writer domain.

## The MVCC document-log model

The fundamental record is `DocumentLogEntry`:
- `ts: bigint` — the logical commit timestamp of this revision.
- `id: InternalDocumentId` — which document.
- `value: ResolvedDocument | null` — the document body (`{id, value}`) for an
  insert/update, or `null` to represent a **delete tombstone**.
- `prev_ts: bigint | null` — pointer to the previous revision's timestamp, forming a
  **per-document backwards-linked revision chain** (`null` = first revision).

A document's history is therefore a singly-linked list through time: latest → prev_ts →
prev_ts → … → null. Reads at a `readTimestamp` walk to the newest link with
`ts <= readTimestamp`. A `LatestDocument` (`{ts, value, prev_ts}`) is what reads return —
the resolved current-as-of-snapshot revision. The `prev_ts` link is what makes
`previous_revisions*` cheap and what lets the engine compute "what changed between two
snapshots" for indexes and subscriptions.

Index entries are versioned the same way. A `DatabaseIndexUpdate` carries
`{index_id, key, value}` where the value is either `{type: "NonClustered", doc_id}`
(this key now points at this document) or `{type: "Deleted"}` (tombstone). Index rows
are stamped with `ts`, so an index scan at a read timestamp reconstructs the index as it
existed at that moment — same MVCC discipline as documents.

Point-in-time reads work because nothing is ever updated in place: every write appends a
new `(ts, …)` row. Snapshot isolation = "filter to `ts <= readTimestamp`, take the max
`ts` per key." Old revisions can be compacted later once no snapshot can observe them,
but compaction is out of scope for the core contract.

## SQL/SQLite adapter shape

The SQLite implementations are layered in three tiers so platform differences stay
isolated. Stackbase mirrors this layering.

**Tier A — the engine logic (`BaseSqliteDocStore`, concave:
`docstore-sqlite-base/dist/base.d.ts`).** An abstract class that `implements DocStore`
and contains *all* the real logic: building SQL for `index_scan`, deduplicating to
latest-visible revisions, writing document + index rows in a transaction, FTS5 search,
cosine-similarity vector search, globals, pagination, prepared-statement caching, and
search/vector index config maps. It holds a `TimestampOracle`. It knows nothing about
which SQLite binding it runs on.

**Tier B — the platform seam (`SqliteAdapter`, concave:
`docstore-sqlite-base/dist/adapter.d.ts`).** A narrow interface the base class delegates
all I/O to. A backend must implement just:
- `exec(sql)` — run schema DDL;
- `prepare(sql) → PreparedStatement` with `get(...) / all(...) / run(...)` (each allowed
  to be sync or async, to cover both synchronous bindings and async D1);
- `transaction(fn)` — run a function inside a DB transaction;
- `hexToBuffer(hex)` / `bufferToHex(buf)` — convert between hex-string ids and the
  platform's native blob type.

`SqlParam` is the union of value types a statement accepts (string, number, bigint,
boolean, null, Buffer/ArrayBuffer/Uint8Array). This is the entire contract a new
backend implements — everything else is inherited from Tier A.

**Tier C — concrete backends.** For Node (concave: `docstore-node-sqlite`):
`SqliteDocStore extends BaseSqliteDocStore` wraps a `node:sqlite` `DatabaseSync`, takes
a `dbPath` and `{ durability: "balanced" | "strict" }`, and adds `close()`.
`NodeSqliteAdapter implements SqliteAdapter` does the actual `node:sqlite` calls. Because
`node:sqlite` is synchronous but the adapter contract allows promises, a
**serialized transaction runner** (`createSerializedTransactionRunner`, concave:
`transaction-runner.d.ts`) wraps begin/commit/rollback hooks so that async transaction
callbacks cannot interleave on a single connection — preserving single-writer semantics
even when the surrounding code is async. The same Tier-A base is reused for Bun and
Cloudflare D1 by swapping only the adapter.

**Physical schema (concave: `docstore/sql/schema.d.ts`).** Three fixed tables:
- `documents(id, ts, table_id, json_value, deleted, prev_ts)` with `PRIMARY KEY (ts,
  table_id, id)` and a secondary index on `(table_id, id, ts)` — the latter is what
  makes "latest revision of this doc id" and per-table scans efficient. `json_value`
  holds the serialized body; `deleted` is the tombstone flag; `prev_ts` is the chain
  link.
- `indexes(index_id, ts, key, deleted, table_id, document_id)` with
  `PRIMARY KEY (index_id, key, ts)` — one fixed physical table holds **all** logical
  indexes, discriminated by `index_id`. Range scans walk `key` order within an
  `index_id`, filtered by `ts` for MVCC.
- `persistence_globals(key, json_value)` — the globals KV.

**Full-text (concave: `sql/search-schema.d.ts`).** A single FTS5 virtual table
`search_indexes(index_id, document_id, ts, deleted, search_body)` where only
`search_body` is tokenized (Porter stemming + unicode61, diacritics removed) and the
rest are `UNINDEXED` bookkeeping columns — all logical search indexes share this one
table, discriminated by `index_id`, mirroring the `indexes` pattern. Helpers
`prepareSearchQuery` (adds prefix-match `*` to the final term for Convex parity) and
`extractSearchContent` (pulls a dotted field path like `user.name` out of a doc) round
it out.

The "one physical table per concern, many logical tables/indexes inside it,
discriminated by an id column, versioned by `ts`" pattern is the key shape we keep: it
makes adding a user table or index a metadata operation, not a DDL migration.

## Table registry

Documents store a **numeric `tableNumber`**, but the physical `documents`/`indexes`
rows key on a **`table_id` blob** (historically a hex-encoded table name). The registry
(`tables/interface.d.ts`) maps between the human table name, the numeric table number,
and component namespace. Why the indirection:
- The numeric `tableNumber` is what gets baked into the developer-facing document id
  (small, varint-friendly, stable). It's runtime metadata for id encode/decode,
  validation, and access checks.
- The hex `table_id` stays as the raw storage key for compatibility with the
  query/scan code.

`TableInfo` records `{tableNumber, name, componentPath, fullName, isSystem, visibility,
state, createdAt}`. Number allocation is partitioned:
- **1–9999 reserved for system/internal tables.** Concave fixes a handful explicitly
  (`SYSTEM_TABLE_NUMBERS`: `_tables=1`, `_scheduled_functions=2`, `_storage=3`,
  `_crons=4`, `_indexes=5`, `_schemas=6`, `_components=7`, `_component_definitions=8`,
  `_schema_validation_progress=9`) and reserves the rest of the band.
- **User tables start at `FIRST_USER_TABLE_NUMBER = 10001`,** allocated lazily on first
  access.

The interface: `getOrAllocateTableNumber(name, componentPath?)`,
`getTableInfo(number)`, `getTableInfoByName(name, componentPath?)`, `listTables`,
`hasAccess(number, componentPath)` (components may touch only their own tables + system
tables), and `getSystemTableNumber(name)`. **Component namespacing** means the full name
is `${componentPath}/${name}` (root = empty string), so the same table name in two
components is two distinct numbers — the isolation boundary for Convex components.
Helpers `getFullTableName` / `parseFullTableName` / `isSystemTable` handle the
name<->fullName conversions.

Three registry variants exist, and we want the same set:
- **`MemoryTableRegistry`** — pure in-memory map, seeds the system tables, hands out
  user numbers from a counter. For single-process/dev/testing. A global singleton
  accessor exists for convenience.
- **`DocStoreTableRegistry`** — durable: persists the mapping *through the DocStore
  itself* (the `_tables` system table), with caching plus a freshness TTL so it does not
  re-read metadata on every lookup. This is the production registry.
- **`TransactionalTableRegistry`** — wraps a base registry and binds it to an in-flight
  OCC mutation transaction, so table allocations made inside a transaction are visible
  to that transaction and committed atomically with it (read-your-writes for table
  creation). Created via `createTransactionalTableRegistry(base, txn?)`.

## Developer-facing ID codec

Internally a document is `InternalDocumentId { table, internalId, tableNumber? }`
(hex strings) plus helpers `documentIdKey` / `parseDocumentIdKey` / `documentIdsEqual`
for using ids as Map/Set keys. Developers and the Convex client, however, see a single
opaque string like `k57x3n8jg9q2w4e1r6t5y8u2i3o4p5a6`. The codec
(`id-codec/document-id.d.ts`) converts between the two, and we reproduce its wire format
exactly because Convex clients parse and validate these strings.

**Wire format (bytes, before text encoding):**
```
[ varint(tableNumber) ][ 16-byte internalId ][ 2-byte Fletcher-16 checksum ]
```
then the whole byte string is **Crockford Base32**-encoded to text. That yields 31–37
characters (19–23 bytes) depending on how many bytes the table-number varint needs.
Constants: `INTERNAL_ID_LENGTH = 16`, `MIN_ENCODED_LENGTH = 31`, `MAX_ENCODED_LENGTH =
37`.

The three building blocks (each a small standalone utility we reimplement):
- **Crockford Base32** (`id-codec/base32.d.ts`) — alphabet
  `0123456789abcdefghjkmnpqrstvwxyz`, deliberately omitting `i l o u` to avoid visual
  confusion with `1 L 0 V`. It is case-insensitive, URL-safe, and **order-preserving**
  (lexicographic order of the text matches byte order — useful if ids are ever range
  scanned). `base32Encode` / `base32Decode` / `isValidBase32`.
- **Fletcher-16 checksum** (`id-codec/fletcher16.d.ts`) — a cheap 2-byte checksum over
  `varint(tableNumber)+internalId`. It catches all single-byte errors and most
  transpositions, so a mistyped or truncated id is rejected at `decodeDocumentId` /
  `isValidDocumentId` instead of silently resolving to a wrong/nonexistent document.
  This is *integrity*, not security — the id is not secret, just self-validating.
  `fletcher16` / `verifyFletcher16`.
- **Varint** (`id-codec/vint.d.ts`) — prefix-free 1–5 byte encoding of an unsigned
  32-bit int, small numbers in fewer bytes (0–127 → 1 byte, up to 2^32-1 → 5 bytes). So
  low table numbers (the common case) keep ids short. `vintEncode` / `vintDecode` /
  `vintEncodedLength`.

Codec API: `encodeDocumentId(tableNumber, internalId)`,
`decodeDocumentId(encoded) → {tableNumber, internalId}` (throws on bad checksum or
malformed input), `isValidDocumentId`, `generateInternalId()` (16 random bytes from
`crypto.getRandomValues`), plus `internalIdToHex` / `hexToInternalId` and
`getEncodedLength(tableNumber)`. The internal id being 16 bytes of CSPRNG randomness
means ids are unguessable and collision-free in practice without coordination.

## Keyspace / written-ranges / timestamps utilities

- **Keyspace** (`utils/keyspace.d.ts`) — a small algebra over the two kinds of physical
  key namespaces: a `{kind:"table", table}` space and a `{kind:"index", table, index}`
  space. It provides a canonical string id for each (`keyspaceId`, `tableKeyspaceId`,
  `indexKeyspaceId`) and the inverse parsers, plus the concrete `encodeTableId` /
  `decodeTableId` / `encodeIndexId` / `decodeIndexId` used to derive the `table_id` /
  `index_id` blob values the SQL layer keys on. This is the single place that decides
  "what string identifies this table/index in storage," keeping that convention out of
  the rest of the engine.
- **Written ranges** (`utils/written-ranges.d.ts`) — `writtenTablesFromRanges(ranges?)`
  collapses the set of key ranges a transaction touched (from the query engine) into a
  deduplicated list of table names. Used for OCC conflict scoping / invalidation: "which
  tables did this transaction write, so which subscriptions/read-sets must be checked."
- **Timestamps** (`utils/timestamp.d.ts`) — the `TimestampOracle` described above; the
  logical-clock source for the whole MVCC scheme.

## How Stackbase reimplements this

**Keep the seam, keep the wire facts.** We adopt the `DocStore` method surface and the
`SqliteAdapter` Tier-A/Tier-B/Tier-C layering essentially as-is, because that seam is
what lets us add backends later without touching engine logic, and because the
transactor above is written to these method names. We reproduce the document-id wire
format, the table-number reservations (system < 10000, users from 10001), and the
component-namespacing rule exactly — these are interop facts, not design choices, so the
Convex client and any imported data keep working.

**Our naming.** Stackbase calls the seam a `DatabaseAdapter` (the `SqliteAdapter`
equivalent) and the engine class a `BaseSqlDocStore`. The MVCC log entry, `LatestDocument`,
`InternalDocumentId`, and the three physical tables retain their structural shape and
field names so the SQL is portable.

**Tier 0 first: Node SQLite.** We ship the `node:sqlite` backend first (the
`SqliteDocStore` + `NodeSqliteAdapter` + serialized-transaction-runner trio), with a
`MemoryTableRegistry` for dev and the DocStore-backed durable registry for real
deployments. Bun and Cloudflare D1 backends come later by implementing only the adapter
interface.

**What we simplify initially.**
- Search and vector start as *unimplemented capabilities*: the core store ships without
  `SearchCapable`/`VectorSearchCapable`, and we wire FTS5/vector in as a later capability
  module. The deprecated `search()`/`vectorSearch()` on the base interface we drop
  entirely in favor of the capability interfaces from the start.
- Drop the legacy hex-table-name id format; Stackbase stores `tableNumber` as the source
  of truth and derives the storage `table_id` from it, rather than carrying both a hex
  name and a number for "backwards compatibility."
- Single durability default (`balanced`), with `strict` as an opt-in flag, matching the
  Node options object.

**What we change/harden.**
- Make `count`/`scan`/`scanPaginated` consistently take an explicit `readTimestamp`
  rather than defaulting to "now," so callers can't accidentally read outside their
  snapshot.
- Treat `load_documents` as the canonical change-feed and define a documented retention
  window for log tailing up front (concave leaves compaction implicit).

## Open questions / risks

- **Compaction / retention.** Nothing in the studied contract specifies when old
  revisions or index tombstones are garbage-collected. An append-only log grows without
  bound; we need a compaction policy keyed off the oldest live read snapshot, and it
  must not race `load_documents` tailers. This is the biggest unspecified area.
- **`InternalDocumentId` dual representation.** Concave keeps both a hex `table` and a
  numeric `tableNumber` "for compatibility." If we drop the hex form we must audit every
  place `table_id` blobs are compared/serialized (keyspace encode/decode) to ensure a
  single canonical derivation.
- **Async adapter + single-writer correctness.** The adapter permits async
  `get/all/run`, but MVCC correctness depends on writes being serialized. The
  serialized-transaction-runner handles a single connection; we must verify no code path
  opens concurrent connections or interleaves transactions, especially under the D1
  async backend.
- **Timestamp oracle durability across restarts.** `observeTimestamp` advances the clock
  from storage on startup, but we need to confirm the highest committed `ts` is always
  read back before the first new allocation, or a crash could risk timestamp reuse.
- **FTS5 / vector availability is platform-dependent.** The base notes an `fts5Available`
  flag; backends without FTS5 (or without a vector extension) must degrade by *not*
  advertising the capability rather than failing at query time. Need a clear
  feature-probe at `setupSchema`.
- **Cursor stability in `scanPaginated`.** The opaque cursor must remain valid across the
  page even as concurrent writes append revisions; we should pin pagination to a
  `readTimestamp` so a long export sees a consistent snapshot.
