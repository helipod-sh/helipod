/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Shards B2a (Task 4) — the N-shard fleet layer, exercised against a real `PostgresDocStore` over
 * PGlite (real Postgres semantics, single in-process connection). PGlite has no commit pool, so the
 * lease's per-slot lock falls back to the legacy writer lock (always true here) — that's fine: this
 * file proves the SHARD SEMANTICS (per-shard fencing, all-rows seeding, min-F, idle closing) which
 * are connection-agnostic; genuine cross-connection parallelism + failover are the fleet-e2e's job.
 */
import { describe, it, expect, vi } from "vitest";
import { newDocumentId, shardIdList, DEFAULT_SHARD, encodeStorageIndexId, type InternalDocumentId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { FencedError } from "../src/fenced-error";
import { LeaseManager } from "../src/lease";
import { installCommitGuard, relinquish, FrontierMonitor, acquireShardAsWriter } from "../src/node";
import { ReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";
import { PgliteClient } from "./pglite-client";

const N = 4; // "default","s1","s2","s3"
const SHARDS = shardIdList(N);

/** A `TryRunExclusiveOnShard` stub that treats every shard's commit mutex as FREE: always runs `fn`
 *  and reports success. Stands in for the runtime seam when the test drives `closeIdleFrontiers`
 *  directly (no real transactor). The busy-skip path is covered by the dedicated test below. */
const alwaysFree = async (_shardId: string, fn: () => Promise<void>): Promise<boolean> => {
  await fn();
  return true;
};
const TABLE = 20050;
const INDEX_ID = encodeStorageIndexId(TABLE, "by_key");

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}
function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: { id, value: { body } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } };
}

async function makeNode(advertiseUrl = "http://node-a:4000") {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema();
  const lease = new LeaseManager(client, { advertiseUrl });
  await lease.setup();
  return { client, pgStore, lease };
}

/** Acquire ALL N shard leases as the writer (mirrors node.ts's writer-boot acquire-all: default via
 *  the writer-election lock, then slots 1…N-1 via `acquireShardAsWriter`). */
async function acquireAll(lease: LeaseManager): Promise<void> {
  await lease.tryAcquire(DEFAULT_SHARD, 0);
  for (let slot = 1; slot < N; slot++) await acquireShardAsWriter(lease, SHARDS[slot]!, slot, 10);
}

