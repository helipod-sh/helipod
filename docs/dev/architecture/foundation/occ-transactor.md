---
title: Foundation — Single-Writer OCC Transactor
status: design (implementation-ready)
slice: Foundation
component: occ-transactor
dependsOn: [sqlite-docstore, index-key-codec]
audience: engineering (internal)
---

# Single-Writer OCC Transactor

> Clean-room design. We studied concave's `.d.ts` contracts (FSL-1.1-Apache-2.0, in
> gitignored `.reference/`) only to understand the *shape* of the problem. Everything
> below is our own design and original code intent; nothing is copied. See
> [`.reference/README.md`](../../../../.reference/README.md) for the license posture.

This component is **the consistency core** of Stackbase. It turns a deterministic
mutation function into an atomic, serializable commit, and emits the
`WriteInvalidation` delta that drives reactivity. It sits **below** the UDF executor
([internals/05](../internals/05-udf-execution.md)) and **above** the `DocStore`
([internals/01](../internals/01-storage.md)), and it is the single mechanism behind
both correctness (OCC) and live queries (read-set/write-set intersection).

Grounding: [system-design §3](../system-design.md), [internals/02 (OCC & invalidation)](../internals/02-transactions-consistency.md),
[scalability-spectrum §2.1, §2.4, §3 rows 1/2/4](../scalability-spectrum.md),
[strategy (locked divergences + mandate)](../strategy.md).

---

## 1. Purpose & boundaries

### What it owns

1. **The transaction lifecycle** — `begin` (capture a snapshot timestamp) → execute
   (track reads, stage writes) → `commit` (3-phase OCC) | `rollback`.
2. **The 3-phase commit pipeline**, run under a **per-shard single-writer lock**:
   *Phase 1* validate the read set (via the `prev_ts` revision chain + phantom/scan
   re-checks); *Phase 2* allocate **one** commit timestamp from the shard's
   `TimestampOracle`; *Phase 3* apply all staged `DocumentLogEntry[]` + index updates
   atomically through `DocStore.write`.
3. **The read set** (`ReadVersion[]`) — the per-read version records that OCC
   validation consults, and the **write `RangeSet`** that becomes the invalidation
   payload.
4. **Read-your-own-writes (RYOW)** — the `UncommittedWrites` abstraction and the
   staged/pending buffers that make a read after a write in the same transaction see
   that write.
5. **Caller-driven, bounded, deterministic-UDF replay on `ConflictError`** — the
   retry policy, backoff computation, and the `runInTransaction` loop utility the
   mutation runner uses to re-execute the UDF on conflict.
6. **Transaction headroom** — per-transaction resource caps (queries, docs read/written,
   bytes, scheduled functions) with snapshot/restore so limits survive savepoints.
7. **Invalidation emission** — building `WriteInvalidation` + the serializable
   `OplogDelta`, and publishing them through the `WriteFanout` seam.
8. **The per-shard `ShardWriter`** (lock + oracle binding) and the shard map indirection
   that Tier 2 promotes to one writer per conversation (the scale seam, §6).

### What it does NOT own (and where that lives)

| Concern | Owner |
|---|---|
| Physical persistence, MVCC log, `index_scan`/`write`/`previous_revisions`, the `TimestampOracle` *instance* | **sqlite-docstore** ([01](../internals/01-storage.md)) |
| Order-preserving key encoding, `compareIndexKeys`, `RangeSet`, `KeyRange` (de)serialization, `IndexManager.generateUpdates`, `extractIndexKey`, cursors | **index-key-codec** ([04](../internals/04-query-engine.md)) |
| Running user code, determinism enforcement (seeded RNG, no clock/fetch), the syscall ABI, *translating* `ctx.db.insert/patch/replace/delete` into `(DocumentLogEntry[], DatabaseIndexUpdate[])` | **udf-execution** ([05](../internals/05-udf-execution.md)) |
| Query planning, `.filter()`/`.order()`/`.paginate()`, `mergeUncommittedWrites` (filter+sort over RYOW) | **query-engine** ([04](../internals/04-query-engine.md)) |
| Holding subscriptions, intersecting write ranges against read ranges, re-running queries, pushing `Transition`s, backpressure | **sync tier** ([03](../internals/03-reactivity-sync.md)) |
| The `WriteFanout` *adapter* (in-memory at Tier 0; Redis/Queues/BroadcastChannel later) and the `ChangeStreamConsumer` | **runtime-embedded** ([06](../internals/06-runtimes-topology.md)) |
| Auth/`Principal`, the public `OccConflictError` (409) error class | **platform-services** ([07](../internals/07-platform-services.md)) |

**Hard boundary:** the transactor never imports a database driver, never runs user
code, and never inspects document *contents* semantically — it only moves
`DocumentLogEntry`/`DatabaseIndexUpdate` rows and reasons about timestamps and key
ranges. A leak of either direction is a design bug.

---

## 2. The contracts (TypeScript)

These are the exact signatures other Foundation components depend on. Types imported
from dependencies are shown (abbreviated) for completeness and tagged with their owner.

### 2.1 Shared primitives (imported)

