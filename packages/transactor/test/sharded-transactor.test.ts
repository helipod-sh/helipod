/**
 * `ShardedTransactor` (shards B2a, D1) — per-shard writer state + the two-read-set split
 * (D4). All tests run against `SqliteDocStore` (a single physical connection, single
 * physical thread): SQLite therefore serializes actual disk writes even when two shards'
 * `commit()` calls interleave in-process. The "concurrent commits on two shards" test below
 * proves TRANSACTOR-level concurrency only — that shard s2's mutex is never blocked waiting
 * on shard s1's in-flight commit — which is the whole of what this package is responsible
 * for. Genuine STORE-level parallelism (two Postgres transactions actually running at once)
 * needs the per-shard commit-connection pool the design spec assigns to a different task; that
 * is out of scope here and this file makes no claim about it.
 */
import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import type { DocStore } from "@stackbase/docstore";
import {
  newDocumentId,
  encodeStorageTableId,
  internalIdToHex,
  DEFAULT_SHARD,
  type ShardId,
} from "@stackbase/id-codec";
import { tableKeyspaceId, type KeyRange } from "@stackbase/index-key-codec";
import {
  ShardedTransactor,
  SingleWriterTransactor,
  type Transactor,
  type TransactionContext,
} from "../src/index";

const TABLE = 20001;
const GLOBAL_TABLE = 20002;

function makeStore() {
  return new SqliteDocStore(new NodeSqliteAdapter());
}

async function makeSetupStore() {
  const store = makeStore();
  await store.setupSchema();
  return store;
}

/** Full committed log, in a form comparable across two independent stores/runs. */
async function dumpLog(store: DocStore) {
  const out: unknown[] = [];
  for await (const e of store.load_documents({ minInclusive: 0n, maxExclusive: 10_000n }, "asc")) {
    out.push({
      ts: e.ts.toString(),
      tableNumber: e.id.tableNumber,
      internalId: internalIdToHex(e.id.internalId),
      prev_ts: e.prev_ts?.toString() ?? null,
      value: e.value ? e.value.value : null,
    });
  }
  return out;
}

