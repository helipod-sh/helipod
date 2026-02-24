/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 9.3 (B5 Part 1) — the headline E2E: a STOPPED fleet resharded N→M comes back up at M with
 * EVERY lane writable (each acquires + commits + advances its frontier) and all pre-reshard
 * committed data intact. Against a REAL native PostgreSQL 16 postmaster (embedded-postgres, no
 * Docker/PGlite), per the 3-tier substrate rule for lease semantics.
 *
 * Proof shape used — the plan's PREFERRED "lighter proof" (`docs/superpowers/plans/
 * 2026-07-14-fleet-reshard-b5.md`, Task 9.3): after `reshardFleet`, a fresh `LeaseManager` (a new
 * writer node coming back up) `tryAcquire`s EVERY lane in `shardIdList(M)` (epoch 0->1 for the new
 * lanes, epoch bump for the retained ones), a real `PostgresDocStore.commitWrite` routed to each
 * lane via `installCommitGuard` advances that lane's `shard_leases.frontier_ts`, and the
 * pre-reshard committed `documents` rows are still readable via `pgStore.get` — proving the reshard
 * produced a working M-shard fleet, not just row surgery on `shard_leases`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@stackbase/docstore-postgres/test-support/embedded-pg";
import { newDocumentId, shardIdList, DEFAULT_SHARD, type ShardId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { LeaseManager } from "../src/lease";
import { installCommitGuard } from "../src/node";
import { reshardFleet, NUM_SHARDS_GLOBAL_KEY } from "../src/reshard";

const maybeDescribe = embeddedPgAvailable() ? describe : describe.skip;
const TABLE = 30099;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

/** Acquire every shard in `shardIds` for `lease` (slot = index — irrelevant without a commit pool;
 *  `NodePgClient` constructed without `commitPool` falls back to the legacy, session-reentrant
 *  `tryAcquireWriterLock`, so N sequential acquisitions on the same connection all succeed, exactly
 *  as `n-shards.test.ts`'s `acquireAll` relies on). Returns the acquired epoch per shard. */
async function acquireAllLanes(
  lease: LeaseManager,
  shardIds: readonly ShardId[],
  seedFrontierFromDocuments: boolean,
): Promise<void> {
  await lease.setup(); // idempotent DDL (shard_leases/fleet_nodes/fleet_idempotency) — no-op if already present
  for (let slot = 0; slot < shardIds.length; slot++) {
    const state = await lease.tryAcquire(shardIds[slot]!, slot, seedFrontierFromDocuments);
    if (!state) throw new Error(`test setup: failed to acquire lane ${shardIds[slot]}`);
  }
}

async function writeNumShardsGlobal(client: NodePgClient, n: number): Promise<void> {
  await client.query(
    `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [NUM_SHARDS_GLOBAL_KEY, JSON.stringify(String(n))],
  );
}

