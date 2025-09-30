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
 * way (see `sharded-transactor.test.ts`'s byte-identity test).
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
    return writer.runInTransaction(fn, { ...options, shardId });
  }

  /**
   * Fans a learned timestamp ("the log reached ts") to every shard oracle CREATED so far, and
   * records it as the transactor-wide `observedHighWater` floor. A shard not yet touched still
   * needs this recorded: on a fleet follower, `ts` can be AHEAD of what this node's own
   * `docStore.maxTimestamp()` would report (the local read replica hasn't caught up yet), so
   * `createShard` seeds every new writer's oracle from `max(docStore.maxTimestamp(),
   * observedHighWater)` rather than trusting the local store max alone.
   */
  observeTimestamp(ts: bigint): void {
    if (ts > this.observedHighWater) this.observedHighWater = ts;
    for (const writer of this.shards.values()) writer.oracle.observeTimestamp(ts);
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
    );
    this.shards.set(shardId, writer);
    return writer;
  }
}
