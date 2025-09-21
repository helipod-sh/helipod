import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { newDocumentId, encodeStorageTableId, DEFAULT_SHARD } from "@stackbase/id-codec";
import { SingleWriterTransactor, HeadroomExceededError, type OplogDelta } from "../src/index";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

async function makeTransactor() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const oracle = new MonotonicTimestampOracle();
  const deltas: OplogDelta[] = [];
  const transactor = new SingleWriterTransactor(store, oracle, {
    fanout: { publish: (d) => void deltas.push(d) },
  });
  return { store, oracle, transactor, deltas };
}

describe("commit + oplog", () => {
  it("commits a write and emits a serializable oplog delta", async () => {
    const { transactor, deltas } = await makeTransactor();
    const id = newDocumentId(TABLE);

    const result = await transactor.runInTransaction(async (ctx) => {
      ctx.put(id, { body: "hi" });
      return "ok";
    });

    expect(result.committed).toBe(true);
    expect(result.value).toBe("ok");
    expect(result.shardId).toBe(DEFAULT_SHARD);
    expect(result.oplog!.writtenTables).toContain(TABLE_ID);
    expect(result.oplog!.writtenRanges.length).toBeGreaterThan(0);
    expect(result.oplog!.commitTs).toBe(result.commitTs);
    expect(deltas).toHaveLength(1);

    const read = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect(read.value).toEqual({ body: "hi" });
    expect(read.committed).toBe(false); // pure read does not commit
    expect(read.oplog).toBeNull();
  });

  it("supports read-your-own-writes within a transaction", async () => {
    const { transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    const r = await transactor.runInTransaction(async (ctx) => {
      ctx.put(id, { n: 1n });
      return await ctx.get(id); // sees its own pending write
    });
    expect(r.value).toEqual({ n: 1n });
  });

  it("deletes a document", async () => {
    const { transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { x: 1n }));
    await transactor.runInTransaction(async (ctx) => ctx.delete(id));
    const r = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect(r.value).toBeNull();
  });
});

describe("OCC", () => {
  it("prevents lost updates under concurrent increments (conflict → deterministic replay)", async () => {
    const { transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }));

    const increment = () =>
      transactor.runInTransaction(async (ctx) => {
        const doc = await ctx.get(id);
        const count = (doc as { count: bigint } | null)?.count ?? 0n;
        ctx.put(id, { count: count + 1n });
      });

    // 3 concurrent increments: exactly one wins each round, the others replay.
    await Promise.all([increment(), increment(), increment()]);

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect((final.value as { count: bigint }).count).toBe(3n);
  });

  it("loses no updates under heavy concurrency (regression: snapshot must use the committed clock)", async () => {
    // With the old bug (snapshot from the just-allocated ts), some increments silently lost
    // under load because the strict `c.ts > snapshotTs` check missed an in-flight commit.
    const { transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }));

    const N = 25;
    // High retry budget so contention never *exhausts* retries — then a final count below N
    // can only mean a silently-lost update (the bug), not an explicit conflict failure.
    const increment = () =>
      transactor.runInTransaction(
        async (ctx) => {
          const doc = await ctx.get(id);
          const count = (doc as { count: bigint } | null)?.count ?? 0n;
          ctx.put(id, { count: count + 1n });
        },
        { maxRetries: 100 },
      );
    await Promise.all(Array.from({ length: N }, increment));

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect((final.value as { count: bigint }).count).toBe(BigInt(N));
  });

  it("does NOT conflict on disjoint keys (concurrent writes to different docs both commit)", async () => {
    const { transactor } = await makeTransactor();
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);

    const [ra, rb] = await Promise.all([
      transactor.runInTransaction(async (ctx) => {
        await ctx.get(a);
        ctx.put(a, { v: 1n });
      }),
      transactor.runInTransaction(async (ctx) => {
        await ctx.get(b);
        ctx.put(b, { v: 2n });
      }),
    ]);

    expect(ra.committed).toBe(true);
    expect(rb.committed).toBe(true);
    // distinct commit timestamps (serialized single writer)
    expect(ra.commitTs).not.toBe(rb.commitTs);
  });

  it("surfaces a conflict that exhausts retries instead of looping forever", async () => {
    const { transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }));

    // A transaction that reads id, then we mutate id out from under it before it commits,
    // with zero retries allowed → it must throw the conflict.
    await expect(
      transactor.runInTransaction(
        async (ctx) => {
          await ctx.get(id);
          // commit a conflicting write mid-flight
          await transactor.runInTransaction(async (inner) => inner.put(id, { count: 99n }));
          ctx.put(id, { count: 1n });
        },
        { maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ name: "OccConflictError" });
  });
});

