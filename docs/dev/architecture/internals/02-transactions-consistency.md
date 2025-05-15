---
title: Internals — Transactor, OCC & Reactive Invalidation
status: extracted (clean-room notes; concave studied as reference)
---

# Transactor, OCC & Reactive Invalidation

> Clean-room note: this document describes contracts WE (Stackbase) will build. It
> was written by studying the type signatures (`.d.ts`) of concave (FSL-1.1, source
> available) as a reference for the problem shape. Method and type names below are
> our own spec vocabulary; where we cite concave names it is to anchor the
> correspondence for future reviewers, not to copy implementation.

---

## Purpose & the single-writer model

This subsystem is the consistency core: it makes mutations atomic and serializable,
and it produces the **invalidation signal** that drives reactive queries. It sits
between the UDF (user-defined function) execution layer above and the document store
(`DocStore`) below.

The design rests on a **single-writer-per-shard** model. Within one shard (concave:
one Durable Object), commits are serialized — exactly one transaction commits at a
time, and a monotonic clock (the **TimestampOracle**) hands out strictly increasing
timestamps. This is what makes OCC cheap: because commits are serialized, validation
only has to ask "did anything I read change between my snapshot and now?" rather than
coordinate locks across concurrent writers.

Two operating modes are anticipated (concave exposes this on the `Transactor` /
`ExecutionContext` interfaces as a `mode` discriminant):