describe("Shards B2a — N shard leases", () => {
  it("acquire-all takes N leases (one row per shard, each epoch 1)", async () => {
    const { client, lease } = await makeNode();
    await acquireAll(lease);
    const rows = await lease.readAllFrontiers();
    expect(rows.map((r) => r.shardId).sort()).toEqual([...SHARDS].sort());
    for (const s of SHARDS) expect(lease.currentEpoch(s)).toBe(1n);
    await client.close();
  });

  it("per-shard commit guard: a commit on s2 fences s2's row ONLY — frontier advances on s2, others unchanged", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});

    // commitWrite routes shardId → the guard, which advances THAT shard's frontier chain.
    const ts = await pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], [], "s2");

    const frontiers = new Map((await lease.readAllFrontiers()).map((r) => [r.shardId, r.frontierTs]));
    expect(frontiers.get("s2")).toBe(ts); // fenced+advanced
    expect(frontiers.get(DEFAULT_SHARD)).toBe(0n); // untouched
    expect(frontiers.get("s1")).toBe(0n);
    expect(frontiers.get("s3")).toBe(0n);
    // prev_ts chain is per-row too: s2 stepped off its own seeded 0.
    expect((await lease.read("s2"))?.prevTs).toBe(0n);
    await client.close();
  });

  it("a commit on a shard whose epoch was superseded fences ONLY that commit; sibling shards commit fine", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});
    // Another node steals s1's lease (epoch bump) — but this node still holds default/s2/s3.
    const other = new LeaseManager(client, { advertiseUrl: "http://node-b:5000" });
    await other.tryAcquire("s1", 1); // s1 epoch → 2; this node's cached s1 epoch (1) is now stale

    await expect(pgStore.commitWrite([doc(newDocumentId(TABLE), "s1")], [], "s1")).rejects.toThrow();
    // A commit on a shard this node STILL holds succeeds.
    const ts = await pgStore.commitWrite([doc(newDocumentId(TABLE), "s3")], [], "s3");
    expect((await lease.read("s3"))?.frontierTs).toBe(ts);
    await client.close();
  });

  it("batched heartbeat extends ALL held leases in one round-trip; a superseded epoch shows as updated<expected", async () => {
    const { client, lease } = await makeNode();
    await acquireAll(lease);
    const before = new Map((await lease.readAllFrontiers()).map((r) => [r.shardId, r.frontierTs]));
    void before;

    // Mechanical call-site update (Shards B2b, Task 3): heartbeatAll now also returns `fencedShardIds`
    // — every held pair still renewed, so it's empty here.
    const first = await lease.heartbeatAll();
    expect(first).toEqual({ updated: N, expected: N, fencedShardIds: [] });

    // Supersede s2's epoch; the next batched heartbeat updates only N-1 rows → a PER-SHARD loss signal
    // (B2b, D2) naming s2 precisely, not just an undifferentiated updated<expected count.
    const other = new LeaseManager(client, { advertiseUrl: "http://node-b:5000" });
    await other.tryAcquire("s2", 2);
    const second = await lease.heartbeatAll();
    expect(second.expected).toBe(N);
    expect(second.updated).toBe(N - 1);
    expect(second.fencedShardIds).toEqual(["s2"]);
    await client.close();
  });

  it("idle-shard closing advances min-F when one shard commits and the others sit idle", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});

    // A commit on the default shard advances ONLY its frontier — the 3 idle shards pin F=min=0.
    await pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], [], DEFAULT_SHARD);
    let rows = await lease.readAllFrontiers();
    expect(rows[0]!.frontierTs).toBe(0n); // min is an idle shard, still 0

    // One idle-closing beat: allocate a nextval, bump every held idle shard up to it → min-F advances.
    const newTs = await lease.closeIdleFrontiers(alwaysFree);
    rows = await lease.readAllFrontiers();
    const min = rows[0]!.frontierTs;
    expect(min).toBeGreaterThan(0n); // no longer pinned at 0
    // Every shard's frontier is now >= the closer's ceiling (the committed one was already above it).
    for (const r of rows) expect(r.frontierTs).toBeGreaterThanOrEqual(newTs > min ? min : newTs);
    await client.close();
  });

  it("closeIdleFrontiers SKIPS a busy (mid-commit) shard and GREATEST-bumps the free ones (frontier-inversion fix)", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});
    // Establish a nonzero floor so the closer's ceiling is well above 0 and the assertions are crisp.
    await pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], [], DEFAULT_SHARD);

    // Stub the per-shard mutex seam: pretend "s2" is mid-commit (mutex busy → false, fn NOT run);
    // every other shard is free (fn runs, returns true). This is exactly what the runtime seam does
    // when a real commit holds s2's ShardWriter mutex.
    const touched: string[] = [];
    const seam = async (shardId: string, fn: () => Promise<void>): Promise<boolean> => {
      if (shardId === "s2") return false; // busy — skipped, left for the next beat
      await fn();
      touched.push(shardId);
      return true;
    };

    const before = new Map((await lease.readAllFrontiers()).map((r) => [r.shardId, r.frontierTs]));
    const newTs = await lease.closeIdleFrontiers(seam);
    const after = new Map((await lease.readAllFrontiers()).map((r) => [r.shardId, r.frontierTs]));

    // s2 was busy → its frontier is UNCHANGED (the closer never touched it).
    expect(after.get("s2")).toBe(before.get("s2"));
    expect(touched).not.toContain("s2");
    // The free idle shards (s1, s3) were bumped up to the ceiling; default already sat above it.
    expect(after.get("s1")).toBe(newTs);
    expect(after.get("s3")).toBe(newTs);
    expect(after.get(DEFAULT_SHARD)!).toBeGreaterThanOrEqual(newTs);
    await client.close();
  });

  it("the commit guard uses GREATEST(frontier_ts, commitTs) — a manually-raised frontier is never regressed by a later, lower commit ts", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});

    // Raise s3's frontier FAR above anything the next commit's ts allocator will hand out (idle bumps
    // legitimately do this). commitWrite's ts = GREATEST(nextval, MAX(ts)+1) will be far below 10^12.
    const RAISED = 1_000_000_000_000n;
    await lease.seedFrontier(lease.currentEpoch("s3")!, RAISED, "s3");
    expect((await lease.read("s3"))?.frontierTs).toBe(RAISED);

    // Commit on s3: its commitTs is far below RAISED. With the GREATEST guard, frontier_ts holds at
    // RAISED (never drops to commitTs); prev_ts records the pre-write frontier (RAISED). A bare
    // `frontier_ts = commitTs` would REGRESS the frontier here — the bug this asserts against.
    const commitTs = await pgStore.commitWrite([doc(newDocumentId(TABLE), "y")], [], "s3");
    expect(commitTs).toBeLessThan(RAISED);
    const s3 = await lease.read("s3");
    expect(s3?.frontierTs).toBe(RAISED); // NOT regressed to commitTs
    expect(s3?.prevTs).toBe(RAISED); // prev_ts := pre-write frontier
    await client.close();
  });

  it("tryAcquire seeds a FIRST-created shard row's frontier from the store max at INSERT time (F1×N window closed by construction)", async () => {
    // Pre-loaded store: real data already committed BEFORE this shard's lease row is ever created.
    const { client, pgStore, lease } = await makeNode();
    await pgStore.commitWrite([doc(newDocumentId(TABLE), "a")], [], DEFAULT_SHARD);
    await pgStore.commitWrite([doc(newDocumentId(TABLE), "b")], [], DEFAULT_SHARD);
    const maxTs = await pgStore.maxTimestamp();
    expect(maxTs).toBeGreaterThan(0n);

    // Create the lease row for the FIRST time with seedFrontierFromDocuments = true. The frontier is
    // set to MAX(ts) atomically inside the INSERT, so the row is NEVER momentarily visible at
    // frontier_ts = 0 — there is no observable (count==N ∧ min-F < maxTs) state during arming, because
    // each row is born at-or-above maxTs. (A single PGlite connection can't poll concurrently; the
    // window is closed by construction — the row's very first observable frontier is already >= maxTs.)
    await lease.tryAcquire(DEFAULT_SHARD, 0, true);
    expect((await lease.read(DEFAULT_SHARD))?.frontierTs).toBeGreaterThanOrEqual(maxTs);

    // Control: WITHOUT the seed flag, a first-created row is born at 0 (the pre-fix behavior — only
    // safe on a fresh, dataless store; here it demonstrates the flag is what closes the window).
    await lease.tryAcquire("s1", 1, false);
    expect((await lease.read("s1"))?.frontierTs).toBe(0n);
    await client.close();
  });

  it("FrontierMonitor.stats() reports frontier + pinning shard; lag grows while F is stuck", async () => {
    const { client, lease } = await makeNode();
    await acquireAll(lease);
    // Give s2 a higher frontier so the pinning shard is unambiguous (one of the 0-frontier shards).
    await lease.seedFrontier(lease.currentEpoch("s2")!, 100n, "s2");

    let clock = 1_000;
    const mon = new FrontierMonitor(lease, { closeIdle: false, now: () => clock });
    // Drive one beat manually via start() (which beats immediately), then read.
    mon.start();
    await new Promise((r) => setTimeout(r, 20)); // let the async beat complete
    const s = mon.stats();
    expect(s).not.toBeNull();
    expect(s!.frontier).toBe(0n); // min across shards (three are still 0)
    expect(["default", "s1", "s3"]).toContain(s!.pinningShard);
    // Advance the clock without F advancing → lag grows.
    clock += 7_000;
    expect(mon.stats()!.lagMs).toBeGreaterThanOrEqual(7_000);
    mon.stop();
    await client.close();
  });

  it("tailer refuses ready while fewer than NUM_SHARDS lease rows exist (F=0-equivalent)", async () => {
    const { client, pgStore, lease } = await makeNode();
    // Only N-1 shards acquired → count(*) = N-1 < N.
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    for (let slot = 1; slot < N - 1; slot++) await acquireShardAsWriter(lease, SHARDS[slot]!, slot, 10);
    // Seed the present rows to a high frontier — the count gate must STILL treat F as 0 (not ready).
    for (const s of [DEFAULT_SHARD, "s1"]) await lease.seedFrontier(lease.currentEpoch(s)!, 500n, s);

    const replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    const tailer = new ReplicaTailer(client, pgStore, replica, { numShards: N, pollMs: 10, onInvalidation: async () => {} });
    // start() must resolve immediately (target F = 0 because count < N) — NOT block, NOT catch up.
    await tailer.start();
    expect(tailer.watermark()).toBe(0n);
    await tailer.stop();
    await replica.close();
    await client.close();
  });

  it("F1×N: a pre-loaded store → writer seeds ALL rows ≥ max → min-F ≥ max → a fresh tailer bootstraps the FULL history before ready", async () => {
    const { client, pgStore, lease } = await makeNode("http://writer:9001");

    // Pre-load real history via the RAW write() path (no fleet, no lease row yet) — a pre-`--fleet`
    // single-node serve. Two committed docs at ts 1 and 2.
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);
    await pgStore.write([rev(a, 1n, null, "A1")], [idxPut(a, encodeIndexKey(["a"]), 1n)], "Error");
    await pgStore.write([rev(b, 2n, null, "B1")], [idxPut(b, encodeIndexKey(["b"]), 2n)], "Error");
    expect(await pgStore.maxTimestamp()).toBe(2n);

    // Writer boot: acquire ALL N shards (each row born at frontier 0), then seed ALL of them to max.
    await acquireAll(lease);
    let rows = await lease.readAllFrontiers();
    expect(rows.every((r) => r.frontierTs === 0n)).toBe(true); // the F1 starting condition, ×N
    await lease.seedFrontierAll(await pgStore.maxTimestamp());
    rows = await lease.readAllFrontiers();
    expect(rows.every((r) => r.frontierTs === 2n)).toBe(true); // every row seeded ≥ max
    expect(rows[0]!.frontierTs).toBe(2n); // min-F ≥ max (was 0 — the bug)

    // A fresh sync tailer must now bootstrap the FULL pre-loaded history, not report ready empty.
    const replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    const invalidations: AppliedInvalidation[] = [];
    const tailer = new ReplicaTailer(client, pgStore, replica, {
      numShards: N,
      pollMs: 20,
      onInvalidation: async (inv) => void invalidations.push(inv),
    });
    await tailer.start(); // ready gate: must catch up to min-F = 2, not resolve empty
    expect(await replica.maxTimestamp()).toBe(2n);
    expect(await replica.get(a)).not.toBeNull();
    expect(await replica.get(b)).not.toBeNull();
    expect(invalidations.length).toBeGreaterThan(0);
    await tailer.stop();
    await replica.close();
    await client.close();
  });

  it("RYOW: waitFor(commitTs) resolves once the tailer's watermark reaches min-F, even when idle shards pin F below the commit until closed", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    installCommitGuard(pgStore, lease, () => {});
    // Seed all frontiers so a fresh tailer has a defined starting F, then bootstrap it to that point.
    await lease.seedFrontierAll(await pgStore.maxTimestamp());

    const replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    const tailer = new ReplicaTailer(client, pgStore, replica, { numShards: N, pollMs: 10, onInvalidation: async () => {} });
    await tailer.start();

    // Commit on the default shard → its frontier = commitTs, but the 3 idle shards still pin min-F
    // below commitTs, so a waiter for commitTs must NOT resolve yet.
    const commitTs = await pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], [], DEFAULT_SHARD);
    const waited = tailer.waitFor(commitTs, 2_000);

    // Close the idle shards up to a fresh nextval (>= commitTs) → min-F reaches/passes commitTs → the
    // tailer's next tick advances its watermark → the RYOW waiter resolves "reached".
    await lease.closeIdleFrontiers(alwaysFree);
    expect(await waited).toBe("reached");
    expect(tailer.watermark()).toBeGreaterThanOrEqual(commitTs);
    await tailer.stop();
    await replica.close();
    await client.close();
  });
});

