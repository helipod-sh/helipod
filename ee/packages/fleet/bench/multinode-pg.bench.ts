/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Multi-node DISTRIBUTED write-throughput benchmark. Spawns N real `serve --fleet` writer nodes
 * (STACKBASE_FLEET_MULTI_WRITER) against a SHARED Postgres, waits for the balancer to partition the
 * shards across them, then drives concurrent sharded writes ROUTED TO EACH SHARD'S OWNER node and
 * measures aggregate mut/s.
 *
 * Shards-per-node is held CONSTANT (SHARDS_PER_NODE=4), so total shards = 4·N and every node always
 * drives 4 shards. The question the numbers answer: does adding a NODE add aggregate write capacity
 * (engine/event-loop was the bottleneck), or is the shared Postgres the ceiling (flat)? Either is an
 * honest result. Reuses the fleet-e2e spawn/converge pattern (self-contained here, per the benchmark
 * house style — bench-commit et al.). embedded-postgres-gated + opt-in
 * (STACKBASE_BENCH_MULTINODE=1).
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { shardIdForKeyValue } from "@stackbase/id-codec";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@stackbase/docstore-postgres/test-support/embedded-pg";

const SHARDS_PER_NODE = 4;
const NODE_COUNTS = [1, 2, 3];
const WRITERS_PER_NODE = 8;
const CLI_BIN = resolve(new URL(".", import.meta.url).pathname, "../../../../packages/cli/dist/bin.js");
const ADMIN_KEY = "bench-multinode-key";
function fixtureFunctionsDir() {
  return resolve(new URL(".", import.meta.url).pathname, "..", "test", "fixtures", "app", "convex");
}

/* --- embedded postgres --- */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// One FRESH cluster per cell — the fleet persists its shard count at first boot (immutable), and
// stale leases would block the next cell's convergence, so cells must not share a database.
// Tracked so afterAll can belt-and-braces-clean anything a hung/errored cell left running.
const servers: EmbeddedPg[] = [];
async function startPostgresContainer(): Promise<{ port: number; server: EmbeddedPg }> {
  const server = await startEmbeddedPg();
  servers.push(server);
  return { port: server.port, server };
}

/* --- fleet serve node lifecycle --- */
type ServeProcess = ChildProcessByStdio<null, Readable, Readable>;
const allProcs: ServeProcess[] = [];
const dataDirs: string[] = [];
function spawnFleetServe(databaseUrl: string, port: number, numShards: number): ServeProcess {
  const dataDir = mkdtempSync(join(tmpdir(), "sb-mn-node-"));
  dataDirs.push(dataDir);
  const proc = spawn(
    "bun",
    [
      CLI_BIN, "serve", "--dir", fixtureFunctionsDir(), "--data", join(dataDir, "db.sqlite"),
      "--port", String(port), "--ip", "127.0.0.1", "--no-dashboard",
      "--database-url", databaseUrl, "--fleet", "--advertise-url", `http://127.0.0.1:${port}`,
    ],
    {
      env: { ...process.env, STACKBASE_ADMIN_KEY: ADMIN_KEY, STACKBASE_FLEET_MULTI_WRITER: "1", STACKBASE_FLEET_SHARDS: String(numShards) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  allProcs.push(proc);
  return proc;
}
function waitForReady(proc: ServeProcess, timeoutMs = 60_000): Promise<{ url: string; role?: string }> {
  return new Promise((res, rej) => {
    let buf = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rej(new Error(`ready timeout; stdout=${JSON.stringify(buf)} stderr=${JSON.stringify(err)}`));
    }, timeoutMs);
    const onOut = (d: Buffer) => {
      buf += d.toString();
      for (const line of buf.split("\n")) {
        try {
          const j = JSON.parse(line);
          if (j && typeof j === "object" && j.url) {
            settled = true;
            clearTimeout(timer);
            proc.stdout.off("data", onOut);
            res(j);
            return;
          }
        } catch {
          /* non-JSON log line */
        }
      }
    };
    proc.stdout.on("data", onOut);
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rej(new Error(`node exited before ready (code=${code}); stderr=${JSON.stringify(err)}`));
    });
  });
}
async function stopServe(proc: ServeProcess | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  await new Promise<void>((r) => proc.once("exit", () => r()));
}

/* --- shard partition (balancer convergence) --- */
async function readShardPartition(pg: Client): Promise<Map<string, string>> {
  const r = await pg.query("SELECT shard_id, writer_url FROM shard_leases WHERE writer_url IS NOT NULL AND expires_at >= now()");
  const map = new Map<string, string>();
  for (const row of r.rows as Array<{ shard_id: string; writer_url: string }>) map.set(row.shard_id, row.writer_url);
  return map;
}
async function waitForConvergedPartition(pg: Client, owners: string[], numShards: number, timeoutMs = 60_000): Promise<Map<string, string>> {
  const start = Date.now();
  let last = new Map<string, string>();
  for (;;) {
    last = await readShardPartition(pg).catch(() => new Map<string, string>());
    if (last.size === numShards) {
      const held = new Set(last.values());
      if ([...held].every((u) => owners.includes(u)) && owners.every((u) => held.has(u))) return last;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`partition did not converge to {${owners.join(", ")}} in ${timeoutMs}ms (last size=${last.size})`);
    await sleep(250);
  }
}