maybeDescribe("fleet reshard E2E: stop -> reshard -> every new lane writable (embedded PostgreSQL 16)", () => {
  let pg: EmbeddedPg;
  let client: NodePgClient;

  beforeAll(async () => {
    pg = await startEmbeddedPg();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    client = new NodePgClient({ connectionString: pg.url, applicationName: "reshard-e2e" });
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });

  afterEach(async () => {
    await client.close();
  });

  it("N=2 -> M=5: every new AND retained lane is acquirable+writable post-reshard, and pre-reshard data survives untouched", async () => {
    const N = 2;
    const M = 5;
    const originalLanes = shardIdList(N);
    const targetLanes = shardIdList(M);

    // --- Bring up a real fleet writer node at N shards -----------------------------------------
    const pgStore = new PostgresDocStore(client);
    await pgStore.setupSchema();
    const writer1 = new LeaseManager(client, { advertiseUrl: "http://writer-1:4000" });
    await acquireAllLanes(writer1, originalLanes, false); // fresh store — no history to seed from yet
    const unregisterWriter1Guard = installCommitGuard(pgStore, writer1, () => {});
    await writeNumShardsGlobal(client, N);

    // Commit real pre-reshard data on EVERY original lane, so a per-lane "was the log untouched?"
    // check is meaningful for both lanes, not just the default one.
    const preReshardIds: InternalDocumentId[] = [];
    for (const laneId of originalLanes) {
      const id = newDocumentId(TABLE);
      await pgStore.commitWrite([doc(id, `pre-${laneId}`)], [], laneId);
      preReshardIds.push(id);
    }
    const maxTsBeforeReshard = await pgStore.maxTimestamp();
    expect(maxTsBeforeReshard).toBeGreaterThan(0n);

    // --- STOP the fleet: gracefully relinquish every held lane (clears writer_url, bumps epoch) --
    for (const laneId of originalLanes) await writer1.selfFence(laneId);
    unregisterWriter1Guard(); // else writer1's now-stale-epoch guard stacks and fences writer2's commits
    // No fleet_nodes presence rows were ever created (heartbeatPresence() was never called), and
    // every shard_leases row is now writer_url IS NULL — the stopped-fleet precondition holds.

    // --- Reshard N -> M -------------------------------------------------------------------------
    const result = await reshardFleet(client, { targetShards: M });
    expect(result.previousShards).toBe(N);
    expect(result.newShards).toBe(M);
    expect(result.created.slice().sort()).toEqual(["s2", "s3", "s4"]);
    expect(await client.query(`SELECT shard_id FROM shard_leases ORDER BY shard_id`).then((rows) => rows.length)).toBe(M);

    // --- Bring up a FRESH writer node at M shards -------------------------------------------------
    const writer2 = new LeaseManager(client, { advertiseUrl: "http://writer-2:5000" });
    await acquireAllLanes(writer2, targetLanes, false);
    // Every lane — retained (default, s1) AND newly-created (s2, s3, s4) — is freshly acquired by
    // this brand-new writer identity. Newly-created lanes start UNACQUIRED at epoch 0 (the reshard's
    // seed row shape), so their first real acquisition bumps epoch 0 -> 1; retained lanes were
    // already bumped once by writer1's `selfFence` (epoch+1), so writer2's acquisition bumps them
    // again -> epoch 3. Either way, `currentEpoch` being non-null (successfully cached) IS the
    // acquisition proof — the exact epoch value is bookkeeping, not the thing under test.
    for (const laneId of targetLanes) {
      expect(writer2.currentEpoch(laneId)).not.toBeNull();
      expect(writer2.currentEpoch(laneId)!).toBeGreaterThan(0n);
    }
    expect(writer2.currentEpoch(DEFAULT_SHARD)).toBe(3n); // retained: acquire(1) -> selfFence(2) -> re-acquire(3)
    expect(writer2.currentEpoch("s2")).toBe(1n); // newly-created: born at epoch 0 -> first acquire(1)
    installCommitGuard(pgStore, writer2, () => {});

    // --- Smoke commit per lane: EVERY lane in shardIdList(M) is writable + its frontier advances --
    for (const laneId of targetLanes) {
      const before = await writer2.read(laneId);
      expect(before).not.toBeNull();
      const preFrontier = before!.frontierTs;

      const id = newDocumentId(TABLE);
      const commitTs = await pgStore.commitWrite([doc(id, `post-${laneId}`)], [], laneId);

      const after = await writer2.read(laneId);
      expect(after).not.toBeNull();
      expect(after!.frontierTs).toBe(commitTs); // the guard advanced THIS lane's frontier to the commit
      expect(after!.frontierTs).toBeGreaterThan(preFrontier); // strictly forward, not just unchanged

      // Round-trip readable through the store, proving the lane is genuinely committing real rows.
      const readBack = await pgStore.get(id);
      expect(readBack).not.toBeNull();
      expect(readBack!.value.value).toEqual({ body: `post-${laneId}` });
    }

    // --- Pre-reshard data intact: the log was untouched by the reshard (no rows moved/mutated) -----
    for (let i = 0; i < originalLanes.length; i++) {
      const readBack = await pgStore.get(preReshardIds[i]!);
      expect(readBack).not.toBeNull();
      expect(readBack!.value.value).toEqual({ body: `pre-${originalLanes[i]}` });
    }
    expect(await pgStore.maxTimestamp()).toBeGreaterThanOrEqual(maxTsBeforeReshard);
  });

  it("shrink then grow (N=4 -> M=2 -> M2=6): the surviving-then-recreated lane set is fully writable and shrink-time-deleted data was never referenced (decorative shard_id)", async () => {
    const N = 4;
    const originalLanes = shardIdList(N);

    const pgStore = new PostgresDocStore(client);
    await pgStore.setupSchema();
    const writer1 = new LeaseManager(client, { advertiseUrl: "http://writer-a:4000" });
    await acquireAllLanes(writer1, originalLanes, false);
    const unregisterWriter1Guard = installCommitGuard(pgStore, writer1, () => {});
    await writeNumShardsGlobal(client, N);

    const preIds: InternalDocumentId[] = [];
    for (const laneId of originalLanes) {
      const id = newDocumentId(TABLE);
      await pgStore.commitWrite([doc(id, `v1-${laneId}`)], [], laneId);
      preIds.push(id);
    }

    for (const laneId of originalLanes) await writer1.selfFence(laneId);
    unregisterWriter1Guard();

    // Shrink to 2 (drops s2/s3's LANES — the log rows committed on those lanes are untouched, since
    // `documents.shard_id` is decorative and nothing reads it for correctness).
    const shrink = await reshardFleet(client, { targetShards: 2 });
    expect(shrink.deleted.slice().sort()).toEqual(["s2", "s3"]);

    // Grow back to 6 from the shrunk state.
    const grow = await reshardFleet(client, { targetShards: 6 });
    expect(grow.previousShards).toBe(2);
    expect(grow.newShards).toBe(6);
    const finalLanes = shardIdList(6);

    const writer2 = new LeaseManager(client, { advertiseUrl: "http://writer-b:5000" });
    await acquireAllLanes(writer2, finalLanes, false);
    installCommitGuard(pgStore, writer2, () => {});

    for (const laneId of finalLanes) {
      const before = (await writer2.read(laneId))!.frontierTs;
      const id = newDocumentId(TABLE);
      const commitTs = await pgStore.commitWrite([doc(id, `v2-${laneId}`)], [], laneId);
      const after = (await writer2.read(laneId))!.frontierTs;
      expect(after).toBe(commitTs);
      expect(after).toBeGreaterThan(before);
      expect((await pgStore.get(id))!.value.value).toEqual({ body: `v2-${laneId}` });
    }

    // ALL original pre-reshard documents (including those committed on the since-deleted s2/s3
    // lanes) are still readable byte-for-byte — the reshard never moves/mutates the log.
    for (let i = 0; i < originalLanes.length; i++) {
      const readBack = await pgStore.get(preIds[i]!);
      expect(readBack).not.toBeNull();
      expect(readBack!.value.value).toEqual({ body: `v1-${originalLanes[i]}` });
    }
  });

  it("the default lane survives every reshard and stays writable (never deleted, per the reshard invariant)", async () => {
    const pgStore = new PostgresDocStore(client);
    await pgStore.setupSchema();
    const writer1 = new LeaseManager(client, { advertiseUrl: "http://writer-1:4000" });
    await writer1.setup();
    await writer1.tryAcquire(DEFAULT_SHARD, 0, false);
    const unregisterWriter1Guard = installCommitGuard(pgStore, writer1, () => {});
    await writeNumShardsGlobal(client, 1);
    await pgStore.commitWrite([doc(newDocumentId(TABLE), "solo")], [], DEFAULT_SHARD);
    await writer1.selfFence(DEFAULT_SHARD);
    unregisterWriter1Guard();

    await reshardFleet(client, { targetShards: 8 });

    const writer2 = new LeaseManager(client, { advertiseUrl: "http://writer-2:5000" });
    const state = await writer2.tryAcquire(DEFAULT_SHARD, 0, false);
    expect(state).not.toBeNull();
    installCommitGuard(pgStore, writer2, () => {});
    const commitTs = await pgStore.commitWrite([doc(newDocumentId(TABLE), "after")], [], DEFAULT_SHARD);
    expect((await writer2.read(DEFAULT_SHARD))!.frontierTs).toBe(commitTs);
  });
});
