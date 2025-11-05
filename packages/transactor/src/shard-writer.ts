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
import { CommitGuardRejection, OccConflictError } from "@stackbase/errors";
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
  /** G4 origin-frontier tag — the originating session id, stamped per-unit onto this unit's
   *  `OplogDelta.origin` at publish time. NEVER folded into `meta` (which reaches the store). */
  readonly origin?: string;
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

/** Split-retry bound (Receipted Outbox, decision 2): how many times the committer will split a
 *  guard-rejected unit out and re-flush the remainder before it gives up and rejects the surviving
 *  chunk retryably. A pathological guard that rejects a different unit on every flush must not let the
 *  committer re-flush unboundedly. */
const MAX_SPLIT_RETRIES = 3;

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
    /**
     * D12 origin-frontier ordering hook — invoked SYNCHRONOUSLY with a commit's ts AFTER this
     * shard's own `oracle.publishCommitted(ts)` but BEFORE `fanout.publish(oplog)` makes the commit
     * observable to the drain. `ShardedTransactor` wires it to fan `ts` to EVERY shard oracle (+ its
     * `observedHighWater` floor), so the transactor-wide "every shard oracle lastCommitted >= ts
     * before any consumer can observe this commit" invariant holds (see the call site in `commit()`
     * and `runCommitter()`). `SingleWriterTransactor` leaves it unset: a single oracle is already
     * advanced by the `publishCommitted` above, so its `publishCommitted`-precedes-`publish` ordering
     * needs nothing extra. Must not `await` — the ordering guarantee is that no microtask turn
     * separates the fan-out from the publish.
     */
    private readonly onCommitted: ((ts: bigint) => void) | undefined = undefined,
  ) {}

  runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    return this.groupCommit
      ? this.runInTransactionGrouped(fn, options)
      : this.runInTransactionSingle(fn, options);
  }

  /**
   * True iff this shard has a group-commit batch that is staged-but-unflushed OR mid-flush right now
   * (Fleet B4 frontier-inversion fix). ALWAYS false in single-commit mode — there is no batch state,
   * and the commit mutex alone already covers the whole commit, so the mutex-free check at
   * `tryRunExclusiveOnShard` is sufficient there.
   *
   * Why this exists: group commit runs the flush I/O (`commitWriteBatch`) OFF the mutex, between the
   * detach and the publish. During that window the mutex is FREE, yet the batch drew its ts's at
   * detach time and its rows are not yet landed — a `tryRunExclusiveOnShard` decision made on mutex
   * freedom alone would let the idle-frontier closer draw a LATER `nextval` and publish a frontier
   * ABOVE those in-flight ts's, so a tailer pulls an empty range and advances its watermark past
   * rows that land afterward (silent replica miss / density halt). A busy writer must therefore read
   * as UNAVAILABLE even when the mutex is free. Read on the writer-owning node only, no `await` before
   * the caller's mutex probe, so the pair is a single synchronous decision.
   */
  hasInFlightWork(): boolean {
    return this.flushingBatch !== null || (this.pendingBatch !== null && this.pendingBatch.units.length > 0);
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

        return await this.mutex.runExclusive(() => this.commit(ctx, snapshotTs, shardId, value, options.commitMeta, options.origin));
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
    origin?: string,
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
    // D12 INVARIANT: by the time this commit's fan-out payload is observable to ANY consumer, every
    // shard oracle in this transactor has lastCommitted >= commitTs — so any query re-run the payload
    // triggers reads a snapshot that includes this commit. The cross-oracle fan-out MUST complete here,
    // synchronously, BEFORE `fanout.publish` below schedules the drain: on the shared query shard
    // (`"default"`, never routed) a re-run otherwise reads a snapshot lagging THIS commit, so the
    // confirming Transition carries endVersion.ts=commitTs with a stale (write-absent) QueryUpdated —
    // and with no foreign traffic there is no later notify, so it stays stale (the cross-shard
    // reactivity bug latent since B2a). `SingleWriterTransactor` leaves `onCommitted` unset — its one
    // oracle was already advanced by `publishCommitted` above.
    this.onCommitted?.(commitTs);
    this.prune();

    const ranges = ctx.writeRanges.toArray();
    // G4: stamp the origin tag HERE, at oplog construction, AFTER `commitWrite` has returned — it
    // never reached the store (see `commitWrite` above, called with `{ meta: commitMeta }` only).
    const oplog: OplogDelta = {
      commitTs,
      shardId,
      writtenRanges: ranges.map(serializeKeyRange),
      writtenTables: writtenTablesFromRanges(ranges),
      origin,
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
            this.stageUnit(ctx, snapshotTs, shardId, value, options.commitMeta, options.origin),
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
    origin: string | undefined,
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
      origin,
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
   * new flushing batch (under the mutex), flush it OFF the mutex (the amortized I/O), then under the
   * mutex publish each landed unit IN ORDER (ring push → oracle → oplog → fan-out → resolve) and
   * clear the flushing slot. Loops while pending is non-empty; when it is empty it resets
   * `committerRunning` UNDER THE MUTEX and exits, so the next stager restarts it.
   *
   * Split-retry on a typed guard rejection (Receipted Outbox, decision 2 — the batch-collateral fix).
   * A commit guard (fleet idempotency / client-mutation receipts) can reject ONE unit of a batch
   * with a {@link CommitGuardRejection} carrying that unit's index; the store rolls the WHOLE txn
   * back, so nothing landed. Pre-fix, that threw out of the flush and rejected EVERY co-batched unit
   * as collateral. Now `flushWithSplit` catches it, rejects ONLY the offending unit with its code,
   * and re-flushes the remainder (fresh ts — the rolled-back txn allocated nothing durable), bounded
   * at {@link MAX_SPLIT_RETRIES} so a pathological always-rejecting guard can't re-flush forever;
   * past the bound the remaining chunk rejects retryably. Any OTHER flush error (incl. `FencedError`)
   * stays whole-batch — every unit rejects, never split. The ring/oracle never see a failed unit's
   * ts, and the loop survives to flush whatever came next (a poisoned unit cannot wedge the shard).
   * Publish order is strict unit order across splits (the surviving units keep their relative order).
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

      // Flush OFF the mutex, splitting out per-unit guard rejections. Produces the units that landed
      // (each with its fresh ts, in unit order), the units a guard rejected (each with its coded
      // error), and — if the whole remainder failed — the surviving chunk plus its error.
      const outcome = await this.flushWithSplit(batch.units);

      await this.mutex.runExclusive(async () => {
        // Publish the landed units strictly in unit order (ring → oracle → cross-oracle fan → oplog
        // → fan-out → resolve). A split only ever drops units from the middle; the survivors keep
        // their relative order, so this stays strict-unit-order across splits.
        for (const { unit: u, ts } of outcome.landed) {
          this.recentCommits.push({ ts, writes: u.writeRanges });
          // Advance the committed clock only now that this unit's rows are applied + ring-recorded,
          // strictly in unit order, so a concurrent snapshot never observes it before it is safe.
          this.oracle.publishCommitted(ts);
          // D12 invariant, PER UNIT: fan THIS unit's ts to every shard oracle BEFORE publishing its
          // oplog below — the same "every shard oracle >= commitTs before observable" ordering the
          // single-commit path enforces in `commit()`. Synchronous, no await before the publish.
          this.onCommitted?.(ts);
          const ranges = u.writeRanges.toArray();
          const oplog: OplogDelta = {
            commitTs: ts,
            shardId: u.shardId,
            writtenRanges: ranges.map(serializeKeyRange),
            writtenTables: writtenTablesFromRanges(ranges),
            origin: u.origin, // G4: per-unit origin — stamped at publish, never sent to the store
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
        if (outcome.landed.length > 0) this.prune(); // once per flush cycle, only if anything landed

        // Reject the guard-split units with their OWN coded rejection, then the failed remaining chunk
        // (a non-guard error, or the split-budget-exhausted retryable remainder) verbatim. None of
        // these touched the ring/oracle — the store guarantees no rejected unit landed.
        for (const { unit: u, error } of outcome.guardRejected) u.reject(error);
        for (const u of outcome.chunkUnits) u.reject(outcome.chunkErr);

        this.flushingBatch = null;
        // Wake batch-cut / tagged-conflict awaiters: the batch has left the in-flight state (whether
        // it landed in the ring or failed), so a re-stage/replay now reads committed state correctly.
        batch.resolvePromoted();
      });
    }
  }

  /**
   * Flush a batch's units OFF the mutex, splitting out per-unit {@link CommitGuardRejection}s. On a
   * rejection the store rolled the whole txn back (nothing landed), so the surviving units are safe
   * to re-flush with fresh ts. Bounded at {@link MAX_SPLIT_RETRIES}; any non-guard error (incl.
   * `FencedError`) or an out-of-range index fails the whole remaining chunk (never split).
   */
  private async flushWithSplit(units: readonly StagedUnit[]): Promise<{
    landed: { unit: StagedUnit; ts: bigint }[];
    guardRejected: { unit: StagedUnit; error: CommitGuardRejection }[];
    chunkUnits: StagedUnit[];
    chunkErr: unknown;
  }> {
    let remaining = units.slice(); // preserves unit order across splices
    const landed: { unit: StagedUnit; ts: bigint }[] = [];
    const guardRejected: { unit: StagedUnit; error: CommitGuardRejection }[] = [];
    let splits = 0;

    for (;;) {
      let tss: bigint[] | null = null;
      let err: unknown = null;
      try {
        tss = await this.docStore.commitWriteBatch(
          remaining.map((u) => ({ documents: u.documents, indexUpdates: u.indexUpdates, meta: u.meta })),
          this.shardId,
        );
      } catch (e) {
        err = e;
      }
      if (tss !== null) {
        for (let i = 0; i < remaining.length; i++) landed.push({ unit: remaining[i]!, ts: tss[i]! });
        return { landed, guardRejected, chunkUnits: [], chunkErr: null };
      }
      if (
        err instanceof CommitGuardRejection &&
        err.unitIndex >= 0 &&
        err.unitIndex < remaining.length &&
        splits < MAX_SPLIT_RETRIES
      ) {
        const [rejected] = remaining.splice(err.unitIndex, 1); // drop the ONE offending unit
        guardRejected.push({ unit: rejected!, error: err });
        splits++;
        if (remaining.length === 0) return { landed, guardRejected, chunkUnits: [], chunkErr: null };
        continue; // re-flush the remainder with fresh ts
      }
      // Whole-batch failure: a non-guard error (FencedError, flush I/O), an out-of-range guard index,
      // or the split budget is spent — reject the surviving chunk retryably/verbatim, never split.
      return { landed, guardRejected, chunkUnits: remaining, chunkErr: err };
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