```ts
// ── from sqlite-docstore ───────────────────────────────────────────────────────
export type Timestamp = bigint;                 // logical MVCC clock value
export type ShardId = string;                   // Tier 0: always "default"
export type DocKey = string;                    // documentIdKey(InternalDocumentId) — stable Map/Set key
export type ConflictStrategy = "Error" | "Overwrite";  // v1 always "Error"

export interface InternalDocumentId { table: string; internalId: string; tableNumber?: number }
export interface ResolvedDocument { id: InternalDocumentId; value: DocumentValue }
export type DocumentValue = Record<string, unknown>;  // user doc incl. _id, _creationTime

export interface DocumentLogEntry {
  ts: Timestamp;                       // MVCC stamp == commit timestamp (set at apply)
  id: InternalDocumentId;
  value: ResolvedDocument | null;      // null = delete tombstone
  prev_ts: Timestamp | null;           // backward revision-chain link
}
export interface LatestDocument { ts: Timestamp; value: ResolvedDocument | null; prev_ts: Timestamp | null }

export type DatabaseIndexValue =
  | { type: "NonClustered"; doc_id: InternalDocumentId }
  | { type: "Deleted" };
export interface DatabaseIndexUpdate { index_id: string; key: IndexKeyBytes; value: DatabaseIndexValue }

export interface TimestampOracle {
  getCurrentTimestamp(): Timestamp;            // peek (snapshot read) — does NOT advance
  allocateTimestamp(): Timestamp;              // advance + return, strictly increasing, serialized
  allocateTimestampAsync(): Promise<Timestamp>;
  observeTimestamp(ts: Timestamp): void;       // advance clock to >= ts (recovery / distributed)
}

/** The narrow facet of DocStore the transactor calls. */
export interface TransactorDocStore {
  write(documents: DocumentLogEntry[], indexes: DatabaseIndexUpdate[], strategy: ConflictStrategy): Promise<void>;
  get(id: InternalDocumentId, readTimestamp?: Timestamp): Promise<LatestDocument | null>;
  index_scan(
    indexId: string, tableId: string, readTimestamp: Timestamp,
    interval: { start: IndexKeyBytes; end: IndexKeyBytes | null },
    order: "Asc" | "Desc", limit?: number,
  ): AsyncIterable<[IndexKeyBytes, LatestDocument]>;
  scan(tableId: string, readTimestamp?: Timestamp): AsyncIterable<LatestDocument>;
  previous_revisions(queries: Array<{ id: InternalDocumentId; ts: Timestamp }>): Promise<Map<string, LatestDocument | null>>;
}

// ── from index-key-codec ───────────────────────────────────────────────────────
export type IndexKeyBytes = Uint8Array;          // order-preserving encoded key
export interface KeyRange { tableId: string; startKey: IndexKeyBytes; endKey: IndexKeyBytes | null; isPoint: boolean }
export interface SerializedKeyRange { tableId: string; startKey: string; endKey: string | null; isPoint: boolean }
export interface RangeSet {
  addDocument(doc: InternalDocumentId): void;
  addIndexRange(tableId: string, index: string, start: IndexKeyBytes, end: IndexKeyBytes | null): void;
  addTableScan(tableId: string): void;
  getRanges(): KeyRange[];
  getRangesByTable(): Map<string, KeyRange[]>;
  getTables(): string[];
  isEmpty(): boolean;
  clone(): RangeSet;
}
export declare function compareIndexKeys(a: IndexKeyBytes, b: IndexKeyBytes): -1 | 0 | 1;
export declare function serializeKeyRange(r: KeyRange): SerializedKeyRange;
export declare function writtenTablesFromRanges(ranges: ReadonlyArray<KeyRange | SerializedKeyRange>): string[];
```

> `tableId` namespacing (from the codec) is `table:<tableHex>` for a table's primary
> keyspace and `index:<tableHex>:<indexName>` for a secondary index. This is what lets
> a write on an index range be matched against a read on the same index range by plain
> byte comparison.

### 2.2 `ReadVersion` — what validation remembers

```ts
export type ReadVersion =
  | { type: "document"; tableId: string; docKey: DocKey; version: Timestamp | null }   // version=null ⇒ read of absence
  | { type: "index_range"; indexId: string; tableId: string; index: string;
      startKey: IndexKeyBytes; endKey: IndexKeyBytes | null;
      readTimestamp: Timestamp; documentIds: DocKey[] }                                 // baseline membership
  | { type: "table_scan"; tableId: string; readTimestamp: Timestamp; documentIds: DocKey[] };
```

Each read is recorded **twice**: once as a `ReadVersion` (for "did it change?") and
once into the read `RangeSet` (for "who is subscribed here?"). For a *mutation*, only
the `ReadVersion[]` is consumed at commit; the read `RangeSet` is carried for
uniformity/savepoints and is the payload a *query* subscription hands the sync tier.

### 2.3 `UncommittedWrites` — RYOW abstraction

```ts
export type LocalWriteValue = ResolvedDocument | null;            // null = deleted
export interface LocalWrite { docKey: DocKey; tableId: string; value: LocalWriteValue }

export interface UncommittedWrites {
  hasWrites(): boolean;
  /** undefined = no pending write; null = pending delete; else the staged value. */
  getDocumentWrite(docKey: DocKey): LocalWriteValue | undefined;
  getTableWrites(tableId: string): Map<DocKey, LocalWriteValue>;
  /** Mutate a scan's visibility map in place to reflect pending inserts/updates/deletes. */
  applyToVisibilityMap(visible: Map<DocKey, LatestDocument>, tableId: string): void;
}

export declare function uncommittedFromTransaction(tx: TransactionContext): UncommittedWrites;
export declare function uncommittedFromLocalWrites(writes: Map<DocKey, LocalWrite>): UncommittedWrites;
export declare function uncommittedFromContext(
  tx: TransactionContext | undefined, localWrites?: Map<DocKey, LocalWrite>,
): UncommittedWrites;   // auto-detect: transactional path vs one-shot mutation path
```

The query engine's `mergeUncommittedWrites(documents, uncommitted, { ranges, indexFields, order })`
(its code, not ours) consumes this to apply filter+sort over RYOW. We own the
abstraction and the point-level merge (`applyToVisibilityMap`); the query engine owns
the query-correct ordering/filtering on top.

### 2.4 `TransactionHeadroom` — resource caps

