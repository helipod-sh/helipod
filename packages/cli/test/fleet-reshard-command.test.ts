/**
 * `helipod fleet reshard` (B5 Part 1, Task 9.2): arg parsing/gate (9.2a, no PG needed) + the
 * happy path through the real CLI command against embedded PostgreSQL (9.2b), per the 3-tier
 * substrate rule for lease semantics.
 */
import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach } from "vitest";
import { fleetCommand, parseReshardArgs, FLEET_ERR_NO_PACKAGE } from "../src/fleet";
import { NodePgClient, PostgresDocStore } from "@helipod/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@helipod/docstore-postgres/test-support/embedded-pg";
import { shardIdList } from "@helipod/id-codec";
import { LeaseManager, NUM_SHARDS_GLOBAL_KEY } from "@helipod/fleet";

describe("parseReshardArgs — 9.2a arg parsing", () => {
  const saved = process.env.HELIPOD_DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.HELIPOD_DATABASE_URL;
    else process.env.HELIPOD_DATABASE_URL = saved;
  });

  it("rejects missing --shards", () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const r = parseReshardArgs(["--database-url", "postgres://x/db"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--shards/);
  });

  it("rejects --shards 0", () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const r = parseReshardArgs(["--shards", "0", "--database-url", "postgres://x/db"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/>= 1/);
  });

  it("rejects a non-integer --shards", () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const r = parseReshardArgs(["--shards", "abc", "--database-url", "postgres://x/db"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/>= 1/);
  });

  it("rejects missing --database-url (and no env fallback)", () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const r = parseReshardArgs(["--shards", "4"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--database-url/);
  });

  it("rejects a non-Postgres --database-url", () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const r = parseReshardArgs(["--shards", "4", "--database-url", "./data/db.sqlite"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/postgres/);
  });

  it("falls back to HELIPOD_DATABASE_URL when --database-url is absent", () => {
    process.env.HELIPOD_DATABASE_URL = "postgres://env/db";
    const r = parseReshardArgs(["--shards", "4"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args.databaseUrl).toBe("postgres://env/db");
  });

  it("accepts valid flags, flag wins over env", () => {
    process.env.HELIPOD_DATABASE_URL = "postgres://env/db";
    const r = parseReshardArgs(["--shards", "4", "--database-url", "postgres://flag/db"]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.args).toEqual({ targetShards: 4, databaseUrl: "postgres://flag/db" });
  });
});

describe("fleetCommand — 9.2a dispatch/gate (no PG needed)", () => {
  const saved = process.env.HELIPOD_DATABASE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.HELIPOD_DATABASE_URL;
    else process.env.HELIPOD_DATABASE_URL = saved;
  });

  it("unknown subcommand → usage error + exit 1", async () => {
    const code = await fleetCommand(["bogus"]);
    expect(code).toBe(1);
  });

  it("absent subcommand → usage error + exit 1", async () => {
    const code = await fleetCommand([]);
    expect(code).toBe(1);
  });

  it("reshard without --shards → exit 1, never reaches the fleet-package gate", async () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const code = await fleetCommand(["reshard", "--database-url", "postgres://x/db"]);
    expect(code).toBe(1);
  });

  it("reshard without --database-url → exit 1", async () => {
    delete process.env.HELIPOD_DATABASE_URL;
    const code = await fleetCommand(["reshard", "--shards", "4"]);
    expect(code).toBe(1);
  });

  // The `@helipod/fleet`-missing gate itself (FLEET_ERR_NO_PACKAGE) mirrors `serve --fleet`'s own
  // dynamic-import gate — covered by that command's `fleet-flags.test.ts` pattern. `@helipod/fleet`
  // is a real devDependency here (needed for the 9.2b embedded-PG test below), so the "package
  // missing" branch can't be exercised in-process without uninstalling it; the constant is asserted
  // directly so the message text stays pinned.
  it("FLEET_ERR_NO_PACKAGE message is the expected actionable text", () => {
    expect(FLEET_ERR_NO_PACKAGE).toMatch(/@helipod\/fleet/);
  });
});

const maybeDescribe = embeddedPgAvailable() ? describe : describe.skip;

maybeDescribe("fleetCommand — 9.2b happy path (embedded PostgreSQL 16)", () => {
  let pg: EmbeddedPg;
  let client: NodePgClient;

  beforeAll(async () => {
    pg = await startEmbeddedPg();
  }, 60_000);

  afterAll(async () => {
    await pg?.stop();
  });

  beforeEach(async () => {
    client = new NodePgClient({ connectionString: pg.url, applicationName: "fleet-reshard-command-test" });
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
  });

  afterEach(async () => {
    await client.close();
  });

  /** Seed a stopped fleet store — mirrors `ee/packages/fleet/test/reshard.test.ts`'s helper. */
  async function seedStoppedFleet(opts: { numShards: number }): Promise<void> {
    const store = new PostgresDocStore(client);
    await store.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://seed:0" });
    await lease.setup(shardIdList(opts.numShards), false);
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

  it("reshards a stopped 2-shard fleet to 4 via the real CLI command", async () => {
    await seedStoppedFleet({ numShards: 2 });

    const code = await fleetCommand(["reshard", "--shards", "4", "--database-url", pg.url]);
    expect(code).toBe(0);

    expect(await readLaneIds()).toEqual(shardIdList(4).slice().sort());
    expect(await readGlobalNumShards()).toBe(4);
  });

  it("refuses a live fleet: exit 1 with the refuse message, store unchanged", async () => {
    await seedStoppedFleet({ numShards: 2 });
    await client.query(
      `INSERT INTO fleet_nodes (advertise_url, epoch, expires_at) VALUES ($1, 1, now() + interval '30 seconds')`,
      ["http://writer-a:4000"],
    );
    const lanesBefore = await readLaneIds();
    const globalBefore = await readGlobalNumShards();

    const code = await fleetCommand(["reshard", "--shards", "4", "--database-url", pg.url]);
    expect(code).toBe(1);

    expect(await readLaneIds()).toEqual(lanesBefore);
    expect(await readGlobalNumShards()).toBe(globalBefore);
  });
});
