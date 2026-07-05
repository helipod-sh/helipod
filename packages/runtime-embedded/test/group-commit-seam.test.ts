/**
 * Fleet B4, Task 4 — `EmbeddedRuntimeOptions.groupCommit` threading. Proves the option actually
 * reaches the transactor construction (both the single-shard and sharded branches), not just that
 * it type-checks: off stays byte-identical (all-zero counters), on flushes and — under genuinely
 * concurrent load — batches multiple mutations into one flush. `runtime.groupCommitStats()` is the
 * same aggregate the fleet health seam (`@helipod/fleet`'s `node.ts`) reads for `/api/health`.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import type { CommitUnit } from "@helipod/docstore";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { SimpleIndexCatalog, mutation, type RegisteredFunction } from "@helipod/executor";
import type { IndexSpec } from "@helipod/query-engine";
import { createEmbeddedRuntime } from "../src/index";

const NOTES = 10001;
const byTitle: IndexSpec = {
  table: "notes",
  tableNumber: NOTES,
  index: "by_title",
  fields: ["title"],
  indexId: encodeStorageIndexId(NOTES, "by_title"),
};

const modules: Record<string, RegisteredFunction> = {
  "notes:add": mutation<{ title: string }, string>({
    handler: (ctx, { title }) => ctx.db.insert("notes", { title }),
  }),
};

/** Same gated-store trick `packages/transactor/test/group-commit.test.ts` uses: holds one flush "in
 *  flight" so concurrently-issued mutations accumulate into the NEXT batch — the only way to make
 *  batching deterministic in a test (SQLite's real flush is synchronous). */
class HookedSqliteStore extends SqliteDocStore {
  beforeCommitBatch?: (callIndex: number) => Promise<void>;
  private callIndex = 0;
  readonly batchSizes: number[] = [];

  override async commitWriteBatch(units: readonly CommitUnit[], shardId?: import("@helipod/id-codec").ShardId): Promise<bigint[]> {
    const idx = this.callIndex++;
    if (this.beforeCommitBatch) await this.beforeCommitBatch(idx);
    this.batchSizes.push(units.length);
    return super.commitWriteBatch(units, shardId);
  }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("EmbeddedRuntimeOptions.groupCommit — threading into the transactor", () => {
  it("unset: groupCommitStats stays all-zero after a committing mutation (byte-identical single-commit path)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byTitle);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules });
    await runtime.run("notes:add", { title: "a" });
    expect(runtime.groupCommitStats()).toEqual({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0 });
  });

  it("groupCommit: true (single-shard) — a sequential mutation flushes and the counters reflect it", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byTitle);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules, groupCommit: true });
    await runtime.run("notes:add", { title: "a" });
    const stats = runtime.groupCommitStats();
    expect(stats.flushCount).toBe(1);
    expect(stats.lastBatchSize).toBe(1);
    expect(stats.maxBatchSize).toBe(1);
  });

  it("groupCommit: true (numShards > 1) — threads into the ShardedTransactor branch too", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byTitle);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules, groupCommit: true, numShards: 4 });
    await runtime.run("notes:add", { title: "a" });
    const stats = runtime.groupCommitStats();
    expect(stats.flushCount).toBe(1);
    expect(stats.lastBatchSize).toBe(1);
  });

  it("groupCommit: true under concurrent load — multiple mutations batch into one flush (genuine engagement, not just a flag no-op)", async () => {
    const store = new HookedSqliteStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byTitle);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules, groupCommit: true });

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await held; // hold ONLY the first flush
    };

    const first = runtime.run("notes:add", { title: "first" });
    await delay(20); // first mutation staged; its 1-unit batch is now in flight, gated
    const rest = Array.from({ length: 4 }, (_, k) => runtime.run("notes:add", { title: `n${k}` }));
    await delay(20); // the other 4 accumulate into the pending batch while flush #1 is gated
    release();
    await Promise.all([first, ...rest]);

    expect(store.batchSizes).toEqual([1, 4]);
    const stats = runtime.groupCommitStats();
    expect(stats.flushCount).toBe(2);
    expect(stats.maxBatchSize).toBe(4);
    expect(stats.lastBatchSize).toBe(4);
  });
});