```ts
export interface TransactionMetric { used: number; remaining: number }
export interface TransactionHeadroom {
  bytesRead: TransactionMetric;
  bytesWritten: TransactionMetric;
  databaseQueries: TransactionMetric;
  documentsRead: TransactionMetric;
  documentsWritten: TransactionMetric;
  functionsScheduled: TransactionMetric;
  scheduledFunctionArgsBytes: TransactionMetric;
}

export interface HeadroomLimits {
  maxBytesRead: number;
  maxBytesWritten: number;
  maxDatabaseQueries: number;          // default 4096
  maxDocumentsRead: number;            // default 32000
  maxDocumentsWritten: number;         // default 16000  (< read: writes feed fan-out)
  maxFunctionsScheduled: number;       // default 1000
  maxScheduledFunctionArgsBytes: number;
}
export declare const DEFAULT_HEADROOM_LIMITS: HeadroomLimits;

export interface HeadroomSnapshot { readonly __brand: "headroom-snapshot" }  // opaque

export interface TransactionHeadroomTracker {
  recordDatabaseQuery(count?: number): void;
  recordRead(value: unknown): void;
  recordReads(values: Iterable<unknown>): void;
  trackWrittenDocument(docKey: DocKey, value: unknown): void;   // idempotent per docKey (no double-count on rewrite)
  recordScheduledFunction(args: unknown): void;
  getHeadroom(): TransactionHeadroom;
  snapshot(): HeadroomSnapshot;                 // for savepoints
  restore(snapshot: HeadroomSnapshot): void;
}

export declare function estimateValueBytes(value: unknown): number;
export class HeadroomExceededError extends Error {
  readonly metric: keyof TransactionHeadroom;
  readonly limit: number;
}
```

### 2.5 `WriteInvalidation` & `OplogDelta` — the reactivity bridge

```ts
export interface WriteInvalidation {
  shardId: ShardId;                       // Foundation obligation #1: present even with one shard
  writtenRanges?: SerializedKeyRange[];   // serialized — crosses process/wire boundaries
  writtenTables?: string[];               // coarse table-level signal (v1 invalidation granularity)
  commitTimestamp?: Timestamp;
  snapshotTimestamp?: Timestamp;
}

/** The durable, ordered record a distributed change-stream replays to sync nodes (seam row 4). */
export interface OplogDelta {
  commitTimestamp: Timestamp;
  shardId: ShardId;
  writtenRanges: SerializedKeyRange[];
  writtenTables: string[];
}

export declare function normalizeWriteInvalidation(x: Partial<WriteInvalidation> & { shardId: ShardId }): WriteInvalidation;
export declare function hasWriteInvalidation(x: WriteInvalidation): boolean;

/** The publish boundary the transactor calls; the adapter is provided by the runtime. */
export interface WriteFanout {
  publish(invalidation: WriteInvalidation, oplog: OplogDelta): void | Promise<void>;
}
```

`OplogDelta` is intentionally **range-based, not body-based**: the sync tier re-runs
queries, it does not need document bytes; the durable bytes already live in the storage
log (`DocStore.load_documents`). A node-to-node *data* replica tails the storage log;
`OplogDelta` is the *invalidation* stream. Both are ordered by `commitTimestamp` within
a shard.

### 2.6 `CommitResult`

```ts
export interface CommitResult {
  committed: boolean;                     // false ⇒ pure-read transaction (nothing staged)
  shardId: ShardId;
  commitTimestamp: Timestamp | null;      // null when !committed
  snapshotTimestamp: Timestamp;
  writtenRanges: SerializedKeyRange[];
  writtenTables: string[];
  oplogEntry: OplogDelta | null;          // null when !committed
  invalidation: WriteInvalidation | null; // null when !committed
  headroom: TransactionHeadroom;          // final usage (for logging/limits surfacing)
}
```

### 2.7 `TransactionContext` & `Transactor`

```ts
export type TransactionMode = "embedded" | "distributed";   // Tier 0 = "embedded"
export type TransactionState = "active" | "committed" | "rolledBack";

export interface BeginOptions {
  shardId?: ShardId;                       // default "default"
  mode?: TransactionMode;                  // default "embedded"
  headroomLimits?: Partial<HeadroomLimits>;
}

export interface IndexScanRequest {
  indexId: string;
  tableId: string;
  index: string;                           // descriptor name (for the range keyspace id)
  interval: { start: IndexKeyBytes; end: IndexKeyBytes | null };
  order: "Asc" | "Desc";
  limit?: number;
}

export interface Savepoint { readonly __brand: "savepoint" }   // opaque snapshot of all txn state

export interface TransactionContext {
  readonly requestId: string;
  readonly shardId: ShardId;
  readonly mode: TransactionMode;
  readonly snapshotTimestamp: Timestamp;
  readonly state: TransactionState;

  // ── RYOW-aware reads: read DocStore @ snapshot, overlay pending writes, auto-record read set ──
  getLatest(id: InternalDocumentId): Promise<LatestDocument | null>;
  getManyLatest(ids: InternalDocumentId[]): Promise<Array<LatestDocument | null>>;
  scanTable(tableId: string, order?: "Asc" | "Desc"): AsyncIterable<LatestDocument>;
  indexScan(req: IndexScanRequest): AsyncIterable<[IndexKeyBytes, LatestDocument]>;

  // ── explicit recording (when the query runtime drives its own scan and reports back) ──
  recordDocumentRead(id: InternalDocumentId, version: Timestamp | null): void;
  recordIndexRangeRead(req: IndexScanRequest, persistedDocumentIds: DocKey[]): void;
  recordTableScanRead(tableId: string, persistedDocumentIds: DocKey[]): void;

  // ── staging: writes buffered until commit ──
  stageWrite(documents: DocumentLogEntry[], indexes: DatabaseIndexUpdate[], strategy?: ConflictStrategy): void;
  previewTimestamp(): Timestamp;           // provisional, txn-local; for _creationTime / RYOW index ordering

  // ── RYOW abstraction for the query engine ──
  uncommitted(): UncommittedWrites;
  getStagedValue(docKey: DocKey): LocalWriteValue | undefined;

  // ── resource limits ──
  readonly headroom: TransactionHeadroomTracker;

  // ── savepoints (secondary; groups all mutable state) ──
  createSavepoint(): Savepoint;
  restoreSavepoint(sp: Savepoint): void;

  // ── commit-pipeline internals (engine-only; not exposed to UDF code) ──
  readonly _readSet: ReadonlyArray<ReadVersion>;
  readonly _writtenDocKeys: ReadonlySet<DocKey>;
  readonly _writeRanges: RangeSet;
  readonly _stagedDocuments: ReadonlyArray<DocumentLogEntry>;
  readonly _stagedIndexes: ReadonlyArray<DatabaseIndexUpdate>;
}

export interface Transactor {
  /** Capture a snapshot timestamp (oracle peek) and return a fresh context. Synchronous. */
  begin(requestId: string, options?: BeginOptions): TransactionContext;
  /** 3-phase OCC under the shard's single-writer lock. Throws ConflictError on validation failure. */
  commit(ctx: TransactionContext): Promise<CommitResult>;
  /** Discard staged state. Idempotent; no storage effect. */
  rollback(ctx: TransactionContext): void;
}
```

