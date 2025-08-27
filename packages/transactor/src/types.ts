/**
 * Transactor contracts. The `Transactor` runs a function as a serializable transaction;
 * on commit it produces a `CommitResult` and emits an `OplogDelta` to the `WriteFanout`
 * (the transactor→sync seam, scale-seam #4). Pure-read transactions skip the commit path.
 */
import type { ShardId } from "@stackbase/id-codec";
import type { KeyRange, RangeSet, SerializedKeyRange } from "@stackbase/index-key-codec";
import type {
  DatabaseIndexUpdate,
  DocumentValue,
  IndexOverlayEntry,
  InternalDocumentId,
} from "@stackbase/docstore";
import type { HeadroomLimits } from "./headroom";

/** A committed write's invalidation payload — serializable, so it crosses processes (Tier 2). */
export interface OplogDelta {
  commitTs: bigint;
  shardId: ShardId;
  writtenRanges: SerializedKeyRange[];
  writtenTables: string[];
}

export interface CommitResult<T> {
  value: T;
  /** False for pure-read transactions (nothing was written). */
  committed: boolean;
  commitTs: bigint;
  shardId: ShardId;
  /** Null when nothing was written. */
  oplog: OplogDelta | null;
}

/** Where committed deltas are published; the sync tier subscribes. */
export interface WriteFanout {
  publish(delta: OplogDelta): void | Promise<void>;
}

/** The API a mutation uses to read and stage writes inside a transaction. */
export interface TransactionContext {
  readonly snapshotTs: bigint;
  readonly shardId: ShardId;
  /** The accumulated read set (ranges) — for OCC validation and reactivity. */
  readonly reads: RangeSet;
  /** Read a document (records the read for OCC; sees the transaction's own pending writes). */
  get(id: InternalDocumentId): Promise<DocumentValue | null>;
  /** Stage an insert/replace. */
  put(id: InternalDocumentId, value: DocumentValue): void;
  /** Stage a delete (tombstone). */
  delete(id: InternalDocumentId): void;
  /** Merge an externally-computed read range (e.g. an index range from the query engine). */
  recordRead(range: KeyRange): void;
  /** Merge an externally-computed write range (e.g. index-key ranges from a write). */
  recordWrite(range: KeyRange): void;
  /** Stage index entry updates to be applied atomically at commit. */
  stageIndexUpdates(updates: readonly DatabaseIndexUpdate[]): void;
  /**
   * The net pending index-key changes for `indexId` (last write per key wins), so a query scan
   * can overlay this transaction's own uncommitted writes — read-your-own-writes for `.query()`,
   * matching what `get()` already does. Empty when nothing pending touches this index.
   */
  pendingIndexOverlay(indexId: string): readonly IndexOverlayEntry[];
}

export interface RunInTransactionOptions {
  shardId?: ShardId;
  /** Max deterministic replays on conflict (default 8). */
  maxRetries?: number;
  headroom?: Partial<HeadroomLimits>;
}

export interface Transactor {
  runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options?: RunInTransactionOptions,
  ): Promise<CommitResult<T>>;
}
