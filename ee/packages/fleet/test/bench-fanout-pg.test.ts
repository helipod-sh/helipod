/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Reactive fan-out benchmark — real-Postgres variant. The store-agnostic harness (`runFanoutBench`)
 * lives in `@stackbase/test`; here we drive it against a real native PostgreSQL 16 postmaster
 * (embedded-postgres — no Docker; `NodePgClient` + per-shard commit pool, wired like a production
 * writer — mirrors `bench-commit.test.ts`).
 *
 * Why here and not in packages/test: it needs `@stackbase/docstore-postgres`, which itself depends on
 * `@stackbase/test` — so adding docstore-postgres to packages/test would create a build cycle. ee/fleet
 * already depends on docstore-postgres (no cycle), and it's the right license home for a PG-scale
 * (Tier-2) benchmark. embedded-postgres-gated + opt-in (`STACKBASE_BENCH_FANOUT_PG=1`). N ≤ 1000 cap:
 * seeding 10 000 channels/subscriptions over real PG is prohibitively slow (documented, not silent
 * truncation). See docs/dev/research/reactivity/fanout-benchmark.md.
 */
import { describe, it, expect, afterAll } from "vitest";
import { runFanoutBench, type FanoutBenchResult } from "@stackbase/test";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@stackbase/docstore-postgres/test-support/embedded-pg";
import { shardIdList } from "@stackbase/id-codec";

let pgServer: EmbeddedPg | undefined;

async function startPgContainer(): Promise<{ port: number }> {
  pgServer = await startEmbeddedPg();
  return { port: pgServer.port };
}

/** A real-PG store wired like a production writer (`NodePgClient` + per-shard commit pool), the same
 *  way bench-commit's `buildRealPgStore` does. numShards=1 (fan-out isolates reactivity, not write
 *  sharding). Caller closes the client. */
function buildPgStore(databaseUrl: string): { store: PostgresDocStore; client: NodePgClient } {
  const client = new NodePgClient({
    connectionString: databaseUrl,
    applicationName: "stackbase-fanout-bench",
    commitPool: { shards: shardIdList(1) },
  });
  return { store: new PostgresDocStore(client), client };
}

const RUN_PG = embeddedPgAvailable() && process.env["STACKBASE_BENCH_FANOUT_PG"] === "1";
const pgDescribe = RUN_PG ? describe : describe.skip;

pgDescribe("bench-fanout — real Postgres (opt-in: STACKBASE_BENCH_FANOUT_PG=1 + embedded-postgres)", () => {
  afterAll(async () => {
    await pgServer?.stop();
    pgServer = undefined;
  });

  it("reduced matrix (N<=1000) over real Postgres — prints the table", async () => {
    const { port } = await startPgContainer();
    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

    const specs: Array<{ subscriptions: number; shape: "broadcast" | "selective" }> = [];
    for (const shape of ["broadcast", "selective"] as const) {
      for (const subscriptions of [100, 1_000]) specs.push({ subscriptions, shape });
    }

    const rows: Array<{ subscriptions: number; shape: string; result: FanoutBenchResult }> = [];
    let idx = 0;
    for (const spec of specs) {
      const { store, client } = buildPgStore(databaseUrl);
      try {
        const result = await runFanoutBench({
          ...spec,
          queryCost: "point",
          seconds: 5,
          warmupMs: 2000,
          store,
          channelPrefix: `pg${idx}_`, // distinct channels per cell (shared database)
        });
        rows.push({ ...spec, result });
        expect(result.errors).toBe(0);
        expect(result.reRunsPerSec).toBeGreaterThan(0);
      } finally {
        await client.close();
      }
      idx += 1;
    }

    // eslint-disable-next-line no-console
    console.log("\n=== Reactive fan-out benchmark (real Postgres, this machine) — N<=1000 cap ===");
    // eslint-disable-next-line no-console
    console.log("subs   | shape      | reRuns/s | propP50 | propP99 | ELU   | writes/s | matchedAvg");
    for (const row of rows) {
      const r = row.result;
      // eslint-disable-next-line no-console
      console.log(
        `${String(row.subscriptions).padStart(6)} | ${row.shape.padEnd(10)} | ` +
          `${r.reRunsPerSec.toFixed(0).padStart(8)} | ${r.propP50Ms.toFixed(2).padStart(7)} | ` +
          `${r.propP99Ms.toFixed(2).padStart(7)} | ${r.eluDuringStorm.toFixed(3).padStart(5)} | ` +
          `${r.writesPerSec.toFixed(0).padStart(8)} | ${r.subsMatchedAvg.toFixed(1).padStart(10)}`,
      );
    }
  }, 600_000);
});