### 2.8 Conflict, retry & the caller-driven replay loop

```ts
export interface ConflictDetail {
  reason: "document-changed" | "phantom-insert" | "scan-changed" | "absent-now-present";
  tableId?: string; docKey?: DocKey; indexId?: string;
  snapshotTimestamp: Timestamp; observedTimestamp?: Timestamp;
}
/** Internal control-flow error. Distinct from the public OccConflictError (409) so engine
 *  control flow never leaks to clients (see internals/07 error model). */
export class ConflictError extends Error {
  readonly kind: "occ-conflict";
  readonly detail: ConflictDetail;
}

export interface TransactionRetryPolicy {
  maxAttempts: number;     // default 8
  baseDelayMs: number;     // default 1
  maxDelayMs: number;      // default 100
  jitter: boolean;         // default true
}
export declare const DEFAULT_RETRY_POLICY: TransactionRetryPolicy;

/** Deterministic-friendly backoff: takes the (seeded-or-real) random fn so the loop stays
 *  reproducible when the caller wants it to be (internals/05 computeOccRetryDelayMs). */
export declare function computeOccRetryDelayMs(
  attempt: number, policy: TransactionRetryPolicy, random: () => number,
): number;

export interface RunInTransactionOptions extends BeginOptions {
  retry?: TransactionRetryPolicy;
  random?: () => number;          // seeded PRNG from the UDF environment; defaults to Math.random
}
export interface RunResult<T> { value: T; commit: CommitResult; attempts: number }

/**
 * The caller-driven replay loop. `fn` MUST be a *pure re-execution* of the deterministic
 * UDF against the supplied context — the mutation runner re-runs user code on each attempt
 * (fresh seeded RNG, fresh staged writes). On ConflictError we rollback, back off, and retry
 * up to maxAttempts; exhaustion rethrows the last ConflictError (the runner maps it to the
 * public OccConflictError → 409). Non-conflict errors propagate immediately.
 */
export declare function runInTransaction<T>(
  transactor: Transactor, requestId: string,
  fn: (ctx: TransactionContext) => Promise<T>,
  options?: RunInTransactionOptions,
): Promise<RunResult<T>>;
```

### 2.9 The implementation class & its construction seams

```ts
export interface ShardWriter { readonly shardId: ShardId; readonly oracle: TimestampOracle }

export interface AsyncMutex { runExclusive<T>(fn: () => Promise<T>): Promise<T> }
export declare function createAsyncMutex(): AsyncMutex;   // FIFO promise-chain mutex

export interface SingleWriterTransactorOptions {
  docstore: TransactorDocStore;                                   // from sqlite-docstore
  oracle: TimestampOracle;                                        // Tier 0: the one shard oracle
  /** Tier 2 seam: resolve the writer (lock+oracle) for a shard. Default returns the single local writer. */
  resolveShardWriter?: (shardId: ShardId) => ShardWriter;
  writeFanout?: WriteFanout;                                      // default: no-op (caller publishes from CommitResult)
  defaultHeadroomLimits?: HeadroomLimits;                         // default DEFAULT_HEADROOM_LIMITS
  // injected from index-key-codec so the transactor never re-implements ordering:
  compareIndexKeys: (a: IndexKeyBytes, b: IndexKeyBytes) => -1 | 0 | 1;
  serializeKeyRange: (r: KeyRange) => SerializedKeyRange;
}

export class SingleWriterTransactor implements Transactor {
  constructor(opts: SingleWriterTransactorOptions);
  begin(requestId: string, options?: BeginOptions): TransactionContext;
  commit(ctx: TransactionContext): Promise<CommitResult>;
  rollback(ctx: TransactionContext): void;
}
```

---

## 3. Key data structures & algorithms

### 3.1 The commit critical section (the heart)

UDF **execution and reads are lock-free and optimistic**. The single-writer lock is
held **only** for the commit critical section, which is intentionally short:

```
begin: snapshot = oracle.getCurrentTimestamp()        // peek, lock-free
   ... UDF executes: reads @ snapshot (RYOW), stages writes ... // lock-free, optimistic
commit(ctx):
  if ctx._stagedDocuments.isEmpty():                  // pure-read fast path
      return { committed:false, commitTimestamp:null, oplogEntry:null, invalidation:null, ... }

  shardWriter = resolveShardWriter(ctx.shardId)
  return shardWriter.lock.runExclusive(async () => {  // ── single-writer critical section ──
    // Phase 1 — VALIDATE (reads "now" == latest committed; stable because no other commit runs here)
    await validateReadSet(docstore, ctx._readSet, ctx._writtenDocKeys,
                          ctx.snapshotTimestamp, tableWriteWatermark, compareIndexKeys)
    // Phase 2 — ASSIGN one commit timestamp (strictly > every prior commit on this shard)
    const commitTs = await shardWriter.oracle.allocateTimestampAsync()
    // Phase 3 — APPLY atomically
    const docs    = stampDocuments(ctx._stagedDocuments, commitTs)   // ts := commitTs, prev_ts wired
    const indexes = stampIndexes(ctx._stagedIndexes, commitTs)       // ts := commitTs
    await docstore.write(docs, indexes, "Error")                     // one atomic DocStore txn
    bumpTableWriteWatermark(ctx._writeRanges.getTables(), commitTs)
    // Build + publish invalidation
    const result = buildCommitResult(ctx, commitTs)
    await writeFanout?.publish(result.invalidation!, result.oplogEntry!)
    ctx._setState("committed")
    return result
  })
```

Why this is sound: with commits serialized by the lock and a strictly-increasing
oracle, validation only has to answer *"did anything I read change since my snapshot?"*
— there is no concurrent committer to race. A transaction commits only if its reads are
still valid as-of the commit point, which is the textbook OCC serializability condition.
Single-writer removes write-write races entirely, leaving only the read-validation
obligation. (See [internals/02 "Serializability argument"](../internals/02-transactions-consistency.md).)