async function apiRun(url: string, path: string, args: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${url}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, args }) });
  if (!res.ok) return false;
  const body = (await res.json()) as { committed?: boolean };
  return body.committed !== false;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
}

interface CellResult {
  nodeCount: number;
  numShards: number;
  aggOpsPerSec: number;
  perNodeOpsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  errors: number;
}

const RUN = embeddedPgAvailable() && process.env["STACKBASE_BENCH_MULTINODE"] === "1";
const maybe = RUN ? describe : describe.skip;

maybe("bench-multinode — distributed write throughput (opt-in: STACKBASE_BENCH_MULTINODE=1 + embedded-postgres)", () => {
  afterAll(async () => {
    for (const p of allProcs) p.kill("SIGKILL");
    for (const s of servers) await s.stop();
  });

  async function runCell(nodeCount: number): Promise<CellResult> {
    const numShards = SHARDS_PER_NODE * nodeCount;
    const { port, server } = await startPostgresContainer();
    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
    const pg = new Client({ connectionString: databaseUrl });
    await pg.connect();
    const basePort = 3400;
    const nodes: Array<{ proc: ServeProcess; url: string }> = [];
    for (let i = 0; i < nodeCount; i++) {
      const port = basePort + i;
      const proc = spawnFleetServe(databaseUrl, port, numShards);
      await waitForReady(proc);
      nodes.push({ proc, url: `http://127.0.0.1:${port}` });
    }
    const partition = await waitForConvergedPartition(pg, nodes.map((n) => n.url), numShards);

    // Per-node channel pools: channelIds whose shard this node owns (so every write is direct-to-owner).
    const poolByUrl = new Map<string, string[]>();
    for (const n of nodes) poolByUrl.set(n.url, []);
    for (let i = 0; i < 4000 && [...poolByUrl.values()].some((p) => p.length < 64); i++) {
      const key = `chan-${i}`;
      const owner = partition.get(shardIdForKeyValue(key, numShards));
      if (owner && poolByUrl.has(owner)) poolByUrl.get(owner)!.push(key);
    }

    const seconds = 5;
    const warmupMs = 2000;
    const measStart = Date.now() + warmupMs;
    const measEnd = measStart + seconds * 1000;
    const lat: number[] = [];
    let ops = 0;
    let errors = 0;

    async function writer(nodeUrl: string, pool: string[], wi: number): Promise<void> {
      let j = wi;
      while (Date.now() < measEnd) {
        const channelId = pool[j % pool.length]!;
        j += 1;
        const before = Date.now();
        const t0 = performance.now();
        try {
          const ok = await apiRun(nodeUrl, "messages:send", { channelId, body: "x" });
          if (before >= measStart) {
            if (ok) {
              lat.push(performance.now() - t0);
              ops += 1;
            } else {
              errors += 1;
            }
          }
        } catch {
          if (before >= measStart) errors += 1;
        }
      }
    }

    const loops: Array<Promise<void>> = [];
    for (const n of nodes) {
      const pool = poolByUrl.get(n.url)!;
      for (let w = 0; w < WRITERS_PER_NODE; w++) loops.push(writer(n.url, pool, w));
    }
    await Promise.all(loops);

    for (const n of nodes) await stopServe(n.proc);
    await pg.end();
    await server.stop(); // fresh cluster per cell
    servers.splice(servers.indexOf(server), 1);

    lat.sort((a, b) => a - b);
    return {
      nodeCount,
      numShards,
      aggOpsPerSec: ops / seconds,
      perNodeOpsPerSec: ops / seconds / nodeCount,
      p50Ms: percentile(lat, 0.5),
      p99Ms: percentile(lat, 0.99),
      errors,
    };
  }

  it(
    "1 / 2 / 3 nodes (4 shards each) — does aggregate write throughput scale with nodes?",
    async () => {
      const cells: CellResult[] = [];
      for (const nodeCount of NODE_COUNTS) {
        const r = await runCell(nodeCount);
        cells.push(r);
        expect(r.errors).toBe(0);
        expect(r.aggOpsPerSec).toBeGreaterThan(0);
      }

      const base = cells[0]!.aggOpsPerSec;
      // eslint-disable-next-line no-console
      console.log("\n=== Multi-node distributed write throughput (shared Postgres, this machine) ===");
      // eslint-disable-next-line no-console
      console.log("nodes | shards | agg mut/s | per-node mut/s | scale vs 1 | p50 ms | p99 ms");
      for (const c of cells) {
        // eslint-disable-next-line no-console
        console.log(
          `${String(c.nodeCount).padStart(5)} | ${String(c.numShards).padStart(6)} | ` +
            `${c.aggOpsPerSec.toFixed(0).padStart(9)} | ${c.perNodeOpsPerSec.toFixed(0).padStart(14)} | ` +
            `${(c.aggOpsPerSec / base).toFixed(2).padStart(9)}x | ${c.p50Ms.toFixed(2).padStart(6)} | ${c.p99Ms.toFixed(2).padStart(6)}`,
        );
      }
    },
    900_000,
  );
});