- **Simple / embedded mode** — the transactor validates and commits directly against
  local storage (a single shard's SQLite). This is the common case and the one we
  build first.
- **Distributed mode** — the transaction is forwarded to a coordinator/committer that
  validates and commits to shared storage, then fans deltas back out. We treat this as
  a later extension; the interfaces are shaped to allow it without rework.

Key reference types (concave `interfaces/transactor.d.ts`):

- `TransactionHandle { requestId, start_ts, mode }` — an opaque handle for an in-flight
  transaction, carrying its snapshot timestamp and mode.
- `CommitResult { commit_ts, oplog_entry?, written_ranges }` — the result of a commit:
  the assigned commit timestamp, the key ranges that were written, and an optional
  oplog delta for downstream consumers.
- The `Transactor` itself is a tiny lifecycle interface: `begin(requestId)`,
  `commit(handle)` (throws `ConflictError` on validation failure), `rollback(handle)`.

For Stackbase we keep this minimal lifecycle: **begin → execute (track reads, stage
writes) → commit (validate, assign ts, apply) | rollback**.

---

## The commit pipeline

A mutation executes against a **snapshot timestamp** captured at `begin`. Everything
it reads is read "as of" that snapshot, and everything it writes is buffered until
commit. Concretely (concave splits this across `TransactionManager`,
`OccMutationTransaction`, and `occ-validation`):

1. **Begin.** Capture a snapshot timestamp from the TimestampOracle
   (`getCurrentTimestamp()` — read the clock without advancing it). All reads in this
   transaction are constrained to versions at or before this timestamp (snapshot
   isolation). Concave models this as `OccMutationTransaction(docstore,
   snapshotTimestamp, ...)`; our `TransactionContext` exposes `snapshotTimestamp`.

2. **Execute.** The UDF reads and writes through the transaction:
   - Reads (`getLatest(id)`, `getManyLatest(ids)`, `scanTable(tableId)`, index range
     scans) go to the docstore at the snapshot timestamp, but first consult the
     transaction's own pending writes (read-your-own-writes, below). Every read is
     **recorded** into the read set and the read ranges.
   - Writes are **staged**, not applied: `stageWrite(documents, indexes,
     conflictStrategy)` buffers `DocumentLogEntry[]` plus index updates. Staged writes
     become visible to later reads in the same transaction, and they populate the write
     ranges. Concave keeps two staging buffers — `stagedDocuments` and `stagedIndexes` —
     plus a `pendingDocuments` map (document key → latest version, or null for delete).

3. **Commit (three phases).** Concave documents `OccMutationTransaction.commit()` as a
   three-phase operation, which we adopt verbatim in spirit:
   - **Phase 1 — Validate.** Re-check the read set: for every document/range read, has a
     newer version appeared since the snapshot? If yes, throw `ConflictError`. (See OCC
     validation below.)
   - **Phase 2 — Assign timestamp.** Allocate **one** commit timestamp from the oracle
     (`allocateTimestamp()` / `allocateTimestampAsync()`), used for *all* writes in the
     transaction so they appear atomically at a single point in time.
   - **Phase 3 — Apply.** Write all staged documents and index updates to the docstore
     atomically at the commit timestamp (`DocStore.write(documents, indexes,
     conflictStrategy)`).
   - Returns the commit timestamp (or "nothing committed" when no writes were staged —
     a pure read transaction needs no commit ts).

4. **Rollback** simply discards the staging buffers and read set; nothing was applied.

**TimestampOracle role** (concave `docstore/interface.d.ts`): a small monotonic clock
with `getCurrentTimestamp()` (peek), `allocateTimestamp()` (advance + return, sync),
`allocateTimestampAsync()` (advance with serialization guarantees), and
`observeTimestamp(ts)` (advance the clock to at least an externally-seen value — needed
in distributed mode so a shard never issues a timestamp behind one it has already
observed). The oracle is the linchpin: snapshot reads use the peeked value; the commit
uses a freshly allocated value strictly greater than any prior commit on this shard.

Concave also exposes `allocatePreviewTimestamp()` on the transaction — a way to mint a
provisional timestamp for staged-but-uncommitted writes so they can be ordered/encoded
into index keys before the real commit ts is known. We will need an equivalent for
RYOW ordering.

---

## Read sets & write sets

The transaction tracks what it touched at two granularities, because the same
information serves two masters: **OCC conflict detection** (needs versions) and
**reactive invalidation** (needs key ranges). Concave unifies both into a single
`RangeSet` representation (`queryengine/indexing/read-write-set.d.ts`) and keeps a
parallel per-document version map for validation.

### Key ranges (the unified representation)

A `KeyRange` is `{ tableId, startKey, endKey, isPoint }`:

- `tableId` is a namespaced keyspace identifier — concave uses `table:<tableHex>` for a
  table's primary keyspace and `index:<tableHex>:<index>` for a secondary index. This
  explicit namespacing is what lets a write on an index range be matched against a read
  on the same index range.
- `startKey` / `endKey` are `ArrayBuffer`s encoded with the **same value encoding as
  the indexes**, so lexicographic byte comparison equals logical key order. `endKey`
  is: equal to `startKey` for a point read; an exclusive upper bound for a bounded
  range; `null` for an unbounded range (to infinity).
- `isPoint` flags single-key reads `[key, key]`.

A `RangeSet` is a collection of these with builder methods: `addDocument({table,
internalId})` (point), `addIndexRange(table, index, start, end)`, `addTableScan(tableId)`
(the whole table as one range), plus `getRanges()`, `getRangesByTable()`, `getTables()`,
`clone()`, `isEmpty()`. There is a `SerializedKeyRange` form (base64/hex strings instead
of `ArrayBuffer`) for JSON transport across the wire — important for distributed mode and
for shipping invalidations to the sync tier.

The transaction keeps two of these: **read ranges** and **write ranges**. Concave
surfaces them as `getReadRanges(): KeyRange[]` and `getWrittenRanges(): KeyRange[]` for
the subscription manager.

### Read set (versions, for validation)

Separately from ranges, each read is recorded with the *version* observed, so commit
validation can detect change. Concave's `ReadVersion` (`occ-validation.d.ts`) is a
tagged union:

- `{ type: "document", version: bigint | null }` — a point read; `version` is the doc's
  timestamp, or `null` if the doc was absent (reads of absence must also be validated —
  a phantom insert is a conflict).
- `{ type: "index_range", indexId, startKey, endKey, readTimestamp, documentIds }` — a
  range scan; remembers the range bounds, when it was read, and the set of doc IDs the
  scan returned.
- `{ type: "table_scan", tableId, readTimestamp, documentIds }` — a full table scan,
  same idea at table granularity.

So a read is recorded twice over: once as a version entry (for "did it change?") and
once as a key range (for "who is subscribed to this region?"). Concave's
`recordDocumentRead`, `recordTableScan`, and `recordIndexRangeScan` do exactly this dual
recording.

### Write set

Writes populate the write `RangeSet` (point per written document, plus the index keys
touched), and the staging buffers hold the actual `DocumentLogEntry` rows and
`DatabaseIndexUpdate` rows to be applied at commit. A `DocumentLogEntry` is
`{ ts, id, value, prev_ts }` — note the **`prev_ts`** back-pointer linking each new
revision to the revision it supersedes; this is central to OCC validation (next section).

### Precision / granularity

The granularity is deliberately variable: point reads are tracked as single-key ranges
(precise — minimal false invalidations); range and table scans are tracked as their
covering range (coarser — a table scan conflicts with *any* write to that table). This
is the standard OCC trade-off: finer tracking = fewer false conflicts and fewer spurious
re-renders, at the cost of more bookkeeping. We will start with this same point/range/
table tier and can tighten scan tracking later if false-positive invalidations hurt.

---

## OCC validation

At commit, Phase 1 asks: **for everything this transaction read at its snapshot, is the
current state still consistent with what it saw?** Concave's
`validateReadSetForCommit(docstore, readChecks: Array<[string, ReadVersion]>,
writtenDocKeys: Set<string>)` is the contract.

How conflict is detected, per read-set entry:

- **Point read of a document** — compare the document's current latest version against
  the recorded `version`. The mechanism uses the revision chain: each
  `DocumentLogEntry` carries `prev_ts` (the timestamp of the revision it replaced). The
  docstore offers `previous_revisions(...)` and `previous_revisions_of_documents(...)`
  to walk these links. Validation confirms that the version the transaction read is
  still the immediate predecessor of (or equal to) the current head — i.e. no
  committed write slipped in between the snapshot and now. A read of an absent document
  (`version: null`) conflicts if the document now exists at a ts after the snapshot.
- **Range / table scan** — re-evaluate whether any document inside the recorded range
  has changed since `readTimestamp`, or whether a *new* document now falls in the range
  (phantom). The recorded `documentIds` set is the baseline; a mismatch is a conflict.

`writtenDocKeys` is passed so validation can **exclude the transaction's own writes**
from conflict checks — you must not conflict with yourself (you read your own staged
write, that is expected, not a conflict).

**Retry behavior.** On conflict, commit throws `ConflictError` (concave:
`transactor/transaction-manager.d.ts`). The transactor itself does **not** retry; the
caller (the function runner) catches `ConflictError`, discards the transaction, and
re-executes the whole UDF against a fresh snapshot. Concave's class docs say exactly
this: "Automatic retry on conflict (handled by caller)." Because mutations are
deterministic functions of the database state, replaying them is safe. We adopt
caller-driven retry with a bounded attempt count and backoff.

**Serializability argument.** With single-writer commit serialization + a monotonic
oracle + full read-set validation (including absence/phantoms via range tracking), every
committed transaction is equivalent to having executed instantaneously at its commit
timestamp, in commit order. A transaction only commits if nothing it read changed
between snapshot and commit, so its reads are valid as-of the commit point — that is the
textbook OCC serializability condition. The single-writer model removes write-write
races entirely (commits are sequential), so only the read-validation obligation remains.

Concave's `savepoint` support (`createSavepoint()` / `restoreSavepoint()`) snapshots the
full transaction state — staged docs, staged indexes, read set, pending docs, read/write
ranges, headroom — so nested execution (e.g. a sub-call) can be rolled back without
aborting the whole transaction. We treat savepoints as a secondary feature but keep the
state grouped so it is snapshottable.

---

## Read-your-own-writes (RYOW)

Within a single transaction, a read must see this transaction's own uncommitted writes,
even though they are not yet in the docstore. Concave handles this in two layers.

1. **Inside the transaction.** Reads consult `pendingDocuments` (doc key → latest, or
   null for delete) before hitting the docstore. `getLatest` returns the pending write
   if one exists; `scanTable` merges pending writes over the persisted scan results.
   This is the "buffered writes are visible to subsequent reads" guarantee.

2. **A unified abstraction for query merging.** Concave consolidates RYOW into an
   `UncommittedWrites` class (`ryow/uncommitted-writes.d.ts`) that abstracts over two
   sources: a full `OccMutationTransaction` (transactional path) and a plain
   `Map<string, LocalWrite>` (non-transactional / simple mutation path). Constructed via
   `fromTransaction(tx)`, `fromLocalWrites(map)`, or `fromContext(tx, localWrites)`
   (auto-detect). It offers: `hasWrites()`, `getTableWrites(tableId, tableName)` (→ map
   of developer id → value, null = deleted), `getDocumentWrite(developerId)` (→ value,
   `null` = deleted, `undefined` = no write), and `applyToVisibilityMap(visibleDocs,
   tableId)` (mutate a scan's visibility map to add/update/remove per pending writes).

3. **The merge helper.** `mergeUncommittedWrites(documents, uncommittedWrites, options)`
   (concave `merge-uncommitted-writes.d.ts`) is the query-time glue: it takes the
   persisted query results plus the uncommitted writes and produces the corrected
   result. Its algorithm: build a map from persisted docs → apply uncommitted writes
   (insert/update/delete) → filter by the query's range expressions → sort by the
   query's index fields (`order: asc | desc`). This is what makes a query issued *after*
   a write in the same mutation reflect that write, including correct ordering and
   filtering, before commit.

For Stackbase we keep the `UncommittedWrites` abstraction because it lets the query
engine apply RYOW uniformly without caring whether it is inside an OCC transaction or a
one-shot mutation.

---

## Invalidation → reactivity

A committed write set is the source of truth for "which subscriptions must recompute."
The bridge from transactor to sync tier is the **write ranges** turned into an
**invalidation delta**.

Reference shapes:

- `WriteInvalidation { writtenRanges?: SerializedKeyRange[], writtenTables?: string[],
  commitTimestamp?, snapshotTimestamp? }` (concave `invalidation.d.ts`), with helpers
  `normalizeWriteInvalidation(...)` and `hasWriteInvalidation(...)`. The ranges are in
  **serialized** form because invalidations cross process/wire boundaries.
- `writtenTablesFromRanges(ranges)` (concave `utils/written-ranges.d.ts`) derives a
  deduplicated list of table names from the written ranges — a coarse fallback signal
  ("table X changed") for consumers that match at table granularity rather than range
  granularity.
- `ChangeDelta { commit_ts, written_ranges: KeyRange[], written_tables, shard_id? }`
  and the `ChangeStreamConsumer` interface (concave
  `interfaces/change-stream-consumer.d.ts`): `start()`, `stop()`, `onChanges(cb)`,
  `getCurrentPosition()`. In simple mode this is in-process direct notification; in
  distributed mode the consumer polls an oplog or receives pushed deltas, tracking its
  position with `getCurrentPosition()`.
- `OplogDelta { commit_ts, shard_id?, written_ranges, written_tables }` and
  `CommitResult.oplog_entry` (concave `transactor.d.ts`) — the commit optionally emits
  an oplog entry so the change stream has a durable, ordered record to replay.

**The flow.** On commit, the transactor produces a `CommitResult` carrying
`written_ranges` and the `commit_ts`. The subscription/sync layer holds, for each live
query subscription, that query's **read ranges** (captured when the query last ran — the
exact same `KeyRange` representation). To invalidate, it intersects the committed
**write ranges** against every subscription's **read ranges**: any subscription whose
read ranges overlap a written range is marked stale and scheduled to recompute (re-run
the query, diff, push the update to the client). Because reads and writes use the same
namespaced, byte-encoded `KeyRange` representation, overlap is a straightforward
range-intersection test per `tableId`. Subscriptions that did not read any written
region are provably unaffected and are left untouched — that is the precision win that
makes fine-grained reactivity cheap.

So the read set does double duty: at commit time it validates *this* transaction (OCC),
and while a query subscription is live it is the index the sync tier uses to decide who
to notify. The write set likewise does double duty: it is applied to storage and it is
the invalidation payload.

---

## Transaction limits / headroom

Every transaction runs under resource caps to bound cost and protect the single-writer
shard from a runaway UDF (concave `limits/transaction-headroom.d.ts`). The tracked
metrics and concave's limits:

- `bytesRead`, `bytesWritten` — byte volume in/out (limits are configured constants).
- `databaseQueries` — number of storage queries, cap **4096**.
- `documentsRead` — cap **32000**.
- `documentsWritten` — cap **16000**.
- `functionsScheduled` — scheduled/transactional follow-up functions, cap **1000**.
- `scheduledFunctionArgsBytes` — total size of scheduled-function arguments.

Each metric is reported as `{ used, remaining }` (`TransactionMetric`), and the whole
set as `TransactionHeadroom`. A `TransactionHeadroomTracker` accumulates usage as the
transaction runs: `recordDatabaseQuery(count?)`, `recordRead(value)` / `recordReads(...)`,
`recordScheduledFunction(args)`, `trackWrittenDocument(key, value)`, with
`snapshot()` / `restore(snapshot)` so headroom participates in savepoints, and
`getHeadroom()` to read current state. There is an `estimateConvexValueBytes(value)`
helper for sizing values consistently.

Why: these caps enforce fairness and predictability on a shared single-writer resource,
prevent unbounded memory growth in the staging buffers, and give the OCC retry loop a
ceiling (a transaction that keeps growing its read set would otherwise conflict
forever). Exceeding a limit aborts the transaction with a resource error rather than a
conflict. Note `documentsWritten < documentsRead` — reads are cheaper than writes, and
writes also feed invalidation fan-out, so they are capped tighter. The tracker keeps a
`writtenDocuments` map (doc key → size) so re-writing the same doc is not double-counted.

For Stackbase we adopt the same metric set with our own tuned limits, and we keep the
tracker snapshot/restore so limits survive savepoint rollback.

---

## How Stackbase reimplements this

What we keep (load-bearing, adopt as-is in spirit):

- **Per-shard single-writer + monotonic TimestampOracle.** The whole OCC argument
  depends on serialized commits and strictly increasing timestamps. We keep this. Tier 2
  is sharded; within a shard, commits serialize.
- **Snapshot read → staged writes → three-phase commit** (validate, assign single ts,
  apply atomically). Pure-read transactions skip the commit ts entirely.
- **Unified `KeyRange` / `RangeSet`** as the single representation for both OCC and
  invalidation, with byte-encoded keys and explicit `table:` / `index:` namespacing. The
  dual-use of the read set (validation + subscription matching) is the elegant core and
  we keep it.
- **`prev_ts` revision chain** for version-based conflict detection, plus range/table
  scan tracking for phantom protection.
- **Caller-driven retry on `ConflictError`** (deterministic UDF replay), bounded.
- **`UncommittedWrites` abstraction + `mergeUncommittedWrites`** for RYOW across both
  transactional and one-shot mutation paths.
- **Headroom tracker** with snapshot/restore.

What we simplify (at least initially):

- **Simple mode only, first.** Build the embedded single-shard transactor; defer the
  distributed committer/coordinator path. Keep the wire-serializable `SerializedKeyRange`
  and `OplogDelta`/`ChangeDelta` shapes so distributed mode is an extension, not a
  rewrite.
- **Coarser scan tracking acceptable at v1.** Start with point/range/table tiers exactly
  as concave; only invest in tighter range tracking if false invalidations measurably
  hurt.
- **In-process `ChangeStreamConsumer`** for reactivity initially (direct notification on
  commit), with the oplog/poll path reserved for the distributed tier.
- **Single `conflictStrategy: "Error"`** path first (concave's `"Overwrite"` exists but
  is essentially unused in the OCC path); add `"Overwrite"` only if a real upsert/import
  need appears.

Per-shard single-writer for **Tier 2**: each Tier-2 shard owns its keyspace and its own
oracle; cross-shard transactions are out of scope for v1 (a transaction is shard-local).
This keeps the serializability proof local to a shard and avoids distributed commit
coordination until we genuinely need multi-shard transactions.

---

## Open questions / risks

- **Phantom precision for range scans.** Validating that "no new document entered my
  scanned range" requires either re-scanning at commit or a reliable index-range version
  signal. Re-scanning is correct but costs reads (and headroom). Need to decide the
  cheapest sound mechanism; concave's `documentIds` baseline implies a re-check.
- **Read-set size vs. retry livelock.** Large read sets (big table scans) both blow
  headroom and make conflicts likely, risking repeated retries. Need a strategy: scan
  pagination, coarse table-level subscriptions for big scans, or transaction splitting.
- **Oracle correctness in distributed mode.** `observeTimestamp` must guarantee a shard
  never issues a ts behind one it has already seen/committed; clock-merge semantics need
  pinning down before we attempt the distributed tier.
- **`allocatePreviewTimestamp` semantics.** Provisional timestamps for staged writes
  must not leak into committed index keys or collide with the real commit ts. We need a
  clear rule for rewriting preview ts → commit ts at apply time.
- **Invalidation granularity vs. cost.** Range-intersection over many subscriptions per
  commit could become a hot path; may need an interval index (per `tableId`) over
  subscription read ranges rather than linear scan.
- **Cross-shard transactions.** Explicitly deferred — but we should confirm the app/data
  model never *needs* an atomic write spanning shards in v1, or the single-writer proof
  does not hold for that operation.
- **Absent-read validation cost.** Validating reads of non-existent documents (null
  version) and not-yet-existing keys is required for correctness but easy to get wrong;
  needs dedicated tests.
