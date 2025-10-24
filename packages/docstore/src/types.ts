/**
 * The `DocStore` contract — the narrow storage seam (design §3.1, internals/01). The
 * engine never imports a database driver; it speaks only this interface. Any backend that
 * can do an ordered, point-in-time range scan can implement it (SQLite, Postgres, D1, …).
 *
 * The data model is an append-only MVCC log: every write appends a `DocumentLogEntry`
 * `{ ts, id, value|null, prev_ts }`; the newest revision with `ts <= readTimestamp` is what
 * a snapshot read sees. A `null` value is a tombstone (the document is deleted as of `ts`).
 */
import type { InternalDocumentId, ShardId } from "@stackbase/id-codec";
import { documentIdKey } from "@stackbase/id-codec";
import type { JSONValue, Value } from "@stackbase/values";

export type { InternalDocumentId, ShardId };

/** A document's fields (a Value object, including system fields like `_id`/`_creationTime`). */
export type DocumentValue = Record<string, Value>;

export interface ResolvedDocument {
  id: InternalDocumentId;
  value: DocumentValue;
}

/** One revision in the append-only log. `value === null` is a tombstone. */
export interface DocumentLogEntry {
  ts: bigint;
  id: InternalDocumentId;
  value: ResolvedDocument | null;
  prev_ts: bigint | null;
}

/** The materialized newest-visible revision of a live document. */
export interface LatestDocument {
  ts: bigint;
  value: ResolvedDocument;
  prev_ts: bigint | null;
}

export type Order = "asc" | "desc";
export type ConflictStrategy = "Error" | "Overwrite";

/** A half-open byte interval over an index's key space. */
export interface Interval {
  start: Uint8Array;
  end: Uint8Array | null; // null = +∞
}

export interface TimestampRange {
  minInclusive: bigint;
  maxExclusive: bigint;
}

export type DatabaseIndexValue =
  | { type: "Deleted" }
  | { type: "NonClustered"; docId: InternalDocumentId };

export interface DatabaseIndexUpdate {
  indexId: string;
  key: Uint8Array;
  value: DatabaseIndexValue;
}

export interface IndexWrite {
  ts: bigint;
  update: DatabaseIndexUpdate;
}

/**
 * One commit's worth of staged rows for `commitWriteBatch` (Fleet B4, D1 — group commit). Each unit
 * is stamped with its OWN freshly-allocated, strictly-increasing timestamp inside a single store
 * transaction, so a batch of N units lands as N consecutive commits in one fsync. The `documents`/
 * `indexUpdates` arrive with `ts: 0n` placeholders, exactly like `commitWrite`.
 *
 * CONTRACT — same-doc entries across units are ILLEGAL input: no two units in one batch may write
 * the SAME document id. The transactor's batch-cut rule (spec §D2) guarantees this upstream (a blind
 * write to an in-flight doc is held to the next batch; an RMW aborts on OCC), so the store does NOT
 * detect or resolve cross-unit same-doc collisions — it stamps each unit's `prev_ts` verbatim.
 */
export interface CommitUnit {
  documents: readonly DocumentLogEntry[];
  indexUpdates: readonly IndexWrite[];
  /** Opaque per-unit commit metadata (Fleet B3/B4) — forwarded to the commit guard's per-unit entry. */
  meta?: Record<string, string>;
}

/**
 * The per-unit view a batch-shaped commit guard receives (Fleet B4, D1): the store's freshly
 * allocated `ts` for that unit plus its opaque `meta`. The guard runs ONCE per `commitWriteBatch`
 * transaction with the whole `readonly CommitGuardUnit[]` (in unit/ts order) — it fences once and
 * loops the per-unit effects (e.g. an idempotency-row INSERT at each unit's own `ts`). The
 * single-commit `commitWrite` path passes a one-unit array, so there is exactly ONE guard contract.
 */
export interface CommitGuardUnit {
  ts: bigint;
  meta?: Record<string, string>;
}

/**
 * A single index-key change staged by the current transaction, projected for read-your-own-writes
 * overlay onto a query scan. `value === null` means the key is deleted (tombstoned) in the pending
 * write set; a non-null `value` is the pending document at that key (insert or update).
 */
export interface IndexOverlayEntry {
  key: Uint8Array;
  value: DocumentValue | null;
}

export interface PrevRevQuery {
  id: InternalDocumentId;
  ts: bigint;
}

// Reserved for search/vector index registration (M-later); ignored at Tier 0.
export interface SchemaSetupOptions {
  searchIndexes?: readonly unknown[];
  vectorIndexes?: readonly unknown[];
}

export interface DocStore {
  /** Create the physical schema (idempotent). */
  setupSchema(options?: SchemaSetupOptions): Promise<void>;

  /** Append document revisions and index updates atomically. */
  write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void>;