describe("ShardedTransactor — per-shard isolation", () => {
  it("commits on two different shards both succeed and do not conflict with each other", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);

    const [ra, rb] = await Promise.all([
      transactor.runInTransaction(async (ctx) => ctx.put(a, { v: 1n }), { shardId: "s1" }),
      transactor.runInTransaction(async (ctx) => ctx.put(b, { v: 2n }), { shardId: "s2" }),
    ]);

    expect(ra.committed).toBe(true);
    expect(rb.committed).toBe(true);
    expect(ra.shardId).toBe("s1");
    expect(rb.shardId).toBe("s2");
  });

  it("a conflict WITHIN one shard still aborts (maxRetries: 0 surfaces OccConflictError)", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }), { shardId: "s1" });

    await expect(
      transactor.runInTransaction(
        async (ctx) => {
          await ctx.get(id);
          // a conflicting write, committed mid-flight, on the SAME shard
          await transactor.runInTransaction(async (inner) => inner.put(id, { count: 99n }), {
            shardId: "s1",
          });
          ctx.put(id, { count: 1n });
        },
        { shardId: "s1", maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ name: "OccConflictError" });
  });

  it("the identical read-then-write pattern across two DIFFERENT shards does NOT conflict (each shard's OCC ring is its own)", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }), { shardId: "s1" });

    const result = await transactor.runInTransaction(
      async (ctx) => {
        await ctx.get(id);
        // a write to the SAME key, committed mid-flight, but on a DIFFERENT shard's ring —
        // s1's conflict predicate never sees it (D1: independent `recentCommits` per shard).
        await transactor.runInTransaction(async (inner) => inner.put(id, { count: 99n }), {
          shardId: "s2",
        });
        ctx.put(id, { count: 1n });
      },
      { shardId: "s1", maxRetries: 0 },
    );

    expect(result.committed).toBe(true);
  });

  it("ring/snapshot state is per-shard: a long-held snapshot on one shard does not block another shard's ring from pruning", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const idS1 = newDocumentId(TABLE);
    const idS2 = newDocumentId(TABLE);

    // Seed both shards so each has a ShardWriter (and their own oracle/ring) before the hold.
    await transactor.runInTransaction(async (ctx) => ctx.put(idS2, { seed: true }), { shardId: "s2" });

    let releaseHold: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    // Hold a snapshot open on s2 (a pure read that never returns until we release it) —
    // if `activeSnapshots` were shared across shards, this would pin s1's minActiveSnapshot
    // down at s2's (much older) snapshot ts and prevent s1's ring from ever pruning.
    const heldRead = transactor.runInTransaction(
      async (ctx) => {
        await ctx.get(idS2);
        await hold;
        return null;
      },
      { shardId: "s2" },
    );

    // Give the held read a tick to snapshot + retain before we start committing on s1.
    await new Promise((r) => setTimeout(r, 5));

    for (let i = 0; i < 3; i++) {
      await transactor.runInTransaction(async (ctx) => ctx.put(idS1, { n: BigInt(i) }), {
        shardId: "s1",
      });
    }

    const shards = (
      transactor as unknown as {
        shards: Map<ShardId, { recentCommits: { ts: bigint }[] }>;
      }
    ).shards;
    // s1 has no held snapshots of its own, so each commit's `prune()` drops everything except
    // that commit's own still-just-retained entry (released only after `runInTransaction`
    // returns) — the ring settles at 1, REGARDLESS of s2's long-open read. A shared-ring bug
    // would instead pin s1's min down at s2's (much older) snapshot and keep ALL 3 entries.
    expect(shards.get("s1")!.recentCommits.length).toBe(1);

    releaseHold!();
    await heldRead;
  });

  it("commits on two shards run concurrently at the transactor level: shard s2's commit is never blocked behind shard s1's in-flight commitWrite (independent mutexes)", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);

    let releaseS1: () => void;
    const s1Gate = new Promise<void>((resolve) => {
      releaseS1 = resolve;
    });
    const originalCommitWrite = store.commitWrite.bind(store);
    const spy = vi
      .spyOn(store, "commitWrite")
      .mockImplementation(async (entries, indexWrites, shardId) => {
        if (shardId === "s1") await s1Gate; // gate ONLY shard s1's commit
        return originalCommitWrite(entries, indexWrites, shardId);
      });

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);

    const s1Promise = transactor.runInTransaction(async (ctx) => ctx.put(idA, { v: 1n }), {
      shardId: "s1",
    });
    // Let s1's commit reach (and block on) the gate before racing s2.
    await new Promise((r) => setTimeout(r, 10));

    // If shard mutexes were shared, this would hang until releaseS1() below — it must NOT.
    const s2Result = await transactor.runInTransaction(async (ctx) => ctx.put(idB, { v: 2n }), {
      shardId: "s2",
    });
    expect(s2Result.committed).toBe(true);

    releaseS1!();
    const s1Result = await s1Promise;
    expect(s1Result.committed).toBe(true);
    spy.mockRestore();
  });
});

describe("ShardedTransactor — observeTimestamp fan-out", () => {
  it("fans a learned timestamp to every shard oracle created so far, and does not create new shards", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { a: 1n }), {
      shardId: "s1",
    });
    await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { a: 1n }), {
      shardId: "s2",
    });

    transactor.observeTimestamp(1000n);

    const shards = (
      transactor as unknown as {
        shards: Map<
          ShardId,
          { oracle: { getCurrentTimestamp(): bigint; getLastCommittedTimestamp(): bigint } }
        >;
      }
    ).shards;
    expect(shards.size).toBe(2); // s1, s2 — observeTimestamp must not conjure a third shard
    expect(shards.get("s1")!.oracle.getCurrentTimestamp()).toBeGreaterThanOrEqual(1000n);
    expect(shards.get("s1")!.oracle.getLastCommittedTimestamp()).toBeGreaterThanOrEqual(1000n);
    expect(shards.get("s2")!.oracle.getCurrentTimestamp()).toBeGreaterThanOrEqual(1000n);
    expect(shards.get("s2")!.oracle.getLastCommittedTimestamp()).toBeGreaterThanOrEqual(1000n);
  });

  it("does not create a shard that has never been used", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    transactor.observeTimestamp(500n); // no shard touched yet

    const shards = (transactor as unknown as { shards: Map<ShardId, unknown> }).shards;
    expect(shards.size).toBe(0);

    // A shard first used AFTER observeTimestamp still boots correctly (seeds from the store).
    const result = await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { x: 1n }), {
      shardId: "s3",
    });
    expect(result.committed).toBe(true);
  });
});

