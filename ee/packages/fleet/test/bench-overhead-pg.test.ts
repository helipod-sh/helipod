/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Overhead ladder — an apples-to-apples answer to "how much does Stackbase's transaction layer cost
 * OVER raw Postgres?". Same container, same `pg` driver, same measurement loop; three rungs of
 * increasing work, one document write each:
 *
 *   1. RAW INSERT  — `client.query("INSERT INTO bench_raw …")`: one SQL statement, autocommit. The
 *                    bare single-row ceiling through OUR driver + loop (not pgbench's C harness — we
 *                    want the same driver on every rung so only the WORK differs).
 *   2. STORE COMMIT — `store.commitWrite([doc], [])`: the real MVCC-log commit path (allocate ts via
 *                    nextval → INSERT the document revision → commit guard → COMMIT), with NO executor,
 *                    NO OCC, NO index, NO reactivity. Isolates the "commit envelope" over a raw insert.
 *   3. FULL MUTATION — `runtime.run("bench:insert")`: the whole stack — executor runs the JS handler,
 *                    builds the read/write set, the transactor's OCC path commits doc + by_creation
 *                    index.
 *
 * The gaps are the story: 1→2 = the MVCC commit envelope (extra statements + ts allocation + guard);
 * 2→3 = executor + OCC + index maintenance. A "correct" implementation shows each rung a *modest*
 * multiple of the one below (matching the structural ~3–4-round-trips-per-commit model); a rung that
 * explodes flags a hidden inefficiency. Pairs with the reactivity fan-out finding that the engine is
 * I/O-bound on PG (low CPU) — this ladder shows where the I/O goes.
 *
 * Docker-gated + opt-in (STACKBASE_BENCH_OVERHEAD=1). Single-client sequential (clients=1) — the ladder
 * isolates PER-OP overhead, not concurrency. See docs/dev/research/overhead-ladder.md.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { PostgresDocStore, NodePgClient } from "@stackbase/docstore-postgres";
import type { DocumentValue } from "@stackbase/docstore";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SimpleIndexCatalog, mutation, type RegisteredFunction } from "@stackbase/executor";
import { newDocumentId, shardIdList } from "@stackbase/id-codec";

const BENCH_TABLE = 40701;

function freshCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("bench", BENCH_TABLE, undefined, false);
  return catalog;
}
function benchModules(): Record<string, RegisteredFunction> {
  return {
    "bench:insert": mutation<{ body: string }, string>({
      handler: (ctx, { body }) => ctx.db.insert("bench", { body }),
    }),
  };
}

