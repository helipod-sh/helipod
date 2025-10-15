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
import { documentIdKey, encodeStorageTableId, type ShardId } from "@stackbase/id-codec";
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

/** Fresh empty group-commit batch (Fleet B4, D2) with its promotion promise wired. */
function newBatch(): Batch {
  let resolvePromoted!: () => void;
  const promoted = new Promise<void>((res) => {
    resolvePromoted = res;
  });
  return {
    units: [],
    writesUnion: new RangeSet(),
    writtenDocKeys: new Set<string>(),
    promoted,
    resolvePromoted,
  };
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

/* ----------------------------------------------------------------------------------------- *
 * Group commit (Fleet B4, D2). A per-shard two-buffer stage-then-flush pipeline built BEHIND
 * the `groupCommit` flag: `runInTransactionGrouped` splits the mutex-held commit section (fast,
 * in-memory staging) from the flush I/O (`commitWriteBatch`, run OFF the mutex by a single lazy
 * committer loop). Idle → each stager forms a batch of 1 = today's latency; only while a prior
 * flush is in flight do ready mutations accumulate and land as ONE store transaction. None of the
 * types/fields/methods below are touched by the single-commit path (`runInTransactionSingle`),
 * which is byte-identical to the pre-B4 code.
 * ----------------------------------------------------------------------------------------- */

/** One staged-but-unflushed transaction inside a batch: everything the committer loop needs to land
 *  it and resolve its caller — the store rows, the invalidation write set, and the promise handles. */
interface StagedUnit {
  readonly documents: DocumentLogEntry[];
  readonly indexUpdates: IndexWrite[];
  readonly meta?: Record<string, string>;
  readonly writeRanges: RangeSet;
  readonly shardId: ShardId;
  readonly value: unknown;
  resolve(result: CommitResult<unknown>): void;
  reject(error: unknown): void;
}

/** A group-commit batch: its units plus the aggregate write-visibility indexes (D2) and a `promoted`
 *  promise that fulfils when the batch LEAVES the in-flight state — landed in the ring OR failed.
 *  batch-cut and tagged-conflict awaiters block on `promoted`: once it fulfils, `docStore.get` reads
 *  a committed revision and the ring reflects the batch (on success), so re-staging/replay is safe. */
interface Batch {
  readonly units: StagedUnit[];
  /** Union of all units' writeRanges — the validate-visibility set for this in-flight batch (D2). */
  readonly writesUnion: RangeSet;
  /** Doc ids written by any unit — the batch-cut-visibility set (a blind write to one of these must
   *  wait; only reachable via blind writes since an RMW would have aborted in the validate step). */
  readonly writtenDocKeys: Set<string>;
  readonly promoted: Promise<void>;
  resolvePromoted(): void;
}

type StageOutcome<T> =
  | { kind: "staged"; completion: Promise<CommitResult<T>> }
  | { kind: "cut"; wait: Promise<void> };

/** Package-private tag: an `OccConflictError` raised against an IN-FLIGHT (flushing OR pending) write
 *  carries the conflicting batch's `promoted` promise, so the retry loop awaits that batch's landing
 *  before it replays (D2). A ring conflict is untagged and retries immediately, as today. Kept off the
 *  shared `@stackbase/errors` type — a transactor-only concern that must not leak into the FSL surface. */
const CONFLICT_WAIT = Symbol("groupCommitConflictWait");
type TaggedConflict = OccConflictError & { [CONFLICT_WAIT]?: Promise<void> };

/** One shard's writer state — `SingleWriterTransactor`'s pre-sharding machinery, extracted
 *  so `ShardedTransactor` can hold one of these per shard (see the module doc above). */
export class ShardWriter {
  readonly mutex = new AsyncMutex();
  recentCommits: RecentCommit[] = [];
  /** Active transaction snapshots (refcounted) — bounds how far back we must retain commits. */
  readonly activeSnapshots = new Map<bigint, number>();

  // --- Group-commit state (Fleet B4, D2). Only read/written when `groupCommit` is true. ---
  /** The staging buffer new mutations append to (created lazily; null after a detach until the next
   *  stager repopulates it). */
  private pendingBatch: Batch | null = null;
  /** The batch currently being flushed OFF the mutex by the committer loop, or null between flushes.
   *  Its writes stay visible to validation/batch-cut for the whole flush window (D2). */
  private flushingBatch: Batch | null = null;
  /** Whether the single lazy committer loop is alive. Mutated ONLY under the mutex (both here at
   *  stage time and in the loop's detach step), so "queue non-empty ⇒ a committer runs" holds without
   *  a wedge race — see `ensureCommitter`/`runCommitter`. */
  private committerRunning = false;
  /** Size of the most recently flushed batch (T4 health). */
  lastBatchSize = 0;
  /** Largest batch ever flushed on this shard (T4 health — proves batching actually engaged). */
  maxBatchSize = 0;
  /** Total flushes performed on this shard (T4 health — flushes/sec derived externally). */
  flushCount = 0;

  constructor(
    private readonly docStore: DocStore,
    readonly oracle: TimestampOracle,
    private readonly shardId: ShardId,
    private readonly fanout: WriteFanout | undefined,
    private readonly defaultHeadroom: HeadroomLimits,
    /** Fleet B4: when true, `runInTransaction` routes to the two-buffer stage-then-flush committer
     *  loop (`runInTransactionGrouped`); when false (default) it uses the byte-identical
     *  single-commit path (`runInTransactionSingle`). Structurally separate branches by design. */
    private readonly groupCommit: boolean = false,
  ) {}

  runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    return this.groupCommit
      ? this.runInTransactionGrouped(fn, options)
      : this.runInTransactionSingle(fn, options);
  }

  private async runInTransactionSingle<T>(
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

        return await this.mutex.runExclusive(() => this.commit(ctx, snapshotTs, shardId, value, options.commitMeta));
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
    commitMeta?: Record<string, string>,
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
    // Opaque commit metadata (Fleet B3, D3): always passed as an `opts` object so the shape at
    // `DocStore.commitWrite` is uniform whether or not a caller set `commitMeta` — SQLite ignores
    // it either way, and an unset Postgres commit guard never sees `{ meta: undefined }`.
    const commitTs = await this.docStore.commitWrite(entries, indexWrites, shardId, { meta: commitMeta });

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

  /* --------------------------------------------------------------------------------------- *
   * Group-commit path (Fleet B4, D2) — active only when `groupCommit` is true.
   * --------------------------------------------------------------------------------------- */

  private async runInTransactionGrouped<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    const maxRetries = options.maxRetries ?? 8;
    const shardId = options.shardId ?? this.shardId;
    const headroomLimits = { ...this.defaultHeadroom, ...options.headroom };

    for (let attempt = 0; ; attempt++) {
      // Same snapshot discipline as the single path: the last FULLY-APPLIED commit, never an
      // in-flight ts (the committer publishes to the oracle only once the store has landed the rows).
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
          // Pure read: never touches the batch machinery (D3) — identical to the single path.
          return { value, committed: false, commitTs: snapshotTs, shardId, oplog: null };
        }

        // Stage-then-flush. The mutex-held stage step appends this unit to the shard's pending batch
        // and hands back a completion promise the committer loop resolves POST-flush. We `await` that
        // completion HERE, inside the `try` — so the `finally` `release(snapshotTs)` runs only AFTER
        // the flush lands. That is the retention path the spec calls out: the unit's snapshot stays
        // pinned in `activeSnapshots` across the whole flush window, so `minActiveSnapshot` holds ring
        // pruning back until every in-flight unit resolves (bounded by in-flight concurrency, not a
        // leak). The batch-cut may need to release the mutex and re-stage against committed state, so
        // the stage step runs in a loop (each iteration re-takes the mutex and re-validates).
        for (;;) {
          const outcome = await this.mutex.runExclusive(() =>
            this.stageUnit(ctx, snapshotTs, shardId, value, options.commitMeta),
          );
          if (outcome.kind === "cut") {
            await outcome.wait; // the in-flight same-doc batch promoted; re-stage against committed state
            continue;
          }
          return await outcome.completion;
        }
      } catch (e) {
        if (e instanceof OccConflictError && attempt < maxRetries) {
          // A conflict against an IN-FLIGHT (flushing/pending) write is tagged with that batch's
          // promotion promise: wait for it to land, THEN replay at a lastCommitted that includes it
          // (the lost-update fix). A ring conflict is untagged and replays immediately, as today.
          const wait = (e as TaggedConflict)[CONFLICT_WAIT];
          if (wait) await wait;
          continue;
        }
        throw e; // non-OCC (incl. FencedError) and exhausted retries propagate, never batched-retried
      } finally {
        this.release(snapshotTs);
      }
    }
  }

  /**
   * The mutex-held stage step (D2). Runs the fast, in-memory part of commit — validate, batch-cut,
   * prev_ts resolution, append — then returns the unit's completion promise WITHOUT awaiting the flush
   * I/O (that happens off-mutex in the committer loop). Returns `{kind:"cut"}` when a blind write must
   * wait for an in-flight same-doc batch to promote (the caller awaits then re-enters), or THROWS a
   * (possibly tagged) `OccConflictError`. MUST be invoked under `this.mutex`.
   */
  private async stageUnit<T>(
    ctx: TransactionContextImpl,
    snapshotTs: bigint,
    shardId: ShardId,
    value: T,
    commitMeta: Record<string, string> | undefined,
  ): Promise<StageOutcome<T>> {
    // Phase 1 — VALIDATE against `recentCommits ∪ flushingBatch ∪ pendingBatch` (D2 two-buffer
    // visibility). Every staged-but-unlanded write is logically after every current snapshot, so a
    // validated read intersecting ANY of them must abort exactly as if it had committed — otherwise a
    // lost update slips past a write that has not yet reached the ring.
    for (const c of this.recentCommits) {
      if (c.ts > snapshotTs && ctx.validatedReads.intersects(c.writes)) {
        throw new OccConflictError("transaction read data that was changed before it committed");
      }
    }
    if (this.flushingBatch && ctx.validatedReads.intersects(this.flushingBatch.writesUnion)) {
      throw this.taggedConflict(this.flushingBatch.promoted);
    }
    if (this.pendingBatch && ctx.validatedReads.intersects(this.pendingBatch.writesUnion)) {
      throw this.taggedConflict(this.pendingBatch.promoted);
    }

    // Phase 2 — BATCH-CUT: a blind write to a doc already written by an in-flight (flushing OR
    // pending) unit cannot chain a correct prev_ts — `docStore.get` would read a revision BELOW the
    // about-to-land one, forking the chain (→ replica density halt → tailer halt). Hold this unit to
    // the NEXT batch: await that batch's promotion, then the caller re-enters the whole stage step.
    // (An RMW on such a doc would already have aborted in phase 1; only blind writes reach here.)
    const docKeys: string[] = [];
    for (const w of ctx.staged.entries()) {
      const key = documentIdKey(w.id);
      docKeys.push(key);
      if (this.flushingBatch?.writtenDocKeys.has(key)) return { kind: "cut", wait: this.flushingBatch.promoted };
      if (this.pendingBatch?.writtenDocKeys.has(key)) return { kind: "cut", wait: this.pendingBatch.promoted };
    }

    // Phase 3 — resolve prev_ts from the latest COMMITTED revision. The cut in phase 2 guarantees no
    // in-flight unit touches these docs, so `docStore.get` reads a committed revision; it stays
    // race-free under the mutex, and a flush landing OTHER docs' rows between here and now only makes
    // the get see newer committed state for OUR (disjoint) docs — never a fork.
    const documents: DocumentLogEntry[] = [];
    for (const w of ctx.staged.entries()) {
      const prev = await this.docStore.get(w.id);
      documents.push({
        ts: 0n,
        id: w.id,
        prev_ts: prev ? prev.ts : null,
        value: w.value === null ? null : { id: w.id, value: w.value },
      });
    }
    const indexUpdates: IndexWrite[] = ctx.indexUpdates.map((update) => ({ ts: 0n, update }));

    // Append the unit + its resolver to the pending batch (creating a fresh one if just detached).
    if (!this.pendingBatch) this.pendingBatch = newBatch();
    const batch = this.pendingBatch;
    let resolve!: (result: CommitResult<T>) => void;
    let reject!: (error: unknown) => void;
    const completion = new Promise<CommitResult<T>>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    batch.units.push({
      documents,
      indexUpdates,
      meta: commitMeta,
      writeRanges: ctx.writeRanges,
      shardId,
      value,
      resolve: resolve as (result: CommitResult<unknown>) => void,
      reject,
    });
    for (const key of docKeys) batch.writtenDocKeys.add(key);
    for (const range of ctx.writeRanges.toArray()) batch.writesUnion.add(range);
    this.ensureCommitter();
    return { kind: "staged", completion };
  }

  private taggedConflict(wait: Promise<void>): TaggedConflict {
    const err = new OccConflictError(
      "transaction read data that was changed before it committed",
    ) as TaggedConflict;
    err[CONFLICT_WAIT] = wait;
    return err;
  }

  /** Start the lazy committer loop if it isn't already running. MUST be called under the mutex, so the
   *  `committerRunning` write is serialized with the loop's own detach-time reset (see `runCommitter`)
   *  — that atomicity is what prevents a "queue non-empty but no committer" wedge. */
  private ensureCommitter(): void {
    if (this.committerRunning) return;
    this.committerRunning = true;
    void this.runCommitter();
  }

  /**
   * The single per-shard committer loop (D2). Each iteration: detach the ENTIRE pending batch as the
   * new flushing batch (under the mutex), `commitWriteBatch` it OFF the mutex (the amortized I/O),
   * then under the mutex publish each unit IN ORDER (ring push → oracle → oplog → fan-out → resolve)
   * and clear the flushing slot. Loops while pending is non-empty; when it is empty it resets
   * `committerRunning` UNDER THE MUTEX and exits, so the next stager restarts it. A flush error
   * rejects every unit of the batch and discards it — the ring/oracle never see the failed ts's and
   * the loop survives to flush whatever came next (a poisoned unit cannot wedge the shard).
   */
  private async runCommitter(): Promise<void> {
    for (;;) {
      const batch = await this.mutex.runExclusive(async (): Promise<Batch | null> => {
        if (!this.pendingBatch || this.pendingBatch.units.length === 0) {
          // Reset the flag ATOMICALLY with the empty check: any stager appends + calls
          // `ensureCommitter` under this same mutex, so it either runs before us (we then detach its
          // unit, never resetting) or after us (it sees the flag cleared and restarts the loop).
          this.committerRunning = false;
          return null;
        }
        const b = this.pendingBatch;
        this.pendingBatch = null; // a fresh pending batch is created by the next stager
        this.flushingBatch = b;
        this.lastBatchSize = b.units.length;
        if (b.units.length > this.maxBatchSize) this.maxBatchSize = b.units.length;
        this.flushCount++;
        return b;
      });
      if (!batch) return;

      let tss: bigint[] | null = null;
      let flushErr: unknown = null;
      try {
        tss = await this.docStore.commitWriteBatch(
          batch.units.map((u) => ({ documents: u.documents, indexUpdates: u.indexUpdates, meta: u.meta })),
          this.shardId,
        );
      } catch (e) {
        flushErr = e;
      }

      await this.mutex.runExclusive(async () => {
        if (flushErr !== null || tss === null) {
          // Failure contract: reject EVERY unit verbatim; the whole batch is discarded; the ring and
          // oracle are never touched (the store guarantees no unit landed). The loop then re-enters
          // below and flushes whatever accumulated meanwhile, or resets the flag and exits.
          for (const u of batch.units) u.reject(flushErr);
        } else {
          for (let i = 0; i < batch.units.length; i++) {
            const u = batch.units[i]!;
            const ts = tss[i]!;
            this.recentCommits.push({ ts, writes: u.writeRanges });
            // Advance the committed clock only now that this unit's rows are applied + ring-recorded,
            // strictly in unit order, so a concurrent snapshot never observes it before it is safe.
            this.oracle.publishCommitted(ts);
            const ranges = u.writeRanges.toArray();
            const oplog: OplogDelta = {
              commitTs: ts,
              shardId: u.shardId,
              writtenRanges: ranges.map(serializeKeyRange),
              writtenTables: writtenTablesFromRanges(ranges),
            };
            if (this.fanout) {
              try {
                void this.fanout.publish(oplog);
              } catch {
                /* a fan-out failure must not fail the commit */
              }
            }
            u.resolve({ value: u.value, committed: true, commitTs: ts, shardId: u.shardId, oplog });
          }
          this.prune(); // once per flush
        }
        this.flushingBatch = null;
        // Wake batch-cut / tagged-conflict awaiters: the batch has left the in-flight state (whether
        // it landed in the ring or failed), so a re-stage/replay now reads committed state correctly.
        batch.resolvePromoted();
      });
    }
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