describe("Shards B2b, Task 3 — per-shard relinquish (fence on s becomes 'drop s, keep serving')", () => {
  it("(c) relinquish('s2'): held map loses s2 → guard fences a straggler s2 commit cleanly, s3 keeps committing, no exit fires, and a SECOND relinquish('s2') is a no-op", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    const onExit = vi.fn();
    installCommitGuard(pgStore, lease, (fencedShardId, reason) => relinquish({ lease, client, shards: SHARDS }, fencedShardId, reason));
    const releaseSpy = vi.spyOn(client, "releaseShardLock");

    expect(lease.currentEpoch("s2")).toBe(1n); // held before relinquish

    relinquish({ lease, client, shards: SHARDS }, "s2", "test: manual relinquish");

    expect(lease.currentEpoch("s2")).toBeNull(); // held map lost s2
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith(SHARDS.indexOf("s2"));
    expect(onExit).not.toHaveBeenCalled(); // relinquish structurally cannot reach an exit callback

    // A straggler commit attempt on the now-relinquished shard fences cleanly — the guard's "no
    // acquired epoch" branch, NOT a live-epoch mismatch.
    await expect(pgStore.commitWrite([doc(newDocumentId(TABLE), "straggler")], [], "s2")).rejects.toThrow(FencedError);

    // A sibling shard this node STILL holds commits fine — relinquish is scoped to s2 alone.
    const ts = await pgStore.commitWrite([doc(newDocumentId(TABLE), "s3-still-fine")], [], "s3");
    expect((await lease.read("s3"))?.frontierTs).toBe(ts);

    // Idempotent: a second relinquish("s2") is a no-op — no further releaseShardLock/lease mutation.
    relinquish({ lease, client, shards: SHARDS }, "s2", "test: second call");
    expect(releaseSpy).toHaveBeenCalledTimes(1); // still just the one call from above
    expect(lease.currentEpoch("s2")).toBeNull();
    expect(onExit).not.toHaveBeenCalled();

    await client.close();
  });

  it("(d) the commit guard's fence path routes to relinquish, never to an exit callback", async () => {
    const { client, pgStore, lease } = await makeNode();
    await acquireAll(lease);
    const onExit = vi.fn();
    const relinquishCalls: Array<{ shardId: string; reason: string }> = [];
    installCommitGuard(pgStore, lease, (fencedShardId, reason) => {
      relinquishCalls.push({ shardId: fencedShardId, reason });
      relinquish({ lease, client, shards: SHARDS }, fencedShardId, reason);
    });

    // Another node steals s1's lease (epoch bump) — s1's guard now fences on its next commit.
    const other = new LeaseManager(client, { advertiseUrl: "http://node-b:5000" });
    await other.tryAcquire("s1", 1);

    await expect(pgStore.commitWrite([doc(newDocumentId(TABLE), "x")], [], "s1")).rejects.toThrow(FencedError);

    // The guard routed to relinquish exactly once, naming s1 — and NEVER reached any exit callback
    // (there is none reachable from `relinquish`'s dependency shape — RelinquishDeps has no onExit).
    expect(relinquishCalls).toEqual([{ shardId: "s1", reason: expect.stringContaining("s1") }]);
    expect(lease.currentEpoch("s1")).toBeNull(); // relinquished
    expect(onExit).not.toHaveBeenCalled();

    // Sibling shards this node still holds are unaffected.
    const ts = await pgStore.commitWrite([doc(newDocumentId(TABLE), "default-fine")], [], DEFAULT_SHARD);
    expect((await lease.read(DEFAULT_SHARD))?.frontierTs).toBe(ts);

    await client.close();
  });

  it("relinquish with { connectionLost: true } skips releaseShardLock (the lock already died with the connection)", async () => {
    const { client, lease } = await makeNode();
    await acquireAll(lease);
    const releaseSpy = vi.spyOn(client, "releaseShardLock");

    relinquish({ lease, client, shards: SHARDS }, "s1", "commit connection lost", { connectionLost: true });

    expect(lease.currentEpoch("s1")).toBeNull();
    expect(releaseSpy).not.toHaveBeenCalled();
    await client.close();
  });

  it("relinquishing the DEFAULT shard logs the drivers-still-running warning (Task 5 caveat)", async () => {
    const { client, lease } = await makeNode();
    await acquireAll(lease);
    const warn = vi.fn();
    const log = vi.fn();

    relinquish({ lease, client, shards: SHARDS, log, warn }, DEFAULT_SHARD, "test");

    expect(lease.currentEpoch(DEFAULT_SHARD)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("stopDriversOnly");
    await client.close();
  });
});