/* --- Docker container helpers (mirror bench-commit.test.ts) --- */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function dockerAvailable(): boolean {
  try {
    return spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
function runDocker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const CONTAINER = `sb-overhead-bench-${process.pid}`;
async function startPgContainer(): Promise<{ port: number }> {
  runDocker(["rm", "-f", CONTAINER]);
  const run = runDocker([
    "run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_PASSWORD=postgres",
    "-p", "127.0.0.1::5432",
    "postgres:16",
  ]);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
  const portRes = runDocker(["port", CONTAINER, "5432/tcp"]);
  const m = (portRes.stdout.trim().split("\n")[0] ?? "").match(/:(\d+)$/);
  if (!m) throw new Error(`could not parse docker port: ${JSON.stringify(portRes.stdout)}`);
  const port = Number(m[1]);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (runDocker(["exec", CONTAINER, "pg_isready", "-U", "postgres"]).status === 0) break;
    if (Date.now() > deadline) throw new Error("postgres container did not become ready within 60s");
    await sleep(500);
  }
  return { port };
}

/* --- measurement: single-client sequential warmup+measure loop --- */
function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  return sortedMs[Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length))]!;
}
interface RungResult { opsPerSec: number; p50Ms: number; p99Ms: number; elu: number; }
async function measure(op: () => Promise<void>, seconds = 3, warmupMs = 1000): Promise<RungResult> {
  const lat: number[] = [];
  let ops = 0;
  let measuring = false;
  const start = Date.now();
  const measStart = start + warmupMs;
  const measEnd = measStart + seconds * 1000;
  let elu0 = performance.eventLoopUtilization();
  let i = 0;
  while (Date.now() < measEnd) {
    if (!measuring && Date.now() >= measStart) {
      measuring = true;
      elu0 = performance.eventLoopUtilization();
    }
    const before = Date.now();
    const t0 = performance.now();
    await op();
    if (before >= measStart) {
      lat.push(performance.now() - t0);
      ops += 1;
    }
    if (++i % 64 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  const elu = performance.eventLoopUtilization(elu0);
  lat.sort((a, b) => a - b);
  return { opsPerSec: ops / seconds, p50Ms: percentile(lat, 0.5), p99Ms: percentile(lat, 0.99), elu: elu.utilization };
}

const RUN = dockerAvailable() && process.env["STACKBASE_BENCH_OVERHEAD"] === "1";
const maybe = RUN ? describe : describe.skip;

maybe("bench-overhead — raw PG vs store commit vs full mutation (opt-in: STACKBASE_BENCH_OVERHEAD=1)", () => {
  afterAll(() => {
    runDocker(["rm", "-f", CONTAINER]);
  });

  it("overhead ladder — prints raw INSERT / store.commitWrite / runtime.run, same box", async () => {
    const { port } = await startPgContainer();
    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    const client = new NodePgClient({
      connectionString: databaseUrl,
      applicationName: "stackbase-overhead-bench",
      commitPool: { shards: shardIdList(1) },
    });
    const store = new PostgresDocStore(client);
    const runtime = await createEmbeddedRuntime({ store, catalog: freshCatalog(), modules: benchModules() });
    const shard = shardIdList(1)[0]!;

    try {
      // Force store schema init + writer-lock acquisition, and create the raw scratch table.
      await runtime.run("bench:insert", { body: "init" });
      await client.query("CREATE TABLE IF NOT EXISTS bench_raw (id bigint, body text)");

      /* Rung 1: raw single-row INSERT via the pg driver (no index, autocommit). */
      let rawSeq = 0;
      const rung1 = await measure(async () => {
        rawSeq += 1;
        await client.query("INSERT INTO bench_raw (id, body) VALUES ($1, $2)", [rawSeq, "x"]);
      });

      /* Rung 2: the real MVCC-log commit path, document-only (no executor / OCC / index). */
      const rung2 = await measure(async () => {
        const id = newDocumentId(BENCH_TABLE);
        const value: DocumentValue = { body: "x" };
        await store.commitWrite([{ ts: 0n, id, value: { id, value }, prev_ts: null }], [], shard);
      });

      /* Rung 3: the full mutation — executor + OCC + document + by_creation index. */
      const rung3 = await measure(async () => {
        await runtime.run("bench:insert", { body: "x" });
      });

      for (const r of [rung1, rung2, rung3]) {
        expect(r.opsPerSec).toBeGreaterThan(0);
      }

      const row = (label: string, r: RungResult) =>
        `${label.padEnd(24)} | ${r.opsPerSec.toFixed(0).padStart(8)} | ${r.p50Ms.toFixed(3).padStart(8)} | ` +
        `${r.p99Ms.toFixed(3).padStart(8)} | ${r.elu.toFixed(3).padStart(5)}`;
      // eslint-disable-next-line no-console
      console.log("\n=== Overhead ladder (real Postgres, single client, this machine) ===");
      // eslint-disable-next-line no-console
      console.log("rung                     | ops/s    | p50 ms   | p99 ms   | ELU");
      // eslint-disable-next-line no-console
      console.log(row("1. raw INSERT", rung1));
      // eslint-disable-next-line no-console
      console.log(row("2. store.commitWrite", rung2));
      // eslint-disable-next-line no-console
      console.log(row("3. runtime.run (full)", rung3));
      // eslint-disable-next-line no-console
      console.log(
        `\ngaps:  raw->store = ${(rung1.opsPerSec / rung2.opsPerSec).toFixed(2)}x slower  ` +
          `|  store->full = ${(rung2.opsPerSec / rung3.opsPerSec).toFixed(2)}x slower  ` +
          `|  raw->full = ${(rung1.opsPerSec / rung3.opsPerSec).toFixed(2)}x slower`,
      );
    } finally {
      await client.close();
    }
  }, 120_000);
});
