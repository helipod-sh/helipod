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

  /** Tail the log over a timestamp range (the change feed / fan-out source). */
  load_documents(range: TimestampRange, order: Order): AsyncGenerator<DocumentLogEntry>;

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
  allocateTimestamp(): bigint;
  /** Mark a commit as fully applied (advances the last-committed clock). */
  publishCommitted(ts: bigint): void;
  observeTimestamp(ts: bigint): void;
}

/** Map key for `previous_revisions` results. */
export function getPrevRevQueryKey(id: InternalDocumentId, ts: bigint): string {
  return `${documentIdKey(id)}@${ts}`;
}
