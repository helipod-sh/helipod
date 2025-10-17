/**
 * Fleet B4, D2 — the per-shard group-commit committer loop. These exercise the two-buffer
 * stage-then-flush pipeline behind `groupCommit: true`: natural batching, the two corruption
 * regressions the two-buffer visibility rule exists to prevent (a lost update on a validation that
 * misses the flushing batch; a forked chain on a blind write that misses it), publish ordering, the
 * failure contract, retry-awaits-the-conflicting-batch, and flag-off byte-identity.
 *
 * `HookedSqliteStore` injects controllable latency/failure into `commitWriteBatch` so a flush can be
 * held "in flight" while more units stage — the only way to make batching deterministic in a test
 * (SQLite's real flush is synchronous, so nothing would otherwise accumulate; the batching machinery
 * is store-agnostic and this proves it, the throughput win itself is a Postgres/E2E concern — T5).
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import type { CommitUnit } from "@stackbase/docstore";
import {
  newDocumentId,
  documentIdKey,
  DEFAULT_SHARD,
  type ShardId,
  type InternalDocumentId,
} from "@stackbase/id-codec";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import {
  ShardedTransactor,
  SingleWriterTransactor,
  ShardWriter,
  DEFAULT_HEADROOM,
  type OplogDelta,
} from "../src/index";

const TABLE = 20001;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A `SqliteDocStore` whose `commitWriteBatch` can be gated/failed per call and records each flush's
 *  unit count — the test's lever for holding one flush "in flight" while others accumulate. */
class HookedSqliteStore extends SqliteDocStore {
  /** Runs before each `commitWriteBatch`'s real work; throw to fail the flush, await to hold it. */
  beforeCommitBatch?: (callIndex: number) => Promise<void>;
  private callIndex = 0;
  /** Unit count of every `commitWriteBatch` (the flush sizes, in flush order). */
  readonly batchSizes: number[] = [];

  override async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    const idx = this.callIndex++;
    if (this.beforeCommitBatch) await this.beforeCommitBatch(idx);
    this.batchSizes.push(units.length);
    return super.commitWriteBatch(units, shardId);
  }
}

async function makeGroup() {
  const store = new HookedSqliteStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const deltas: OplogDelta[] = [];
  const transactor = new ShardedTransactor(store, {
    groupCommit: true,
    fanout: { publish: (d) => void deltas.push(d) },
  });
  return { store, transactor, deltas };
}

