/**
 * `ShardWriter` — the single-writer OCC machinery for exactly ONE shard: a mutex, a
 * recent-commits ring, refcounted active-snapshot bookkeeping, and a timestamp oracle.
 * Extracted verbatim from the pre-sharding `SingleWriterTransactor` (shards B2a, D1) so it
 * can be instantiated once per shard: `SingleWriterTransactor` wraps exactly one
 * `ShardWriter` (today's behavior, byte-identical); `ShardedTransactor`
 * (`./sharded-transactor.ts`) holds a lazily-created `Map<ShardId, ShardWriter>` — one per
 * shard, each independently mutexed so cross-shard commits are independent promises that can
 * genuinely interleave at the transactor level.
 *
 * Execution is optimistic and lock-free: the function reads at a snapshot timestamp,
 * recording read ranges, and stages writes into an `UncommittedWrites` buffer (read your
 * own writes). Commit runs the 3-phase pipeline under this shard's mutex:
 *
 *   1. VALIDATE — has any commit since our snapshot written something we read? (validated
 *      read set ∩ write set — see the two-read-set split below). If so → `OccConflictError`,
 *      and the caller replays the deterministic fn.
 *   2+3. APPLY+ALLOCATE — hand all staged revisions to `DocStore.commitWrite` with `ts: 0n`
 *      placeholders; the store allocates the commit timestamp *inside its own atomicity domain*
 *      and stamps + lands every row atomically, closing the allocated-but-unlanded window a
 *      caller-side oracle allocation would open. The returned ts is then published as the new
 *      last-committed clock and used to build the `OplogDelta`.
 *
 * Two-read-set split (D4): `TransactionContextImpl` tracks both `reads` (the reporting/
 * invalidation UNION — everything `recordRead` or `recordReadUnvalidated` touched, plus every
 * `get()`) and a private `validatedReads` (OCC-only — everything `recordRead`/`get()` touched,
 * but NOT `recordReadUnvalidated`). The commit's conflict predicate consults ONLY
 * `validatedReads`; external readers of `ctx.reads` (executor/kernel, unmodified by this
 * package) keep seeing the union, so a caller that never calls `recordReadUnvalidated` sees
 * identical behavior to before this split existed.
 */
import { OccConflictError } from "@stackbase/errors";
import { encodeStorageTableId, type ShardId } from "@stackbase/id-codec";
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
  IndexOverlayEntry,
  IndexWrite,
  InternalDocumentId,
  TimestampOracle,
} from "@stackbase/docstore";
import { AsyncMutex } from "./async-mutex";
import type { HeadroomLimits } from "./headroom";
import { HeadroomTracker } from "./headroom";
import { UncommittedWrites } from "./uncommitted-writes";
import type { CommitResult, OplogDelta, RunInTransactionOptions, TransactionContext, WriteFanout } from "./types";

function docKeyspace(id: InternalDocumentId): string {
  return tableKeyspaceId(encodeStorageTableId(id.tableNumber));
}

/** Stable string form of index-key bytes, for de-duplicating staged updates by key. */
function hexKey(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

class TransactionContextImpl implements TransactionContext {
  /** Reporting/invalidation UNION (D4) — every range `recordRead`, `recordReadUnvalidated`,
   *  or `get()` touched. What executor/kernel read externally via `ctx.reads`. */
  readonly reads = new RangeSet();
  /** OCC-validated-ONLY subset (D4) — what the commit's conflict predicate consults. Always
   *  a subset of `reads`: `recordReadUnvalidated` adds to `reads` but never to this. */
  readonly validatedReads = new RangeSet();
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
    this.validatedReads.addKey(docKeyspace(id), id.internalId);
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
    this.validatedReads.add(range);
  }

  recordReadUnvalidated(range: KeyRange): void {
    this.reads.add(range);
  }

  recordWrite(range: KeyRange): void {
    this.writeRanges.add(range);
  }

  stageIndexUpdates(updates: readonly DatabaseIndexUpdate[]): void {
    for (const u of updates) this.indexUpdates.push(u);
  }

  pendingIndexOverlay(indexId: string): readonly IndexOverlayEntry[] {
    // Collapse this transaction's staged index-key changes for `indexId` to the net per-key
    // state (last write wins). A replace whose indexed field changed appears as a Deleted at the
    // old key plus a NonClustered at the new key; a same-key update appears as a NonClustered
    // (its value is read from `staged`). The query runtime overlays these onto its committed scan.
    const byKey = new Map<string, IndexOverlayEntry>();
    for (const u of this.indexUpdates) {
      if (u.indexId !== indexId) continue;
      if (u.value.type === "Deleted") {
        byKey.set(hexKey(u.key), { key: u.key, value: null });
      } else {
        // A NonClustered entry corresponds to a staged put; treat a since-tombstoned doc as a delete.
        const staged = this.staged.get(u.value.docId);
        byKey.set(hexKey(u.key), { key: u.key, value: staged ? staged.value : null });
      }
    }
    return [...byKey.values()];
  }
}

export interface RecentCommit {
  ts: bigint;
  writes: RangeSet;
}

/** One shard's writer state — `SingleWriterTransactor`'s pre-sharding machinery, extracted
 *  so `ShardedTransactor` can hold one of these per shard (see the module doc above). */
export class ShardWriter {
  readonly mutex = new AsyncMutex();
  recentCommits: RecentCommit[] = [];
  /** Active transaction snapshots (refcounted) — bounds how far back we must retain commits. */
  readonly activeSnapshots = new Map<bigint, number>();

  constructor(
    private readonly docStore: DocStore,
    readonly oracle: TimestampOracle,
    private readonly shardId: ShardId,
    private readonly fanout: WriteFanout | undefined,
    private readonly defaultHeadroom: HeadroomLimits,
  ) {}

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
    // Phase 1 — validate: any commit after our snapshot that touched something we (validated-ly)
    // read? Consults ONLY `validatedReads` (D4) — `recordReadUnvalidated` ranges never abort a
    // commit, by design (the documented write-skew class for global tables in sharded txns).
    for (const c of this.recentCommits) {
      if (c.ts > snapshotTs && ctx.validatedReads.intersects(c.writes)) {
        throw new OccConflictError("transaction read data that was changed before it committed");
      }
    }

    // Phase 2+3 — apply: append staged revisions (chaining prev_ts to the snapshot revision) and
    // allocate the commit timestamp inside the store's own atomicity domain. Entries carry a `0n`
    // placeholder ts; the store stamps + returns the real one, closing the allocated-but-unlanded
    // window a caller-side oracle allocation would otherwise open.
    const entries: DocumentLogEntry[] = [];
    for (const w of ctx.staged.entries()) {
      // Chain prev_ts from the *latest committed* revision (we hold the single-writer lock,
      // so this is race-free). Using the stale snapshot would fork the revision chain when
      // two transactions blind-write the same document.
      const prev = await this.docStore.get(w.id);
      entries.push({
        ts: 0n,
        id: w.id,
        prev_ts: prev ? prev.ts : null,
        value: w.value === null ? null : { id: w.id, value: w.value },
      });
    }
    const indexWrites: IndexWrite[] = ctx.indexUpdates.map((update) => ({ ts: 0n, update }));
    const commitTs = await this.docStore.commitWrite(entries, indexWrites, shardId);

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