describe("store-allocated commit timestamps (Task 2)", () => {
  it("routes commit through DocStore.commitWrite with ts:0n placeholders, prev_ts chained from the pre-commit head revision", async () => {
    const { store, transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);

    const spy = vi.spyOn(store, "commitWrite");

    const first = await transactor.runInTransaction(async (ctx) => ctx.put(id, { n: 1n }));
    expect(spy).toHaveBeenCalledTimes(1);
    // First write: no prior revision, so prev_ts is null; ts arrives as the 0n placeholder.
    const [firstEntries, firstIndexWrites] = spy.mock.calls[0]!;
    expect(firstEntries).toHaveLength(1);
    expect(firstEntries[0]!.ts).toBe(0n);
    expect(firstEntries[0]!.prev_ts).toBeNull();
    for (const iw of firstIndexWrites) expect(iw.ts).toBe(0n);

    const headBeforeSecondCommit = await store.get(id);
    expect(headBeforeSecondCommit!.ts).toBe(first.commitTs);

    await transactor.runInTransaction(async (ctx) => ctx.put(id, { n: 2n }));
    expect(spy).toHaveBeenCalledTimes(2);
    const [secondEntries, secondIndexWrites] = spy.mock.calls[1]!;
    expect(secondEntries).toHaveLength(1);
    // prev_ts chaining is untouched: it must match the head revision observed *before* this commit,
    // not some derivative of the (no-longer-allocated) oracle timestamp.
    expect(secondEntries[0]!.ts).toBe(0n);
    expect(secondEntries[0]!.prev_ts).toBe(headBeforeSecondCommit!.ts);
    for (const iw of secondIndexWrites) expect(iw.ts).toBe(0n);
  });

  it("never calls the oracle's allocateTimestamp; the commit timestamp comes from the store", async () => {
    const { store, oracle, transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    const allocateSpy = vi.spyOn(oracle, "allocateTimestamp");
    const publishSpy = vi.spyOn(oracle, "publishCommitted");

    const result = await transactor.runInTransaction(async (ctx) => ctx.put(id, { n: 1n }));

    expect(allocateSpy).not.toHaveBeenCalled();
    expect(publishSpy).toHaveBeenCalledWith(result.commitTs);
    expect(result.commitTs).toBe(await store.maxTimestamp());
    expect(oracle.getLastCommittedTimestamp()).toBe(await store.maxTimestamp());
  });

  it("the transactor's recent-commit ring records the store-returned commit ts, matching store.maxTimestamp()", async () => {
    const { store, transactor } = await makeTransactor();
    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);

    await transactor.runInTransaction(async (ctx) => ctx.put(idA, { v: 1n }));
    const second = await transactor.runInTransaction(async (ctx) => ctx.put(idB, { v: 2n }));

    // Private field access is deliberate: this is the one place we can directly observe that the
    // ring entry pushed on commit carries the store-allocated ts, not a caller-allocated one.
    const recentCommits = (transactor as unknown as { recentCommits: { ts: bigint }[] })
      .recentCommits;
    expect(recentCommits.length).toBeGreaterThan(0);
    const newest = recentCommits[recentCommits.length - 1]!.ts;
    expect(newest).toBe(second.commitTs);
    expect(newest).toBe(await store.maxTimestamp());
  });

  it("OCC conflict/replay behavior is unaffected by store-allocated timestamps (existing coverage, capture-checked)", async () => {
    const { store, transactor } = await makeTransactor();
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }));

    const spy = vi.spyOn(store, "commitWrite");

    const increment = () =>
      transactor.runInTransaction(async (ctx) => {
        const doc = await ctx.get(id);
        const count = (doc as { count: bigint } | null)?.count ?? 0n;
        ctx.put(id, { count: count + 1n });
      });
    await Promise.all([increment(), increment(), increment()]);

    const final = await transactor.runInTransaction(async (ctx) => ctx.get(id));
    expect((final.value as { count: bigint }).count).toBe(3n);
    // Every successful commit (including replays) still hands 0n placeholders to the store.
    for (const call of spy.mock.calls) {
      for (const entry of call[0]) expect(entry.ts).toBe(0n);
    }
    expect(final.value).toEqual({ count: 3n });
    expect(await store.maxTimestamp()).toBeGreaterThan(0n);
  });
});

describe("headroom", () => {
  it("trips HeadroomExceededError and does not retry it", async () => {
    const { transactor } = await makeTransactor();
    await expect(
      transactor.runInTransaction(
        async (ctx) => {
          ctx.put(newDocumentId(TABLE), { a: 1n });
          ctx.put(newDocumentId(TABLE), { b: 2n });
        },
        { headroom: { maxWrites: 1 } },
      ),
    ).rejects.toBeInstanceOf(HeadroomExceededError);
  });
});