### 3.2 OCC validation (Phase 1)

```ts
async function validateReadSet(
  docstore: TransactorDocStore,
  readSet: ReadonlyArray<ReadVersion>,
  writtenDocKeys: ReadonlySet<DocKey>,
  snapshot: Timestamp,
  tableWriteWatermark: (tableId: string) => Timestamp | undefined,
  compareIndexKeys: (a: IndexKeyBytes, b: IndexKeyBytes) => -1 | 0 | 1,
): Promise<void> /* throws ConflictError */
```

Per read-set entry, **excluding the transaction's own writes** (`writtenDocKeys`):

- **`document` (point read, version `v`)**
  Fast path: if `tableWriteWatermark(tableId) <= snapshot`, the table saw no commit
  after our snapshot → unchanged, skip. Otherwise `head = docstore.get(id)`:
  - `v !== null` and `head.ts > snapshot` → **document-changed** conflict (a newer
    revision — including a tombstone — landed after our snapshot).
  - `v === null` (we read *absence*) and `head !== null` and `head.ts > snapshot` →
    **absent-now-present** conflict (phantom insert of this exact id).
  - else OK. (The recorded `v` + `prev_ts` chain via `previous_revisions` cross-checks
    the predecessor link in distributed mode, where "head.ts > snapshot" alone is not
    sufficient because timestamps are merged across shards.)

- **`index_range` / `table_scan` (baseline `documentIds`, `readTimestamp = snapshot`)**
  Fast path: if `tableWriteWatermark(tableId) <= snapshot` → unchanged, skip.
  Otherwise **re-scan the same interval at `now`** (`readTs = oracle.getCurrentTimestamp()`,
  stable under the lock) via `docstore.index_scan`/`scan`, collect the current
  `DocKey` set (membership), and compare to the baseline:
  - any id **added** (entered the range) or **removed** (deleted/left) → **scan-changed**
    / **phantom-insert** conflict;
  - any surviving id whose `head.ts > snapshot` (value changed in place) → **scan-changed**
    conflict.
  `compareIndexKeys` bounds the re-scan to exactly the recorded `[start, end)`.

The `tableWriteWatermark` is a per-shard `Map<tableId, Timestamp>` of the max commit ts
written to each keyspace, updated on every successful apply. It makes validation **O(1)
per untouched table** and reserves re-scans for tables that actually changed — the same
trick the sync tier uses for its "subscribe-then-check-for-missed-writes" handshake
([internals/03](../internals/03-reactivity-sync.md)). It is bounded by an eviction
policy (see open issues).

> **Subtlety — record the *persisted* baseline, not the RYOW-merged view.** The
> `documentIds` baseline for a scan is the raw `DocStore` result at snapshot, *before*
> RYOW overlay. Validation compares persisted-then vs persisted-now; the UDF's merged
> view (which includes pending writes) is a read-time concern only. Mixing the two would
> make a transaction conflict with itself.

### 3.3 Read-your-own-writes & the staging buffers

The context holds three buffers (per [internals/02](../internals/02-transactions-consistency.md)):

- `stagedDocuments: DocumentLogEntry[]` — appended by `stageWrite`.
- `stagedIndexes: DatabaseIndexUpdate[]` — appended by `stageWrite`.
- `pendingDocuments: Map<DocKey, LocalWriteValue>` — doc key → latest staged value
  (`null` = delete). This is the RYOW index.

Read path overlay:
- `getLatest(id)` returns `pendingDocuments.get(key)` (as a synthetic `LatestDocument`
  at `previewTimestamp()`) if present, else `docstore.get(id, snapshot)`; either way it
  **records** a `ReadVersion.document` with the *persisted* version (so validation sees
  what we actually depended on), and charges `headroom.recordRead`.
- `scanTable` / `indexScan` stream the persisted scan, build a visibility `Map`, call
  `uncommitted().applyToVisibilityMap(map, tableId)` to overlay pending writes, record
  the persisted `documentIds` baseline + the scanned interval, and yield the merged rows.
  Query-correct filter/sort over the overlay is the query engine's
  `mergeUncommittedWrites`; the transactor provides the merged *visibility*, not the
  final ordering.

`UncommittedWrites` (via `uncommittedFromContext`) unifies the transactional path (read
`pendingDocuments`) and the one-shot mutation path (a plain `Map<DocKey, LocalWrite>`),
so the query engine applies RYOW identically regardless of caller.

### 3.4 Preview timestamps & apply-time stamping

A document inserted in a transaction needs a `_creationTime` and index keys *during*
execution (for RYOW reads and to order staged rows) — but the commit timestamp is not
known until Phase 2. Rule:

- `previewTimestamp()` returns a **transaction-local**, strictly-increasing provisional
  value seeded from `snapshotTimestamp` (a private counter; it never touches the shared
  oracle, keeping optimistic execution lock-free and not burning oracle timestamps).
  Inserted docs use it for `_creationTime`; the index-key-codec encodes index keys from
  the doc value as usual.
- **At Phase 3**, every staged `DocumentLogEntry.ts` and `DatabaseIndexUpdate.ts` is
  stamped with the single `commitTimestamp`, and `prev_ts` is wired to the revision the
  write supersedes (looked up once via `previous_revisions` for updated/deleted docs;
  `null` for inserts). **`_creationTime` (a value field) and the index keys derived from
  it are *not* rewritten** — the preview value becomes the document's permanent creation
  time. Uniqueness/total order is guaranteed by the `_id` tiebreaker every index appends
  ([internals/04](../internals/04-query-engine.md)), so duplicate `_creationTime` across
  two transactions that peeked the same snapshot is harmless. This keeps apply cheap (no
  key regeneration) and makes `commitTimestamp` purely the MVCC version stamp.

(The alternative — forcing `_creationTime == commitTimestamp` by regenerating index keys
at apply — is more "correct" to Convex semantics but costs a key recomputation per
inserted doc and re-couples apply to the IndexManager. We choose the cheaper rule; the
exact `_creationTime` ms-mapping is an open issue.)

