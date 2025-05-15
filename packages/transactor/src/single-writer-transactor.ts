/**
 * `SingleWriterTransactor` — the heart of the write path.
 *
 * Execution is optimistic and lock-free: the function reads at a snapshot timestamp,
 * recording a read set, and stages writes into an `UncommittedWrites` buffer (read your
 * own writes). Commit runs the 3-phase pipeline under a single-writer lock:
 *
 *   1. VALIDATE — has any commit since our snapshot written something we read? (read-set ∩
 *      write-set). If so → `OccConflictError`, and the caller replays the deterministic fn.
 *   2. ALLOCATE — take one monotonic commit timestamp for the whole transaction.
 *   3. APPLY    — append all staged revisions to the store, then publish an `OplogDelta`.
 *
 * Single-writer per *shard* gives serializability cheaply (no cross-writer coordination) and
 * scales out by adding shards — see scalability-spectrum §2.1.
 */
import { OccConflictError } from "@stackbase/errors";
import { DEFAULT_SHARD, encodeStorageTableId, type ShardId } from "@stackbase/id-codec";
import {
  RangeSet,
  serializeKeyRange,
  tableKeyspaceId,
  writtenTablesFromRanges,
} from "@stackbase/index-key-codec";
import type { KeyRange } from "@stackbase/index-key-codec";
import type {
  DatabaseIndexUpdate,
  DocStore,
  DocumentLogEntry,
  DocumentValue,
  IndexWrite,
  InternalDocumentId,
  TimestampOracle,
} from "@stackbase/docstore";
import { AsyncMutex } from "./async-mutex";
import { DEFAULT_HEADROOM, HeadroomTracker, type HeadroomLimits } from "./headroom";
import { UncommittedWrites } from "./uncommitted-writes";
import type {
  CommitResult,
  OplogDelta,
  RunInTransactionOptions,
  TransactionContext,
  Transactor,
  WriteFanout,
} from "./types";

function docKeyspace(id: InternalDocumentId): string {
  return tableKeyspaceId(encodeStorageTableId(id.tableNumber));
}

class TransactionContextImpl implements TransactionContext {
  readonly reads = new RangeSet();
  readonly writeRanges = new RangeSet();
  readonly staged = new UncommittedWrites();
  readonly indexUpdates: DatabaseIndexUpdate[] = [];

  constructor(
    readonly snapshotTs: bigint,
    readonly shardId: ShardId,
    private readonly docStore: DocStore,
    private readonly headroom: HeadroomTracker,
  ) {}

  async get(id: InternalDocumentId): Promise<DocumentValue | null> {
    this.headroom.countRead();
    this.reads.addKey(docKeyspace(id), id.internalId);
    const local = this.staged.get(id);
    if (local) return local.value; // read-your-own-writes (value, or null if deleted)
    const doc = await this.docStore.get(id, this.snapshotTs);
    return doc ? doc.value.value : null;
  }

  put(id: InternalDocumentId, value: DocumentValue): void {
    this.headroom.countWrite();
    this.writeRanges.addKey(docKeyspace(id), id.internalId);
    this.staged.set(id, value);
  }

  delete(id: InternalDocumentId): void {
    this.headroom.countWrite();
    this.writeRanges.addKey(docKeyspace(id), id.internalId);
    this.staged.set(id, null);
  }

  recordRead(range: KeyRange): void {
    this.reads.add(range);
  }

  recordWrite(range: KeyRange): void {
    this.writeRanges.add(range);
  }

  stageIndexUpdates(updates: readonly DatabaseIndexUpdate[]): void {
    for (const u of updates) this.indexUpdates.push(u);
  }
}

interface RecentCommit {
  ts: bigint;
  writes: RangeSet;
}

export interface SingleWriterTransactorOptions {
  shardId?: ShardId;
  fanout?: WriteFanout;
  defaultHeadroom?: HeadroomLimits;
}

export class SingleWriterTransactor implements Transactor {
  private readonly mutex = new AsyncMutex();
  private recentCommits: RecentCommit[] = [];
  /** Active transaction snapshots (refcounted) — bounds how far back we must retain commits. */
  private readonly activeSnapshots = new Map<bigint, number>();
  private readonly shardId: ShardId;
  private readonly fanout: WriteFanout | undefined;
  private readonly defaultHeadroom: HeadroomLimits;

  constructor(
    private readonly docStore: DocStore,
    private readonly oracle: TimestampOracle,
    options: SingleWriterTransactorOptions = {},
  ) {
    this.shardId = options.shardId ?? DEFAULT_SHARD;
    this.fanout = options.fanout;
    this.defaultHeadroom = options.defaultHeadroom ?? DEFAULT_HEADROOM;
  }

