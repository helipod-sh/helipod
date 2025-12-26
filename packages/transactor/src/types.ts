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
import type { JSONValue } from "@stackbase/values";
import type { HeadroomLimits } from "./headroom";

/** One document written by a commit, carried through the in-process fan-out so the sync tier can
 *  derive row diffs without re-reading the store. Present only on the local/owner commit path;
 *  absent on cross-process (fleet) / forwarded paths (those fall back to full re-run). */
export interface WrittenDoc {
  /** base64 of the doc's primary-key bytes — matches a `SerializedKeyRange.start` for a point `get`. */
  key: string;
  /** the doc's primary keyspace, `table:<encodedTableNumber>` (encoded, matches read-range keyspaces). */
  keyspace: string;
  /** the public document id string — the diff `Change.key`. */
  docId: string;
  /** the new document JSON, or `null` for a delete/tombstone. */
  newRow: JSONValue | null;
  /** whether the doc existed before this commit (`prev_ts !== null`) — distinguishes insert vs update. */
  wasPresent: boolean;
  /** the commit ts (number). */
  ts: number;
}

/** A committed write's invalidation payload — serializable, so it crosses processes (Tier 2). */
export interface OplogDelta {
  commitTs: bigint;
  shardId: ShardId;
  writtenRanges: SerializedKeyRange[];
  writtenTables: string[];
  /**
   * G4 origin-frontier tag (client-sync verdict §(d) item 2). The sync SESSION id that originated
   * this commit — an ephemeral, in-memory-fan-out-only string, stamped HERE at oplog construction
   * (AFTER `commitWrite` returns) and NEVER passed into `DocStore.commitWrite`/`commitMeta` (it is
   * not durable state — a spy test asserts it never reaches either store). Rides the fan-out so the
   * origin session's `version.ts` can be advanced past its own commit even when the commit touched
   * nothing that session subscribes to. Undefined for any commit with no originating session (HTTP
   * `/api/run`, drivers, boot steps) — those simply don't get an origin-frontier advance.
   */
  origin?: string;
  /** Written documents for local row-diffing (§DLR 2a). Absent on cross-process/forwarded paths. */
  writtenDocs?: WrittenDoc[];
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
  /**
   * The accumulated read set (ranges) — for reactivity/invalidation reporting. As of the
   * two-read-set split (shards B2a, D4) this is the UNION of every `recordRead`/`get()` call
   * (OCC-validated) and every `recordReadUnvalidated` call (invalidation-only); the commit's
   * OCC conflict predicate consults only the validated subset internally. A caller that never
   * calls `recordReadUnvalidated` sees `reads` behave exactly as before the split.
   */
  readonly reads: RangeSet;
  /** Read a document (records the read for OCC; sees the transaction's own pending writes). */
  get(id: InternalDocumentId): Promise<DocumentValue | null>;
  /** Stage an insert/replace. */
  put(id: InternalDocumentId, value: DocumentValue): void;
  /** Stage a delete (tombstone). */
  delete(id: InternalDocumentId): void;
  /** Merge an externally-computed read range (e.g. an index range from the query engine) into
   *  the OCC-validated set (and, transitively, `reads` — see its doc above). */
  recordRead(range: KeyRange): void;
  /**
   * Merge an externally-computed read range into `reads` ONLY — it is never checked by the
   * commit's OCC conflict predicate (shards B2a, D4: the documented write-skew class for
   * global/unsharded tables read from a sharded mutation's split snapshot). Still feeds
   * invalidation/reporting via `reads`, so subscriptions over that range still recompute on a
   * concurrent write to it — only this transaction's own commit is exempted from aborting
   * over it.
   */
  recordReadUnvalidated(range: KeyRange): void;
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
  /**
   * Opaque commit metadata (Fleet B3, D3 — effectively-once forwarding): threaded straight
   * through to `DocStore.commitWrite`'s `opts.meta`, never interpreted by the transactor itself.
   * Only meaningful for a transaction that actually commits (a pure read never reaches
   * `commitWrite`); unset → `commitWrite` still gets called with `{ meta: undefined }`, which
   * SQLite ignores and an unset Postgres commit guard never sees.
   */
  commitMeta?: Record<string, string>;
  /**
   * G4 origin-frontier tag (client-sync verdict §(d) item 2). The sync SESSION id that originated
   * this transaction, threaded straight onto the emitted `OplogDelta.origin` at oplog construction
   * and NOTHING else — the transactor never interprets it, and it is DELIBERATELY not forwarded to
   * `DocStore.commitWrite`'s `opts` (unlike `commitMeta`): origin is an ephemeral fan-out routing
   * hint, never durable commit state. Unset → the emitted oplog carries no origin.
   */
  origin?: string;
}

export interface Transactor {
  runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options?: RunInTransactionOptions,
  ): Promise<CommitResult<T>>;
}