### 3.5 Building the invalidation payload

From the staged writes the transactor derives the **write `RangeSet`** with no codec
help beyond wrapping bytes: one point range per written `DocumentLogEntry.id`
(`table:<hex>`) plus one point range per `DatabaseIndexUpdate.key`
(`index:<hex>:<name>`). Then:

```
writtenRanges = writeRangeSet.getRanges().map(serializeKeyRange)
writtenTables = writtenTablesFromRanges(writeRangeSet.getRanges())   // coarse signal (v1 granularity)
oplogEntry    = { commitTimestamp, shardId, writtenRanges, writtenTables }
invalidation  = normalizeWriteInvalidation({ shardId, writtenRanges, writtenTables,
                                             commitTimestamp, snapshotTimestamp })
```

Serialized from the start (`SerializedKeyRange`, not in-memory `ArrayBuffer`s) so the
payload crosses the `WriteFanout` boundary unchanged at Tier 2.

### 3.6 Headroom accounting

The `TransactionHeadroomTracker` accumulates as the UDF runs (`recordDatabaseQuery` per
storage call, `recordRead`/`recordReads` per materialized value, `trackWrittenDocument`
per staged doc keyed by `DocKey` so re-writes don't double-count,
`recordScheduledFunction` per scheduled follow-up). Any metric crossing its limit throws
`HeadroomExceededError` immediately (abort, **not** a conflict — non-retryable).
`snapshot()`/`restore()` let headroom participate in savepoints. Caps bound the commit
cost (a huge read set both blows headroom and makes conflicts likely), giving the OCC
retry loop a ceiling.

---

## 4. Package / module / file layout

Per [CLAUDE.md](../../../../CLAUDE.md) the engine lives in `packages/server`. The
transactor is one focused subtree:

```
packages/server/src/transactor/
  index.ts                 // public barrel: Transactor, SingleWriterTransactor, runInTransaction, all types §2
  transactor.ts            // SingleWriterTransactor (begin/commit/rollback) + commit critical section §3.1
  transaction-context.ts   // TransactionContext impl: snapshot, RYOW reads, staging, recording, savepoints
  commit-pipeline.ts       // stampDocuments/stampIndexes, buildCommitResult, table-write watermark
  occ-validation.ts        // ReadVersion, validateReadSet §3.2, conflict construction
  ryow/
    uncommitted-writes.ts   // UncommittedWrites + uncommittedFrom{Transaction,LocalWrites,Context}
    // NOTE: mergeUncommittedWrites lives in packages/server/src/query-engine (boundary §1)
  headroom.ts              // TransactionHeadroom(Tracker), HeadroomLimits, estimateValueBytes, HeadroomExceededError
  invalidation.ts          // WriteInvalidation, OplogDelta, normalize/has helpers, WriteFanout interface
  shard-writer.ts          // ShardWriter, AsyncMutex (FIFO), single-writer shard map (Tier 0: one entry)
  retry.ts                 // ConflictError, TransactionRetryPolicy, computeOccRetryDelayMs, runInTransaction
  types.ts                 // ShardId, DocKey, CommitResult, BeginOptions, IndexScanRequest, re-exported primitives
  __tests__/
    commit.spec.ts  occ-validation.spec.ts  ryow.spec.ts  headroom.spec.ts
    invalidation.spec.ts  retry.spec.ts  serializability.property.spec.ts
```

Dependency edges (enforced by lint boundaries):
`transactor → { sqlite-docstore (interfaces only), index-key-codec }`. It imports the
`DocStore`/`TimestampOracle` **interfaces**, never a concrete SQLite class — the engine
must never learn which backend it is on.

---

## 5. Tier 0 (single binary) — how it works NOW

At Tier 0 the whole stack is one process ([internals/06 `EmbeddedRuntime`](../internals/06-runtimes-topology.md)):

