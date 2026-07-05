/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * `reshardFleet` (B5 Part 1, Task 9.1) against a REAL native PostgreSQL 16 postmaster
 * (embedded-postgres — no Docker), per the 3-tier substrate rule for lease semantics. Covers the
 * plan's three gate scenarios: grow (9.1a), shrink (9.1b), and refuse-on-live (9.1c).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { NodePgClient, PostgresDocStore } from "@helipod/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@helipod/docstore-postgres/test-support/embedded-pg";
import { shardIdList } from "@helipod/id-codec";
import { LeaseManager } from "../src/lease";
import {
  reshardFleet,
  ReshardFleetLiveError,
  ReshardVerificationError,
  ReshardNotAFleetError,
  NUM_SHARDS_GLOBAL_KEY,
} from "../src/reshard";

const maybeDescribe = embeddedPgAvailable() ? describe : describe.skip;

maybeDescribe("reshardFleet (embedded PostgreSQL 16)", () => {
  let pg: EmbeddedPg;
  let client: NodePgClient;

  beforeAll(async () => {
    pg = await startEmbeddedPg();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    client = new NodePgClient({ connectionString: pg.url, applicationName: "reshard-test" });
    // Fresh schema per test — isolates each scenario's shard_leases/fleet_nodes/documents state.
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });

  afterEach(async () => {
    await client.close();
  });

  /** Seed a stopped fleet store: full docstore schema (documents/persistence_globals/…) via
   *  `PostgresDocStore.setupSchema()`, an optional single `documents` row at `ts = documentMaxTs`
   *  (so `MAX(ts)` is deterministic), `shard_leases`/`fleet_nodes` via `LeaseManager.setup()`
   *  pre-seeded for `shardIdList(numShards)` (byte-identical to a real fleet boot), and the
   *  `fleet:numShards` global written the same way `resolveNumShards` persists it. No live nodes. */
  async function seedStoppedFleet(opts: { numShards: number; documentMaxTs?: bigint }): Promise<void> {
    const store = new PostgresDocStore(client);
    await store.setupSchema();

    if (opts.documentMaxTs !== undefined) {
      await client.query(
        `INSERT INTO documents (table_id, internal_id, ts, value) VALUES ($1, $2, $3, $4)`,
        ["t1", new Uint8Array([1]), opts.documentMaxTs, "null"],
      );
    }

    const lease = new LeaseManager(client, { advertiseUrl: "http://seed:0" });
    await lease.setup(shardIdList(opts.numShards), opts.documentMaxTs !== undefined);

    await client.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [NUM_SHARDS_GLOBAL_KEY, JSON.stringify(String(opts.numShards))],
    );
  }

  async function readLaneIds(): Promise<string[]> {
    const rows = await client.query(`SELECT shard_id FROM shard_leases ORDER BY shard_id`);
    return rows.map((r) => r.shard_id as string).sort();
  }

  async function readGlobalNumShards(): Promise<number> {
    const rows = await client.query(`SELECT value FROM persistence_globals WHERE key = $1`, [NUM_SHARDS_GLOBAL_KEY]);
    return Number(JSON.parse(rows[0]!.value as string));
  }

  it("9.1a grows 2→4: new lanes seeded at MAX(ts), existing lanes/frontiers untouched, global reads 4", async () => {
    const T = 123_456n;
    await seedStoppedFleet({ numShards: 2, documentMaxTs: T });

    const before = await client.query(`SELECT shard_id, frontier_ts FROM shard_leases`);
    const beforeFrontier = new Map(before.map((r) => [r.shard_id as string, r.frontier_ts as bigint]));
    expect(beforeFrontier.get("default")).toBe(T);
    expect(beforeFrontier.get("s1")).toBe(T);

    const result = await reshardFleet(client, { targetShards: 4 });

    expect(result.previousShards).toBe(2);
    expect(result.newShards).toBe(4);
    expect(result.created.slice().sort()).toEqual(["s2", "s3"]);
    expect(result.deleted).toEqual([]);

    expect(await readLaneIds()).toEqual(shardIdList(4).slice().sort());
    expect(await readGlobalNumShards()).toBe(4);

    const after = await client.query(`SELECT shard_id, frontier_ts FROM shard_leases`);
    const afterFrontier = new Map(after.map((r) => [r.shard_id as string, r.frontier_ts as bigint]));
    // New lanes are born at MAX(ts) = T.
    expect(afterFrontier.get("s2")).toBe(T);
    expect(afterFrontier.get("s3")).toBe(T);
    // Existing lanes' frontier_ts is completely unchanged by the reshard.
    expect(afterFrontier.get("default")).toBe(beforeFrontier.get("default"));
    expect(afterFrontier.get("s1")).toBe(beforeFrontier.get("s1"));

    expect(BigInt(result.frontierFloor)).toBeGreaterThanOrEqual(T);
  });

  it("9.1b shrinks 4→2: s2/s3 deleted, default/s1 retained, global reads 2, min-frontier does not regress", async () => {
    const T = 999n;
    await seedStoppedFleet({ numShards: 4, documentMaxTs: T });

    const beforeMin = await client.query(`SELECT MIN(frontier_ts) AS m FROM shard_leases`);
    const minBefore = beforeMin[0]!.m as bigint;

    const result = await reshardFleet(client, { targetShards: 2 });

    expect(result.previousShards).toBe(4);
    expect(result.newShards).toBe(2);
    expect(result.created).toEqual([]);
    expect(result.deleted.slice().sort()).toEqual(["s2", "s3"]);

    // "default" is never deleted, and the retained set is exactly shardIdList(2).
    expect(await readLaneIds()).toEqual(shardIdList(2).slice().sort());
    expect(await readGlobalNumShards()).toBe(2);

    expect(BigInt(result.frontierFloor)).toBeGreaterThanOrEqual(minBefore);
  });

  it("9.1c refuses a live fleet (fleet_nodes row unexpired): throws ReshardFleetLiveError, no partial effect", async () => {
    await seedStoppedFleet({ numShards: 2 });
    await client.query(
      `INSERT INTO fleet_nodes (advertise_url, epoch, expires_at) VALUES ($1, 1, now() + interval '30 seconds')`,
      ["http://writer-a:4000"],
    );

    const lanesBefore = await readLaneIds();
    const globalBefore = await readGlobalNumShards();

    await expect(reshardFleet(client, { targetShards: 4 })).rejects.toThrow(ReshardFleetLiveError);

    let caught: unknown;
    try {
      await reshardFleet(client, { targetShards: 4 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReshardFleetLiveError);
    expect((caught as ReshardFleetLiveError).liveUrls).toEqual(["http://writer-a:4000"]);
    expect((caught as Error).message).toContain("http://writer-a:4000");

    // No partial effect: shard_leases + the global are byte-identical to before the refused call.
    expect(await readLaneIds()).toEqual(lanesBefore);
    expect(await readGlobalNumShards()).toBe(globalBefore);
  });

  it("9.1c also refuses when a shard_leases row itself has a live writer_url (no fleet_nodes row)", async () => {
    await seedStoppedFleet({ numShards: 2 });
    await client.query(
      `UPDATE shard_leases SET writer_url = $1, expires_at = now() + interval '30 seconds' WHERE shard_id = 'default'`,
      ["http://writer-b:4000"],
    );

    await expect(reshardFleet(client, { targetShards: 4 })).rejects.toThrow(ReshardFleetLiveError);
  });

  it("rejects targetShards < 1 with a RangeError before touching the database", async () => {
    await seedStoppedFleet({ numShards: 2 });
    await expect(reshardFleet(client, { targetShards: 0 })).rejects.toThrow(RangeError);
    await expect(reshardFleet(client, { targetShards: -3 })).rejects.toThrow(RangeError);
    // Untouched — the store still reads 2 shards.
    expect(await readGlobalNumShards()).toBe(2);
  });

  it("is idempotent when the target already matches: no created/deleted lanes, global unchanged", async () => {
    await seedStoppedFleet({ numShards: 3, documentMaxTs: 42n });
    const result = await reshardFleet(client, { targetShards: 3 });
    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);
    expect(result.previousShards).toBe(3);
    expect(result.newShards).toBe(3);
    expect(await readLaneIds()).toEqual(shardIdList(3).slice().sort());
  });

  it("9.4 crash-stop: a RETAINED lane lagging MAX(ts) is healed to the floor, not a false verify failure", async () => {
    // Whole-branch review finding (IMPORTANT): the post-verify's min(frontier_ts) >= MAX(ts) check
    // used to be a best-effort check, not a true post-condition — reshard only seeds NEW lanes at
    // MAX(ts) and never touched a RETAINED lane's frontier. A crash stop (kill -9, no selfFence run)
    // can leave a retained lane's frontier BELOW MAX(ts) with no live nodes (leases simply expire),
    // so the gate passes but the tx would then commit successfully and the post-verify would still
    // throw — a false "reshard failed" even though the surgery landed durably. The fix: GREATEST-
    // bump every lane (including retained ones) up to the MAX(ts) floor inside the same tx.
    const T = 5_000n;
    await seedStoppedFleet({ numShards: 2, documentMaxTs: T });

    // Simulate the crash-stop lag directly: "default" is retained (targetShards stays 2 below), so
    // this row is never touched by the tx's INSERT/DELETE — only the new GREATEST-bump reaches it.
    await client.query(`UPDATE shard_leases SET frontier_ts = $1 WHERE shard_id = 'default'`, [T - 1_000n]);

    const before = await client.query(`SELECT shard_id, frontier_ts FROM shard_leases`);
    const beforeDefault = before.find((r) => r.shard_id === "default")!.frontier_ts as bigint;
    expect(beforeDefault).toBe(T - 1_000n);

    // Same target (2 -> 2): both lanes are RETAINED, created=[]/deleted=[] — isolates the healing
    // behavior from the create/delete paths already covered above.
    const result = await reshardFleet(client, { targetShards: 2 });

    expect(result.created).toEqual([]);
    expect(result.deleted).toEqual([]);

    const after = await client.query(`SELECT shard_id, frontier_ts FROM shard_leases`);
    for (const row of after) {
      expect(row.frontier_ts as bigint).toBeGreaterThanOrEqual(T);
    }
    // The lagging "default" lane was specifically healed up to the floor.
    expect(after.find((r) => r.shard_id === "default")!.frontier_ts as bigint).toBe(T);
    expect(BigInt(result.frontierFloor)).toBeGreaterThanOrEqual(T);
  });

  it("9.4 not-a-fleet: a Postgres database with no shard_leases/fleet_nodes throws a clear error, not a raw relation-does-not-exist", async () => {
    // Whole-branch review finding (MINOR, DX): deliberately do NOT call seedStoppedFleet — this
    // schema has neither shard_leases nor fleet_nodes (the beforeEach's DROP/CREATE SCHEMA leaves it
    // completely bare, not even persistence_globals/documents from setupSchema()).
    await expect(reshardFleet(client, { targetShards: 4 })).rejects.toThrow(ReshardNotAFleetError);

    let caught: unknown;
    try {
      await reshardFleet(client, { targetShards: 4 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReshardNotAFleetError);
    expect((caught as Error).message).toContain("not a fleet store");
    expect((caught as Error).message).toContain("helipod serve --fleet");
    expect((caught as Error).message).not.toContain("relation");
  });
});

// Sanity: the exported error classes carry the right `name` (used by callers doing string-based
// error routing, e.g. a CLI catch block) independent of the embedded-PG gate.
describe("reshard error classes", () => {
  it("ReshardFleetLiveError / ReshardVerificationError / ReshardNotAFleetError set .name to their class name", () => {
    expect(new ReshardFleetLiveError(["http://a"]).name).toBe("ReshardFleetLiveError");
    expect(new ReshardVerificationError("x").name).toBe("ReshardVerificationError");
    expect(new ReshardNotAFleetError().name).toBe("ReshardNotAFleetError");
  });
});