  /**
   * Commit a transaction's staged rows, allocating the commit timestamp inside the store's OWN
   * atomicity domain, then return it. The `ts` fields on `documents`/`indexUpdates` arrive as `0n`
   * placeholders and are overwritten by the store — every document and index row of the commit is
   * stamped with the single allocated ts.
   *
   * This closes the allocated-but-unlanded window that a caller-side oracle opens (allocate in
   * memory → then write): here allocation and landing are one atomic step. Postgres:
   * `nextval('stackbase_ts')` inside the commit transaction, so the ts is visible atomically with
   * its rows. SQLite: `MAX(ts) + 1` inside its transaction (race-free under the single writer).
   * The `write()` path is deliberately left untouched — the replica-apply path depends on its
   * caller-supplied timestamps.
   */
  commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
    /**
     * Opaque commit metadata (Fleet B3, D3 — effectively-once forwarding): threaded straight
     * through from `RunOptions.commitMeta` → `RunInTransactionOptions.commitMeta` → here, never
     * interpreted by core. SQLite ignores it entirely (non-fleet pays nothing); Postgres passes
     * `opts.meta` on to an installed commit guard's 4th parameter, which fleet code uses to write
     * an idempotency row atomically inside the same commit transaction.
     */
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint>;

  /**
   * Group commit (Fleet B4, D1). Commit N `units` as ONE store transaction: each unit is stamped with
   * its own freshly-allocated, STRICTLY-INCREASING timestamp (allocated in unit order), its rows are
   * inserted, and — for Postgres — a single batch-shaped commit guard runs ONCE at the end over all N
   * `{ts, meta}` entries (epoch fence once, frontier once at ts_N, per-unit idempotency INSERT each at
   * its own ts). ANY error — including the guard — aborts the WHOLE transaction: no unit lands. Returns
   * the allocated ts's in unit order.
   *
   * `commitWrite` (single) is exactly this with a one-unit batch — both share one implementation, so
   * the guard invocation shape is identical (a one-unit array) whether one or many units commit.
   * SQLite has no guard and ignores per-unit `meta`; its consecutive `MAX(ts)+1` per unit yields the
   * same strictly-increasing contract (correct-but-inert batching — Tier-0 flushes synchronously).
   */
  commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]>;

  /** The newest visible revision of a document at `readTimestamp` (or latest), or null. */
  get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null>;

  /** Ordered, point-in-time scan of an index, yielding `[key, document]`. */
  index_scan(
    indexId: string,
    tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]>;

  /**
   * Tail the log over a timestamp range (the change feed / fan-out source).
   *
   * `limit`, when set, caps the number of revisions returned and is pushed into the backend's SQL
   * `LIMIT` clause (NOT a generator break — the Postgres implementation buffers the whole range
   * before yielding, so a caller-side break would not bound the query). Rows are returned in `order`
   * (asc for the change feed), so a limited `asc` scan yields the `limit` LOWEST-timestamped
   * revisions at or after `range.minInclusive`; a follow-up call resumes from the last returned ts.
   * Because a single commit stamps every one of its documents with the SAME ts, a `limit` can cut
   * in the middle of a commit's revisions — the log-tail consumer (`readLog`) accounts for this by
   * only advancing its cursor past fully-scanned timestamps.
   */
  load_documents(range: TimestampRange, order: Order, limit?: number): AsyncGenerator<DocumentLogEntry>;

  /** The revisions visible at each `(id, ts)` — used by OCC validation. */
  previous_revisions(queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>>;

  /** All live documents in a table at `readTimestamp` (or latest). */
  scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]>;

  /** Count of live documents currently in a table. */
  count(tableId: string): Promise<number>;

  /** The highest committed timestamp in the log (0 if empty) — the restart recovery high-water mark. */
  maxTimestamp(): Promise<bigint>;

  getGlobal(key: string): Promise<JSONValue | null>;
  writeGlobal(key: string, value: JSONValue): Promise<void>;
  writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean>;

  /** Release the backend (checkpoint/close file, or end the Postgres connection). */
  close(): void | Promise<void>;
}

/** Allocates the monotonic commit timestamps the log is ordered by (one per shard). */
export interface TimestampOracle {
  /** The latest *allocated* timestamp (may be an in-flight, not-yet-applied commit). */
  getCurrentTimestamp(): bigint;
  /** The latest *fully-applied* commit timestamp — the safe snapshot for new transactions. */
  getLastCommittedTimestamp(): bigint;
  /**
   * Legacy: allocates a timestamp from the caller-side oracle, independent of `DocStore`.
   * `SingleWriterTransactor.commit` no longer calls this — it hands `DocStore.commitWrite` `ts: 0n`
   * placeholders and lets the store allocate inside its own atomicity domain instead, closing the
   * allocated-but-unlanded window this method opens. Kept on the interface for compat (e.g. tests
   * or callers that still want a standalone monotonic counter).
   */
  allocateTimestamp(): bigint;
  /** Mark a commit as fully applied (advances the last-committed clock). */
  publishCommitted(ts: bigint): void;
  observeTimestamp(ts: bigint): void;
}

/** Map key for `previous_revisions` results. */
export function getPrevRevQueryKey(id: InternalDocumentId, ts: bigint): string {
  return `${documentIdKey(id)}@${ts}`;
}