  async runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    const maxRetries = options.maxRetries ?? 8;
    const shardId = options.shardId ?? this.shardId;
    const headroomLimits = { ...this.defaultHeadroom, ...options.headroom };

    for (let attempt = 0; ; attempt++) {
      // Snapshot from the last *fully-applied* commit, never an in-flight allocated ts —
      // otherwise a new txn could snapshot at a commit ts whose writes aren't applied yet,
      // and the strict `c.ts > snapshotTs` conflict check would miss it (lost update).
      const snapshotTs = this.oracle.getLastCommittedTimestamp();
      this.retain(snapshotTs);
      try {
        const ctx = new TransactionContextImpl(
          snapshotTs,
          shardId,
          this.docStore,
          new HeadroomTracker(headroomLimits),
        );
        const value = await fn(ctx);

        if (ctx.staged.size === 0) {
          // Pure read: the snapshot is already consistent; nothing to commit.
          return { value, committed: false, commitTs: snapshotTs, shardId, oplog: null };
        }

        return await this.mutex.runExclusive(() => this.commit(ctx, snapshotTs, shardId, value));
      } catch (e) {
        if (e instanceof OccConflictError && attempt < maxRetries) continue; // deterministic replay
        throw e;
      } finally {
        this.release(snapshotTs);
      }
    }
  }

  private async commit<T>(
    ctx: TransactionContextImpl,
    snapshotTs: bigint,
    shardId: ShardId,
    value: T,
  ): Promise<CommitResult<T>> {
    // Phase 1 — validate: any commit after our snapshot that touched something we read?
    for (const c of this.recentCommits) {
      if (c.ts > snapshotTs && ctx.reads.intersects(c.writes)) {
        throw new OccConflictError("transaction read data that was changed before it committed");
      }
    }

    // Phase 2 — allocate one commit timestamp for the whole transaction.
    const commitTs = this.oracle.allocateTimestamp();

    // Phase 3 — apply: append staged revisions, chaining prev_ts to the snapshot revision.
    const entries: DocumentLogEntry[] = [];
    for (const w of ctx.staged.entries()) {
      // Chain prev_ts from the *latest committed* revision (we hold the single-writer lock,
      // so this is race-free). Using the stale snapshot would fork the revision chain when
      // two transactions blind-write the same document.
      const prev = await this.docStore.get(w.id);
      entries.push({
        ts: commitTs,
        id: w.id,
        prev_ts: prev ? prev.ts : null,
        value: w.value === null ? null : { id: w.id, value: w.value },
      });
    }
    const indexWrites: IndexWrite[] = ctx.indexUpdates.map((update) => ({ ts: commitTs, update }));
    await this.docStore.write(entries, indexWrites, "Error", shardId);

    this.recentCommits.push({ ts: commitTs, writes: ctx.writeRanges });
    // Advance the committed clock only now that writes are applied + recorded (still under
    // the mutex), so a concurrent snapshot can never observe this commit before it's safe.
    this.oracle.publishCommitted(commitTs);
    this.prune();

    const ranges = ctx.writeRanges.toArray();
    const oplog: OplogDelta = {
      commitTs,
      shardId,
      writtenRanges: ranges.map(serializeKeyRange),
      writtenTables: writtenTablesFromRanges(ranges),
    };
    // Fire-and-forget so a slow/failing subscriber never stalls or aborts the single writer.
    if (this.fanout) {
      try {
        void this.fanout.publish(oplog);
      } catch {
        /* a fan-out failure must not fail the commit */
      }
    }

    return { value, committed: true, commitTs, shardId, oplog };
  }

  private retain(ts: bigint): void {
    this.activeSnapshots.set(ts, (this.activeSnapshots.get(ts) ?? 0) + 1);
  }

  private release(ts: bigint): void {
    const n = (this.activeSnapshots.get(ts) ?? 0) - 1;
    if (n <= 0) this.activeSnapshots.delete(ts);
    else this.activeSnapshots.set(ts, n);
  }

  private minActiveSnapshot(): bigint {
    let min: bigint | null = null;
    for (const ts of this.activeSnapshots.keys()) if (min === null || ts < min) min = ts;
    return min ?? this.oracle.getLastCommittedTimestamp();
  }

  /** Drop commits that can no longer conflict with any active or future transaction. */
  private prune(): void {
    const min = this.minActiveSnapshot();
    if (this.recentCommits.some((c) => c.ts <= min)) {
      this.recentCommits = this.recentCommits.filter((c) => c.ts > min);
    }
  }
}