/** A gate whose flush blocks until `release()` is called. `n` counts flushes seen. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

async function countRevisions(store: SqliteDocStore, id: InternalDocumentId) {
  const key = documentIdKey(id);
  const revs = [];
  for await (const e of store.load_documents({ minInclusive: 0n, maxExclusive: 1n << 62n }, "asc")) {
    if (documentIdKey(e.id) === key) revs.push(e);
  }
  return revs;
}

describe("group commit — natural batching", () => {
  it("holds a slow first flush while 9 more stage → exactly 2 flushes: 1 then 9", async () => {
    const { store, transactor } = await makeGroup();
    const ids = Array.from({ length: 10 }, () => newDocumentId(TABLE));
    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise; // hold ONLY the first flush
    };

    const p1 = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20); // p1 staged; its batch (1 unit) is now in flight, gated
    const rest = Array.from({ length: 9 }, (_, k) =>
      transactor.runInTransaction(async (ctx) => ctx.put(ids[k + 1]!, { i: BigInt(k + 1) })),
    );
    await delay(20); // all 9 accumulate into the pending batch while flush #1 is gated
    g.release();
    await Promise.all([p1, ...rest]);

    expect(store.batchSizes).toEqual([1, 9]);
    const stats = transactor.groupCommitStats();
    expect(stats.flushCount).toBe(2);
    expect(stats.maxBatchSize).toBe(9);
    expect(stats.lastBatchSize).toBe(9);
  });

  it("idle sequence (each mutation awaited) → N flushes of 1", async () => {
    const { store, transactor } = await makeGroup();
    for (let k = 0; k < 4; k++) {
      await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: BigInt(k) }));
    }
    expect(store.batchSizes).toEqual([1, 1, 1, 1]);
    expect(transactor.groupCommitStats().flushCount).toBe(4);
    expect(transactor.groupCommitStats().maxBatchSize).toBe(1);
  });
});

describe("group commit — two-buffer visibility regressions", () => {
  it("lost-update: an RMW intersecting a FLUSHING unit aborts and its retry sees the flushed write", async () => {
    const { store, transactor } = await makeGroup();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n })); // setup

    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise;
    };
    const rmw = () =>
      transactor.runInTransaction(async (ctx) => {
        const d = (await ctx.get(id)) as { count: bigint } | null;
        ctx.put(id, { count: (d?.count ?? 0n) + 1n });
      });

    const pA = rmw(); // reads 0, stages; its batch is flushing (gated)
    await delay(20);
    const pB = rmw(); // reads 0 at the pre-A snapshot; validate hits the FLUSHING batch → tagged OCC → waits
    await delay(20);
    g.release();
    await Promise.all([pA, pB]);

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect((final.value as { count: bigint }).count).toBe(2n); // NOT 1 — the retry saw A's write
  });

  it("forked-chain: a blind write to a FLUSHING doc is cut and chains prev_ts to the flushed revision", async () => {
    const { store, transactor } = await makeGroup();
    const id = newDocumentId(TABLE);

    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise;
    };

    const pA = transactor.runInTransaction(async (ctx) => ctx.put(id, { v: 1n })); // blind; flushing (gated)
    await delay(20);
    const pB = transactor.runInTransaction(async (ctx) => ctx.put(id, { v: 2n })); // blind same doc → batch-cut
    await delay(20);
    g.release();
    await Promise.all([pA, pB]);

    const revs = await countRevisions(store, id);
    expect(revs).toHaveLength(2);
    expect(revs[0]!.prev_ts).toBeNull();
    expect(revs[1]!.prev_ts).toBe(revs[0]!.ts); // the chain is unforked: rev2 → rev1
    expect(revs[1]!.ts).toBeGreaterThan(revs[0]!.ts);

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect(final.value).toEqual({ v: 2n });
  });
});

describe("group commit — ordering, failure, retry", () => {
  it("publishes fan-out strictly in unit order across two batches", async () => {
    const { store, transactor, deltas } = await makeGroup();
    const ids = Array.from({ length: 6 }, () => newDocumentId(TABLE));
    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise;
    };

    const p1 = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20);
    const rest = Array.from({ length: 5 }, (_, k) =>
      transactor.runInTransaction(async (ctx) => ctx.put(ids[k + 1]!, { i: BigInt(k + 1) })),
    );
    await delay(20);
    g.release();
    await Promise.all([p1, ...rest]);

    expect(deltas).toHaveLength(6);
    const tss = deltas.map((d) => d.commitTs);
    for (let i = 1; i < tss.length; i++) expect(tss[i]! > tss[i - 1]!).toBe(true); // strictly increasing
  });

  it("failure contract: a flush error rejects EVERY unit of the batch; ring/oracle clean; the loop survives", async () => {
    const { store, transactor } = await makeGroup();
    const idSetup = newDocumentId(TABLE);
    const rSetup = await transactor.runInTransaction(async (ctx) => ctx.put(idSetup, { v: 0n }));

    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      const c = seen++;
      if (c === 0) await g.promise; // batch #1 (A) — succeeds after release
      if (c === 1) throw new Error("flush boom"); // batch #2 ({B,C}) — fails
    };

    const pA = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 1n }));
    await delay(20);
    const pB = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 2n }));
    const pC = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 3n }));
    await delay(20);
    g.release();

    const rA = await pA;
    expect(rA.committed).toBe(true);
    await expect(pB).rejects.toThrow("flush boom");
    await expect(pC).rejects.toThrow("flush boom");

    // Ring/oracle/store never saw the failed batch's ts's: the store max is exactly A's commit.
    expect(await store.maxTimestamp()).toBe(rA.commitTs);
    expect(rA.commitTs > rSetup.commitTs).toBe(true);

    // The committer loop survived a poisoned batch — a subsequent mutation commits normally.
    const pD = await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 4n }));
    expect(pD.committed).toBe(true);
    expect(pD.commitTs > rA.commitTs).toBe(true);
  });

  it("fence mid-batch: a non-OCC flush error rejects EVERY unit and is NOT retried", async () => {
    const { store, transactor } = await makeGroup();
    await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 0n })); // setup

    const g = gate();
    let seen = 0;
    let fenceFlushes = 0;
    store.beforeCommitBatch = async () => {
      const c = seen++;
      if (c === 0) {
        await g.promise; // filler batch (A) — succeeds after release
        return;
      }
      fenceFlushes++;
      throw Object.assign(new Error("fenced"), { name: "FencedError" }); // batch {B,C} fences
    };

    const pA = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 1n }));
    await delay(20);
    const pB = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 2n }));
    const pC = transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { v: 3n }));
    await delay(20);
    g.release();

    await expect(pA).resolves.toMatchObject({ committed: true });
    await expect(pB).rejects.toMatchObject({ name: "FencedError" });
    await expect(pC).rejects.toMatchObject({ name: "FencedError" });
    expect(fenceFlushes).toBe(1); // the {B,C} batch was attempted once — a fence is never OCC-retried
  });

  it("retry awaits the conflicting PENDING batch (not merely the current flush) and reads its write", async () => {
    const { store, transactor } = await makeGroup();
    const x = newDocumentId(TABLE);
    const y = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(x, { count: 0n })); // setup x=0

    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise; // hold batch #1 (the y filler) flushing
    };

    const pFiller = transactor.runInTransaction(async (ctx) => ctx.put(y, { v: 9n })); // batch #1, flushing
    await delay(20);
    const pU = transactor.runInTransaction(async (ctx) => ctx.put(x, { count: 5n })); // blind write x → PENDING
    await delay(10);
    const pR = transactor.runInTransaction(async (ctx) => {
      const d = (await ctx.get(x)) as { count: bigint }; // reads x=0 (pre-U snapshot)
      ctx.put(x, { count: d.count + 1n }); // validate hits x in the PENDING batch → tagged with ITS promise
    });
    await delay(10);
    g.release();
    await Promise.all([pFiller, pU, pR]);

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(x));
    // pR must have seen pU's write (x=5) and produced 6 — not 1 (which would mean it lost U's update).
    expect((final.value as { count: bigint }).count).toBe(6n);
  });
});

describe("group commit — idle-frontier-closer seam (Fleet B4 frontier-inversion fix)", () => {
  it("ShardWriter.hasInFlightWork: false idle, true while pending non-empty AND while flushing, false when drained", async () => {
    const store = new HookedSqliteStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const writer = new ShardWriter(
      store,
      new MonotonicTimestampOracle(0n),
      DEFAULT_SHARD,
      undefined,
      DEFAULT_HEADROOM,
      true, // group commit
    );

    expect(writer.hasInFlightWork()).toBe(false); // no batch yet

    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise; // hold the first flush in flight
    };

    const p1 = writer.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 0n }));
    await delay(20); // p1's batch has detached and is now flushing (gated)
    expect(writer.hasInFlightWork()).toBe(true); // flushingBatch !== null

    // While flush #1 is gated, a second write accumulates into the pending batch.
    const p2 = writer.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 1n }));
    await delay(20);
    expect(writer.hasInFlightWork()).toBe(true); // pendingBatch non-empty too

    g.release();
    await Promise.all([p1, p2]);
    expect(writer.hasInFlightWork()).toBe(false); // fully drained → idle
  });

  it("tryRunExclusiveOnShard returns FALSE mid-flush though the mutex is FREE, TRUE once drained", async () => {
    const { store, transactor } = await makeGroup();
    const ids = Array.from({ length: 3 }, () => newDocumentId(TABLE));
    const g = gate();
    let seen = 0;
    store.beforeCommitBatch = async () => {
      if (seen++ === 0) await g.promise; // hold the first flush in flight
    };

    // Idle: no batch, mutex free → the closer would run.
    let ranIdle = false;
    expect(
      await transactor.tryRunExclusiveOnShard(DEFAULT_SHARD, async () => {
        ranIdle = true;
      }),
    ).toBe(true);
    expect(ranIdle).toBe(true);

    // Stage a batch → it detaches and enters the flushing state (gated). The commit mutex is FREE now
    // (the flush I/O runs OFF the mutex) — this is the load-bearing assertion: mutex-free yet BUSY.
    const p1 = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20);
    let ranMidFlush = false;
    expect(
      await transactor.tryRunExclusiveOnShard(DEFAULT_SHARD, async () => {
        ranMidFlush = true;
      }),
    ).toBe(false);
    expect(ranMidFlush).toBe(false); // fn must NOT have run — the closer skipped this beat

    // More units accumulate into the pending batch while flush #1 is gated → still busy.
    const rest = Array.from({ length: 2 }, (_, k) =>
      transactor.runInTransaction(async (ctx) => ctx.put(ids[k + 1]!, { i: BigInt(k + 1) })),
    );
    await delay(20);
    expect(await transactor.tryRunExclusiveOnShard(DEFAULT_SHARD, async () => {})).toBe(false);

    g.release();
    await Promise.all([p1, ...rest]);

    // Drained → idle again → the closer runs.
    let ranDrained = false;
    expect(
      await transactor.tryRunExclusiveOnShard(DEFAULT_SHARD, async () => {
        ranDrained = true;
      }),
    ).toBe(true);
    expect(ranDrained).toBe(true);
  });
});

describe("group commit — flag-off byte-identity + pure reads", () => {
  async function runSeq(groupCommit: boolean) {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const t = new ShardedTransactor(store, { groupCommit });
    const id = newDocumentId(TABLE);
    const tss: bigint[] = [];
    tss.push((await t.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }))).commitTs);
    for (let k = 0; k < 5; k++) {
      const r = await t.runInTransaction(async (ctx) => {
        const d = (await ctx.get(id)) as { count: bigint };
        ctx.put(id, { count: d.count + 1n });
      });
      tss.push(r.commitTs);
    }
    const final = await t.runInTransaction(async (ctx) => ctx.get(id));
    return { tss, final: final.value };
  }

  it("group commit = single commit for a sequential workload (identical ts sequence + final state)", async () => {
    const off = await runSeq(false);
    const on = await runSeq(true);
    expect(on.tss).toEqual(off.tss);
    expect(on.final).toEqual(off.final);
    expect((on.final as { count: bigint }).count).toBe(5n);
  });

  it("a pure read never touches the batch machinery", async () => {
    const { store, transactor } = await makeGroup();
    const r = await transactor.runInTransaction(async (ctx) => ctx.get(newDocumentId(TABLE)));
    expect(r.committed).toBe(false);
    expect(r.oplog).toBeNull();
    expect(store.batchSizes.length).toBe(0);
    expect(transactor.groupCommitStats().flushCount).toBe(0);
  });

  it("a single grouped write commits and fans out one delta with the store-allocated ts", async () => {
    const { transactor, deltas } = await makeGroup();
    const id = newDocumentId(TABLE);
    const r = await transactor.runInTransaction(async (ctx) => {
      ctx.put(id, { body: "hi" });
      return "ok";
    });
    expect(r.committed).toBe(true);
    expect(r.value).toBe("ok");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.commitTs).toBe(r.commitTs);
    const read = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect(read.value).toEqual({ body: "hi" });
  });
});

describe("SingleWriterTransactor.groupCommitStats — T4 health mirror", () => {
  it("all zero when groupCommit is unset (byte-identical single-commit path)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const t = new SingleWriterTransactor(store, new MonotonicTimestampOracle(0n));
    await t.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 0n }));
    expect(t.groupCommitStats()).toEqual({ lastBatchSize: 0, maxBatchSize: 0, flushCount: 0 });
  });

  it("reports a flushed batch's size when groupCommit is on", async () => {
    const store = new HookedSqliteStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const t = new SingleWriterTransactor(store, new MonotonicTimestampOracle(0n), { groupCommit: true });
    await t.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { i: 0n }));
    const stats = t.groupCommitStats();
    expect(stats.flushCount).toBe(1);
    expect(stats.lastBatchSize).toBe(1);
    expect(stats.maxBatchSize).toBe(1);
  });
});