- **One shard.** `resolveShardWriter` is the trivial implementation returning the single
  local `ShardWriter` for `shardId === "default"`: one `AsyncMutex` + one
  `TimestampOracle` (the docstore's oracle). Every `begin`/`commit`/`CommitResult`/
  `WriteInvalidation` still carries `shardId: "default"`.
- **Storage** is the Node `SqliteDocStore` (`node:sqlite`, WAL) behind `TransactorDocStore`.
  `docstore.write` is a single SQLite transaction → Phase 3 is atomic for free.
- **Commit lock** is the in-process FIFO `AsyncMutex`. Because `node:sqlite` is
  synchronous and the docstore's serialized-transaction-runner already prevents
  interleaving, the mutex's job is to serialize the *validate→assign→apply* sequence
  (which spans `await`s) so no two commits' validations race.
- **Invalidation** flows through an in-memory `WriteFanout` adapter. On commit the
  embedded runtime's `notifyWrites` is driven by the fanout subscriber, synchronously
  handing the `WriteInvalidation` to the in-process `SyncProtocolHandler`, which
  intersects `writtenTables` (v1 granularity) against live subscriptions and pushes
  `Transition`s over the loopback socket. The transactor calls `writeFanout.publish(...)`
  — it never reaches into the sync handler directly (the publish boundary is the seam,
  §6 row 4).
- **Retry** is driven by the mutation runner (in udf-execution) calling
  `runInTransaction(transactor, requestId, ctx => runUserMutation(ctx), { retry, random: seededRng })`.
  On `ConflictError` the UDF re-executes against a fresh snapshot with the same seed
  derivation; deterministic replay makes this safe.

End-to-end Tier 0 mutation: `Mutation` frame → executor builds `fn` → `runInTransaction`
→ `begin` (snapshot) → user code reads (RYOW, recorded) + `ctx.db.*` → DocAccess gateway
computes `(DocumentLogEntry[], DatabaseIndexUpdate[])` via the IndexManager and calls
`ctx.stageWrite(...)` → `commit` (validate/assign/apply under the mutex) → `CommitResult`
→ `MutationResponse{ ts }` to the originator + `WriteInvalidation` fanned to subscribers.

---

## 6. Scale seam — how Tier 2 attaches with no app-code/engine rewrite

> *Single-writer-PER-SHARD is the unbounded-write-scale mechanism (seam-table row 1):
> the lock, oracle, and commit path are already scoped to a `shardId`, so Tier 2 runs
> one independent writer per conversation while OCC stays coordination-free.
> `CommitResult.oplogEntry`/`OplogDelta` are serializable — the durable, ordered record
> a distributed change-stream replays to sync nodes (row 4).*

The transactor is built so the WhatsApp-scale path is **adapters + config, never a
rewrite**. Mapping to [scalability-spectrum §3](../scalability-spectrum.md):

**Row 1 — unbounded write throughput (single-writer-per-shard).** The lock, oracle, and
the entire commit critical section are keyed on `ctx.shardId` via `resolveShardWriter`.
Tier 0 hands back one local `ShardWriter`; Tier 2 swaps in a resolver backed by
`ShardRouter.getShardForDocument(docId)` (consistent hashing on the conversation shard
key → committer), returning the `ShardWriter` for that conversation's Durable Object —
**one writer, one oracle, one lock per conversation**. The `SingleWriterTransactor` code
does not change: it already asks `resolveShardWriter(ctx.shardId)` and runs the same
three phases. Because any single conversation has a bounded write rate and there is **zero
cross-shard write contention**, total throughput scales linearly with shard count. OCC
stays coordination-free because validation never crosses shards — a transaction is
shard-local by construction (cross-shard atomic writes are explicitly out of scope; a
write spanning two conversations would need 2PC and chat never needs it).

**Row 2 — write co-location.** `shardId` is derived from a *field* (`conversationId`),
not a random doc id. Foundation already threads `shardId` through `begin → context →
stageWrite → commit → CommitResult → WriteInvalidation → OplogDelta`. Tier 2 adds a
`ShardKeyResolver` that maps a document to its shard from that field; the transactor
contract is unchanged (it receives a resolved `shardId`).

**Row 4 — transactor→sync fan-out across processes.** The transactor **publishes** to a
`WriteFanout` and never direct-calls the sync handler. Tier 0 uses an in-memory channel;
Tier 2 swaps the adapter for Redis/Queues/BroadcastChannel and the *same* commit code
emits a serializable `OplogDelta` (`{ commitTimestamp, shardId, writtenRanges:
SerializedKeyRange[], writtenTables }`) onto the change stream. Each sync node runs a
`ChangeStreamConsumer` tailing that stream and calls its *local* `notifyWrites`. The
committer fans out to N nodes through one ordered stream instead of N point-to-point
posts. The payload is serialized from day one, so nothing in the hot path changes shape.

**Oracle correctness across the seam.** `observeTimestamp` is already on the
`TimestampOracle` so a shard never issues a timestamp behind one it has observed
(recovery and distributed merge). Tier 0 only needs the monotonic peek/allocate; Tier 2
relies on `observeTimestamp` when a shard migrates or recovers. The interface reserves
it; the distributed merge semantics are deferred (open issue).

What Foundation must NOT do (and doesn't): hard-wire one global lock/oracle, derive the
shard from a random id, or let commit direct-call the sync handler. All three would turn
Endpoint B into a rewrite. The cost at Tier 0 is one `resolveShardWriter` indirection and
one `WriteFanout.publish` call — cheap insurance.

---

## 7. Failure & edge handling

| Case | Behavior |
|---|---|
| **OCC conflict** | `commit` throws `ConflictError`. `runInTransaction` rolls back, backs off (`computeOccRetryDelayMs`), and re-executes the UDF up to `maxAttempts`. Exhaustion rethrows; the runner maps it to the public `OccConflictError` (409, retryable). |
| **Pure-read transaction** (nothing staged) | Skips Phases 2–3 and the lock entirely. `CommitResult.committed = false`, `commitTimestamp/oplogEntry/invalidation = null`. No timestamp burned, no fan-out. |
| **Headroom exceeded** | `HeadroomExceededError` thrown mid-execution → abort. **Not** a conflict, **not** retried (retrying would re-exceed). Surfaces as a resource error. |
| **Patch/delete of an absent doc** | The DocAccess gateway throws `DocumentNotFoundError` (user error, 400) before staging — the transactor only ever stages tombstones for docs that exist at snapshot. |
| **Write-write to same doc in one txn** | `pendingDocuments` keeps the latest staged value; index updates net out (the IndexManager's unchanged-key no-op upstream avoids churn). Last write wins within the txn. |
| **Crash after `allocateTimestamp`, before `write`** | The timestamp is burned (a gap). Harmless: the oracle guarantees *increasing*, not *gapless*. Nothing was applied (`docstore.write` is atomic), so no partial state. |
| **Crash mid-`write`** | Impossible to observe partially: `docstore.write` is one SQLite transaction. On restart the oracle does `observeTimestamp(maxCommittedTs)` so it never reuses or goes backward. |
| **`commit`/`rollback` after the txn is finished** | State machine guards: `commit` on a non-`active` ctx throws a programming error; `rollback` is idempotent and no-ops after commit. |
| **Retry livelock** (large read set keeps conflicting) | Bounded by `maxAttempts` → surfaces `OccConflictError` rather than spinning. Mitigations (coarsen scans to table-level subscriptions, paginate, split the txn) noted as open issues. |
| **Absent-read validation** | Reads of non-existent docs record `version: null`; validation conflicts iff that exact id now exists with `ts > snapshot`. Range scans catch phantoms via the `documentIds` baseline diff. |
| **`conflictStrategy`** | v1 always `"Error"` (fail if a row already exists at `(ts, table, id)` — the normal path). `"Overwrite"` reserved for idempotent replay/import; not wired in v1. |
| **Slow validation under the lock** | Validation cost is bounded by headroom (read-set size) and short-circuited by the table-write watermark. The lock is held only for validate→assign→apply, never during UDF execution. |
| **Distributed mode (`mode: "distributed")`** | Reserved on the interface; Tier 0 always `"embedded"`. The `prev_ts`-chain cross-check in validation is the hook that makes the distributed path sound; not exercised in Foundation. |

---

## 8. Test strategy

**Unit (deterministic, fast):**

- *Commit pipeline:* happy-path 3-phase commit applies staged docs+indexes atomically;
  pure-read txn returns `committed:false` and burns no timestamp; `commitTimestamp`
  strictly `> snapshotTimestamp` and `> all prior commits`.
- *RYOW:* a `getLatest`/`scanTable`/`indexScan` issued after a `stageWrite` in the same
  txn reflects the staged value (insert/update/delete), while the recorded `ReadVersion`
  carries the *persisted* version (assert the baseline is pre-overlay).
- *OCC validation — every conflict reason:* `document-changed` (concurrent update),
  `absent-now-present` (phantom insert of a read-absent id), `phantom-insert` /
  `scan-changed` (doc enters/leaves/changes inside a recorded range), and the
  *negative* cases (no conflict when the change is outside the range, or to a different
  table, or is the txn's own write). Assert exclude-own-writes.
- *Table-write watermark:* validation short-circuits (no re-scan, asserted via a docstore
  spy) when a read table saw no commit after snapshot; re-scans when it did.
- *Headroom:* each limit trips `HeadroomExceededError` at the right boundary;
  `trackWrittenDocument` is idempotent per `DocKey`; `snapshot()/restore()` round-trips
  exactly (including after a savepoint rollback).
- *Invalidation shape:* `CommitResult.oplogEntry`/`invalidation` carry `shardId`,
  serialized `writtenRanges`, `writtenTables` derived correctly; `WriteFanout.publish`
  called once per committed write, never for pure reads.
- *Retry:* `computeOccRetryDelayMs` is monotone-bounded and deterministic for a fixed
  `random`; `runInTransaction` re-invokes `fn` exactly once per attempt, stops on first
  success, rethrows after `maxAttempts`, and propagates non-conflict errors immediately.
- *State machine:* double-commit / commit-after-rollback guarded.

**Property / model-based (the load-bearing guarantees):**

- *Serializability (the headline test):* generate random interleavings of N mutations
  over a shared key space (point + range reads, inserts/updates/deletes). Run them
  through the transactor with `runInTransaction`; assert the final DocStore state equals
  the result of **some serial order** of the committed transactions, and that **no
  committed transaction read a value that changed under it** (reconstruct from the MVCC
  log). A counterexample is a correctness bug, not a flake.
- *OCC soundness vs a reference model:* a single-threaded reference executor applies the
  same op stream; every transaction the real transactor commits must be valid at its
  commit timestamp in the reference; every transaction it conflicts must have a genuine
  intervening write. (Differential test: no false-OK, minimize false-conflicts.)
- *Retry convergence under contention:* with deterministic replay and `maxAttempts` high
  enough, a batch of contending mutations all eventually commit with no lost updates;
  with `maxAttempts` low, exhaustion surfaces `OccConflictError` (never silent loss).
- *Invalidation completeness (differential, ties row 1/4):* for random commits and random
  recorded read ranges, the set selected by intersecting `writtenRanges` against a read
  range must be a **superset** of every read whose result actually changed — a *missed*
  invalidation is a silent reactivity bug. Assert the table-level v1 signal
  (`writtenTables`) never under-reports relative to a range-level oracle.
- *Monotonic timestamps across restart:* across many commits with a simulated restart
  (`observeTimestamp(maxCommittedTs)` then resume), commit timestamps are strictly
  increasing and never reused.
- *Single-writer mutual exclusion:* instrument the commit critical section with an
  overlap detector; under concurrent `commit` calls assert the validate→assign→apply
  sections never interleave.
- *Preview→commit consistency:* the `(indexKey, _id)` ordering of docs inserted in a txn
  is identical between the in-txn RYOW scan and a post-commit `index_scan` (no reordering
  at apply).

**Integration with dependencies:**

- Against the real `SqliteDocStore`: a write whose encoded index key falls *inside* a
  recorded `[start, end)` is detected as a conflict; a key just *outside* is not
  (exercises `compareIndexKeys` end-to-end). This is the seam where a codec ordering bug
  would surface as a missed/false conflict, so it runs against the actual codec, not a
  stub. (The exhaustive codec ordering property tests themselves live in
  **index-key-codec**.)

---

## 9. Open issues / risks

Carried forward (consistent with [internals/02 open questions](../internals/02-transactions-consistency.md)):

1. **Phantom-precision vs re-scan cost.** Range validation currently re-scans the
   recorded interval when the table watermark advanced. Cheaper sound signals
   (per-index-range version, or tracking max write ts per keyspace at finer grain) are
   deferred until measured; re-scan is the correct baseline.
2. **Read-set size vs retry livelock.** Big table scans blow headroom and conflict often.
   Need a policy: scan pagination, coarse table-level subscriptions for wide scans, or
   transaction splitting. Headroom caps are the current ceiling.
3. **`_creationTime` ↔ ms mapping.** We assign `_creationTime` from the txn-local preview
   value and do not rewrite it to the commit ts (§3.4). The precise mapping from the
   logical timestamp space to the Convex ms-float `_creationTime` (and whether any app
   relies on `_creationTime ≈ wall clock`) must be pinned before locking the wire format.
4. **Table-write-watermark growth.** The per-shard `Map<tableId, Timestamp>` grows with
   table cardinality; needs the same bounded-eviction policy as the sync tier's
   `tableWriteTimestamps` (lazy + forced cleanup), with metrics.
5. **Oracle merge semantics for distributed mode.** `observeTimestamp` must guarantee a
   shard never issues a ts behind one it has observed/committed; clock-merge rules need
   pinning before the Tier 2 committer path is attempted.
6. **Invalidation intersection as a hot path.** v1 ships table-level matching; the
   range-intersection optimization (per-`tableId` interval tree over subscription read
   ranges) is a measured later step — the transactor already emits range-precise
   `writtenRanges`, so the upgrade is sync-side only.
7. **Cross-shard transactions.** Explicitly out of scope. Confirm the app/data model
   never needs an atomic write spanning shards in v1, or the single-writer proof does not
   hold for that operation.
8. **Savepoints.** Kept structurally (grouped, snapshottable state) but not exercised by
   Foundation's mutation path; nested-execution rollback semantics need their own tests
   before any feature depends on them.
