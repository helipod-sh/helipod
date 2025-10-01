/**
 * `SingleWriterTransactor` — the heart of the write path, restricted to exactly one shard.
 *
 * As of shards B2a (D1) this is a thin `Transactor` wrapper around a single `ShardWriter`
 * (`./shard-writer.ts`) — the same class `ShardedTransactor` instantiates once per shard. All
 * commit/OCC/snapshot machinery now lives there; see its header for the 3-phase pipeline and
 * the two-read-set split. This class exists so single-shard callers (Tier-0 embedded runtime,
 * most tests) keep a construction shape independent of sharding, and so the existing suite's
 * behavior is provably unchanged (a default-shard-only `ShardedTransactor` is byte-identical —
 * see `sharded-transactor.test.ts`).
 */
import { DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import type { DocStore, TimestampOracle } from "@stackbase/docstore";
import { DEFAULT_HEADROOM, type HeadroomLimits } from "./headroom";
import { ShardWriter, type RecentCommit } from "./shard-writer";
import type { CommitResult, RunInTransactionOptions, TransactionContext, Transactor, WriteFanout } from "./types";

export interface SingleWriterTransactorOptions {
  shardId?: ShardId;
  fanout?: WriteFanout;
  defaultHeadroom?: HeadroomLimits;
}

export class SingleWriterTransactor implements Transactor {
  private readonly writer: ShardWriter;

  constructor(docStore: DocStore, oracle: TimestampOracle, options: SingleWriterTransactorOptions = {}) {
    this.writer = new ShardWriter(
      docStore,
      oracle,
      options.shardId ?? DEFAULT_SHARD,
      options.fanout,
      options.defaultHeadroom ?? DEFAULT_HEADROOM,
    );
  }

  runInTransaction<T>(
    fn: (ctx: TransactionContext) => Promise<T>,
    options: RunInTransactionOptions = {},
  ): Promise<CommitResult<T>> {
    return this.writer.runInTransaction(fn, options);
  }

  /**
   * Test/back-compat accessor: the existing suite reaches into the recent-commits ring
   * directly (private-field peek) to assert the store-allocated commit ts lands there. Now
   * delegates to the extracted `ShardWriter` (D1) — same array, same semantics, just no
   * longer owned directly by this class.
   */
  private get recentCommits(): readonly RecentCommit[] {
    return this.writer.recentCommits;
  }
}
