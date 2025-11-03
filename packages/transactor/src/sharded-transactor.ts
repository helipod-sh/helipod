/**
 * `ShardedTransactor` — N independent `ShardWriter`s (`./shard-writer.ts`, D1) behind ONE
 * `Transactor`. Each shard gets its own mutex + recent-commits ring + active-snapshot
 * refcounts + timestamp oracle, created lazily on first use, so cross-shard commits are
 * independent promises that CAN genuinely interleave at the transactor level (two shards'
 * `runInTransaction` calls never contend on each other's mutex). This package proves
 * transactor-level concurrency only — store-level concurrency needs a connection pool at the
 * `DocStore` (e.g. Postgres, per the design spec's D1 commit-connection-pool note); SQLite
 * naturally serializes storage writes even when two shards' `commit()` calls interleave
 * in-process, which is fine and expected for the Tier-0 embedded runtime this package also
 * serves — see the concurrency test's header for the exact claim being proven.
 *
 * `runInTransaction(fn, { shardId })` routes to that shard's `ShardWriter` (undeclared →
 * `DEFAULT_SHARD`, matching `SingleWriterTransactor`'s longstanding default). A
 * default-shard-only caller is byte-identical to `SingleWriterTransactor` — same ring, same
 * mutex, same commit sequence — because both ultimately construct one `ShardWriter` the same
 * way (see `sharded-transactor.test.ts`'s byte-identity test). Every call also fans its result's
 * ts to every OTHER shard oracle (`observeTimestamp`, below) — a QUERY is never routed (D2), so
 * it always reads through `"default"`'s own oracle; without this fan-out that oracle would only
 * ever learn about `"default"`'s OWN commits, and could sit stale behind every other shard's
 * writes indefinitely (Shards B2a follow-up, D3's "queries read everything" contract).
 *
 * Each shard's oracle seeds LAZILY, on that shard's first use, from
 * `max(docStore.maxTimestamp(), observedHighWater)` — the GLOBAL max across ALL shards'
 * committed log entries (there is no per-shard max: the log is one table), floored by the
 * highest timestamp this transactor has ever learned via `observeTimestamp` (D1/T4 fleet
 * seam). This is correct, not merely convenient: `DocStore.commitWrite`'s `GREATEST(nextval,
 * MAX+1)` allocation is the structural monotonicity guarantee regardless of which shard
 * commits — the oracle is snapshot bookkeeping only. A freshly-created shard's `recentCommits`
 * ring starts empty, so seeding its oracle from the global max cannot manufacture a spurious
 * OCC conflict: there is nothing in that shard's ring yet to conflict with, and the ring only
 * ever holds THIS shard's own past commits (D1). The `observedHighWater` floor matters on a
 * fleet follower: `observeTimestamp` can carry a ts learned from the change stream that is
 * AHEAD of what this node's own `docStore.maxTimestamp()` would report (the local read replica
 * hasn't caught up yet) — a shard created after that observation must not seed behind it.
 */
import { DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import type { DocStore } from "@stackbase/docstore";
import { DEFAULT_HEADROOM, type HeadroomLimits } from "./headroom";
import { ShardWriter } from "./shard-writer";
import type { CommitResult, RunInTransactionOptions, TransactionContext, Transactor, WriteFanout } from "./types";

export interface ShardedTransactorOptions {
  headroom?: HeadroomLimits;
  fanout?: WriteFanout;
  /**
   * Seed EVERY shard's oracle from this fixed timestamp instead of `docStore.maxTimestamp()`.
   * Test/bootstrap seam only — production callers should leave this unset so each shard
   * correctly recovers its high-water mark from persisted data on first use.
   */
  seedTs?: bigint;
  /**
   * Fleet B4 (group commit): route EVERY shard's commits through the two-buffer stage-then-flush
   * committer loop. Default false = the byte-identical single-commit path on every shard. The
   * runtime threads this from `STACKBASE_GROUP_COMMIT` (T4); leaving it unset keeps a non-fleet /
   * flag-off deployment structurally on today's path.
   */
  groupCommit?: boolean;
}

export class ShardedTransactor implements Transactor {
  private readonly shards = new Map<ShardId, ShardWriter>();
  /** In-flight shard creation, keyed by shard id — collapses concurrent first-uses of the
   *  same never-seen shard onto ONE `ShardWriter` (else two racing callers could each await
   *  `docStore.maxTimestamp()` and construct two independent writers for the same shard,
   *  splitting its single-writer invariant in two). */
  private readonly creating = new Map<ShardId, Promise<ShardWriter>>();
  /** Highest timestamp ever observed via `observeTimestamp`, across ALL shards (existing or
   *  not-yet-created) — the floor a newly-created shard's oracle must seed at-or-past (see the
   *  module doc above). */
  private observedHighWater = 0n;

  constructor(
    private readonly docStore: DocStore,
    private readonly options: ShardedTransactorOptions = {},
  ) {}

  async runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    const shardId = options.shardId ?? DEFAULT_SHARD;
    const writer = await this.getOrCreateShard(shardId);
    // Normalize shardId in the options handed to the writer so its own `options.shardId ??
    // <its configured id>` default can never disagree with which writer we routed to.
    const result = await writer.runInTransaction(fn, { ...options, shardId });
    // Cross-shard read consistency (Shards B2a follow-up — found by T5's dev-tier proof, the
    // first place a real NUM_SHARDS>1 + cross-shard write + query readback ran end to end): a
    // QUERY is NEVER routed (D2) — it always runs on `"default"`, using THAT shard's own oracle
    // for its snapshot. Without this fan-out, `"default"`'s oracle only ever advances via ITS
    // OWN commits, so a query could sit forever behind every OTHER shard's writes (e.g. a boot
    // step that touches `"default"` before any sharded write seeds it at ts 0) — silently
    // violating D3's "queries read everything, unaffected by sharding" contract.
    //
    // For a COMMITTED transaction, the `onCommitted` hook (wired in `createShard`) has ALREADY fanned
    // `commitTs` to every shard oracle synchronously, BEFORE the writer's `fanout.publish` — that is
    // the D12 ordering fix and the reason this call is no longer where cross-shard freshness is
    // established. This post-resolve fan-out is retained because it still MATTERS for PURE READS
    // (`committed: false` never reaches `commit()`/`onCommitted`, yet `result.commitTs` = that shard's
    // snapshotTs, which the shared query oracle should still catch up to). For a committed txn it is a
    // harmless monotonic no-op (the oracles are already >= commitTs), and it is never the drain-critical
    // advance — that is now the hook's, ordered ahead of publish.
    this.observeTimestamp(result.commitTs);
    return result;
  }

  /**
   * Fans a learned timestamp ("the log reached ts") to every shard oracle CREATED so far, and
   * records it as the transactor-wide `observedHighWater` floor. A shard not yet touched still
   * needs this recorded: on a fleet follower, `ts` can be AHEAD of what this node's own
   * `docStore.maxTimestamp()` would report (the local read replica hasn't caught up yet), so
   * `createShard` seeds every new writer's oracle from `max(docStore.maxTimestamp(),
   * observedHighWater)` rather than trusting the local store max alone.
   *
   * Also called automatically after EVERY `runInTransaction` (see above) — not just externally
   * by the fleet-follower seam — so every shard's oracle stays roughly caught up with the
   * transactor-wide high-water mark, keeping cross-shard query reads correct at every tier.
   */
  observeTimestamp(ts: bigint): void {
    if (ts > this.observedHighWater) this.observedHighWater = ts;
    for (const writer of this.shards.values()) writer.oracle.observeTimestamp(ts);
  }

  /**
   * Run `fn` under shard `shardId`'s writer mutex IFF that mutex is free right now — the SAME mutex
   * every commit on that shard holds (`ShardWriter.runInTransaction` → `mutex.runExclusive`). Returns
   * `true` if `fn` ran (we held exclusion against that shard's commits), `false` if a commit already
   * holds the mutex, in which case `fn` is NOT run and the caller should retry later.
   *
   * The fleet idle-frontier closer (`closeIdleFrontiers`) uses this to bump a held-but-idle shard's
   * frontier atomically with respect to that shard's own commits. A shard is "idle" — and this returns
   * `true` — only if BOTH (a) the commit mutex is free AND (b) the writer has no staged/flushing
   * group-commit batch (`hasInFlightWork()`). Both conditions matter:
   *   - (a) An in-flight single-commit holds the mutex for its whole validate→allocate→apply section,
   *     so a mutex-busy shard is skipped (left for the next beat) rather than raced.
   *   - (b) Group commit (Fleet B4) runs the flush I/O OFF the mutex, so a batch can be mid-flush —
   *     ts's already drawn at detach, rows not yet landed — while the mutex reads FREE. Skipping on
   *     `hasInFlightWork()` too closes the frontier-inversion hole that mutex-freedom alone reopened:
   *     otherwise the closer could draw a LATER `nextval` and publish a frontier above those
   *     not-yet-landed ts's (silent replica miss / density halt).
   * A commit (or batch) that STARTS after this check passes draws its ts at commit/flush time, AFTER
   * the closer's `nextval` — so `GREATEST` keeps `frontier_ts` monotone and nothing in-flight ever
   * sits below the closed frontier. The shard's `ShardWriter` is created on demand if it doesn't exist
   * yet, so the mutex the closer takes is the very one a first-ever commit on that shard would take
   * (no create-vs-close race). The `hasInFlightWork()` read and the `tryRunExclusive` mutex probe run
   * with no `await` between them, so the two-part idle decision is one synchronous step.
   */
  async tryRunExclusiveOnShard(shardId: ShardId, fn: () => Promise<void>): Promise<boolean> {
    const writer = await this.getOrCreateShard(shardId);
    if (writer.hasInFlightWork()) return false;
    return writer.mutex.tryRunExclusive(fn);
  }

  private async getOrCreateShard(shardId: ShardId): Promise<ShardWriter> {
    const existing = this.shards.get(shardId);
    if (existing) return existing;
    let pending = this.creating.get(shardId);
    if (!pending) {
      pending = this.createShard(shardId);
      // On rejection (e.g. a transient `docStore.maxTimestamp()` throw), clear the cached
      // promise so the shard isn't permanently poisoned — the next caller retries creation.
      // In-flight callers already awaiting `pending` still observe the original rejection.
      pending.catch(() => {
        if (this.creating.get(shardId) === pending) this.creating.delete(shardId);
      });
      this.creating.set(shardId, pending);
    }
    return pending;
  }

  private async createShard(shardId: ShardId): Promise<ShardWriter> {
    const storeSeed = this.options.seedTs ?? (await this.docStore.maxTimestamp());
    const seedTs = storeSeed > this.observedHighWater ? storeSeed : this.observedHighWater;
    const oracle = new MonotonicTimestampOracle(seedTs);
    const writer = new ShardWriter(
      this.docStore,
      oracle,
      shardId,
      this.options.fanout,
      this.options.headroom ?? DEFAULT_HEADROOM,
      this.options.groupCommit ?? false,
      // D12 origin-frontier ordering hook: the writer invokes this synchronously with each commit's
      // ts AFTER its own oracle.publishCommitted but BEFORE fanout.publish makes the commit observable
      // to the drain. Fanning `ts` to EVERY shard oracle (+ observedHighWater) here — not post-resolve
      // as `runInTransaction` used to be the only place — is what upholds the invariant: by the time
      // any consumer sees this commit's fan-out payload, every shard oracle (including the shared,
      // never-routed "default" query oracle) has lastCommitted >= ts, so a triggered query re-run
      // reads a snapshot that includes the very commit that woke it. Without this, the confirming
      // cross-shard Transition carried a stale (write-absent) QueryUpdated and — absent foreign
      // traffic — stayed stale forever (the reactivity bug latent since B2a; D12).
      (ts) => this.observeTimestamp(ts),
    );
    this.shards.set(shardId, writer);
    return writer;
  }

  /**
   * Aggregate group-commit counters (Fleet B4, D4 — health) across all live shards: `maxBatchSize`
   * is the max over shards (the headline "batching engaged" signal), `flushCount` the sum, and
   * `lastBatchSize` the max of each shard's most-recent batch (a coarse "batches forming right now"
   * read). All zero when group commit is off or has never flushed. T4 reads these for the health
   * endpoint's `groupCommit` section and the benchmark's engagement check.
   */
  groupCommitStats(): { lastBatchSize: number; maxBatchSize: number; flushCount: number } {
    let lastBatchSize = 0;
    let maxBatchSize = 0;
    let flushCount = 0;
    for (const writer of this.shards.values()) {
      lastBatchSize = Math.max(lastBatchSize, writer.lastBatchSize);
      maxBatchSize = Math.max(maxBatchSize, writer.maxBatchSize);
      flushCount += writer.flushCount;
    }
    return { lastBatchSize, maxBatchSize, flushCount };
  }
}