describe("ShardedTransactor — byte-identity with SingleWriterTransactor", () => {
  it("a default-shard-only ShardedTransactor produces the identical commit sequence and store state as SingleWriterTransactor", async () => {
    const storeSingle = await makeSetupStore();
    const single = new SingleWriterTransactor(storeSingle, new MonotonicTimestampOracle());

    const storeSharded = await makeSetupStore();
    const sharded = new ShardedTransactor(storeSharded);

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);

    const runOps = async (transactor: Transactor) => {
      await transactor.runInTransaction(async (ctx) => ctx.put(idA, { n: 1n }));
      await transactor.runInTransaction(async (ctx) => {
        const doc = (await ctx.get(idA)) as { n: bigint } | null;
        ctx.put(idA, { n: (doc?.n ?? 0n) + 1n });
      });
      await transactor.runInTransaction(async (ctx) => ctx.put(idB, { n: 5n }));
      await transactor.runInTransaction(async (ctx) => ctx.delete(idB));
    };

    await runOps(single);
    await runOps(sharded);

    expect(await dumpLog(storeSharded)).toEqual(await dumpLog(storeSingle));
  });

  it("an undeclared shardId routes to DEFAULT_SHARD, matching SingleWriterTransactor's default", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const result = await transactor.runInTransaction(async (ctx) => {
      expect(ctx.shardId).toBe(DEFAULT_SHARD);
      ctx.put(newDocumentId(TABLE), { a: 1n });
    });
    expect(result.shardId).toBe(DEFAULT_SHARD);
  });
});

describe("TransactionContext — the two-read-set split (D4)", () => {
  it("recordReadUnvalidated does NOT trigger an OCC conflict, but DOES appear in the reported (union) read ranges", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const globalId = newDocumentId(GLOBAL_TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(globalId, { perm: true }));

    const globalRange: KeyRange = {
      keyspace: tableKeyspaceId(encodeStorageTableId(GLOBAL_TABLE)),
      start: new Uint8Array(0),
      end: null,
    };

    let capturedCtx: TransactionContext | null = null;
    const result = await transactor.runInTransaction(
      async (ctx) => {
        capturedCtx = ctx;
        ctx.recordReadUnvalidated(globalRange);
        // Committed mid-flight: a write to the exact range we just recorded (unvalidated).
        await transactor.runInTransaction(async (inner) => inner.put(globalId, { perm: false }));
        ctx.put(newDocumentId(TABLE), { x: 1n }); // something to actually commit
      },
      { maxRetries: 0 },
    );

    expect(result.committed).toBe(true); // no OccConflictError despite the intervening write
    const reported = capturedCtx!.reads.toArray();
    expect(reported.some((r) => r.keyspace === globalRange.keyspace)).toBe(true);
  });

  it("recordRead (the default, validated path) is unaffected: the same intervening write DOES conflict", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const globalId = newDocumentId(GLOBAL_TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(globalId, { perm: true }));

    const globalRange: KeyRange = {
      keyspace: tableKeyspaceId(encodeStorageTableId(GLOBAL_TABLE)),
      start: new Uint8Array(0),
      end: null,
    };

    await expect(
      transactor.runInTransaction(
        async (ctx) => {
          ctx.recordRead(globalRange);
          await transactor.runInTransaction(async (inner) => inner.put(globalId, { perm: false }));
          ctx.put(newDocumentId(TABLE), { x: 1n });
        },
        { maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ name: "OccConflictError" });
  });

  it("get() reads remain validated (unaffected by the split): a document read still conflicts on an intervening write to it", async () => {
    const store = await makeSetupStore();
    const transactor = new ShardedTransactor(store);
    const id = newDocumentId(TABLE);
    await transactor.runInTransaction(async (ctx) => ctx.put(id, { count: 0n }));

    await expect(
      transactor.runInTransaction(
        async (ctx) => {
          await ctx.get(id);
          await transactor.runInTransaction(async (inner) => inner.put(id, { count: 99n }));
          ctx.put(id, { count: 1n });
        },
        { maxRetries: 0 },
      ),
    ).rejects.toMatchObject({ name: "OccConflictError" });
  });
});
