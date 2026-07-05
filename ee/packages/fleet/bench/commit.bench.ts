/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Fleet B4, Task 1 — the commit-throughput BENCHMARK, built BEFORE any batching code (the spec's
 * "benchmark-first" abort criterion, `docs/superpowers/specs/2026-07-09-fleet-b4-group-commit-
 * design.md` §"Honest abort criterion"). Measures the SHIPPED per-shard commit path exactly as it
 * exists today: N concurrent client loops firing mutations through a real `EmbeddedRuntime`, over
 * a real `PostgresDocStore`, with NO batching involved anywhere. `runCommitBench` is the interface
 * T5 re-runs verbatim after building the group-commit committer loop, to quote the before/after win
 * — its shape (opts: `{store, numShards, clients, mix, seconds}` → `{opsPerSec, p50Ms, p99Ms}`) is
 * the load-bearing contract; do not change it without updating T5's call site.
 *
 * Two variants:
 *  - PGlite (always on, CI-fast): a 2-cell smoke — proves the harness itself works and the shipped
 *    path is non-zero-throughput and error-free. NOT a throughput signal (single in-process WASM
 *    connection, no real network/fsync) — see `docs/dev/research/write-sharding/b4-benchmark.md`'s
 *    machine-context caveats.
 *  - Real Postgres (embedded-postgres-gated, mirrors `fleet-e2e.test.ts`'s `embeddedPgAvailable()`
 *    pattern): the FULL matrix — 1/8/64 clients × 1/8 shards × insert/rmw80 mixes — against a real
 *    native PostgreSQL 16 postmaster, wired the way `prepareFleetNode` wires a real writer
 *    (`NodePgClient` with a per-shard `commitPool`, see `../src/node.ts`). This is the run whose
 *    numbers are transcribed into `b4-benchmark.md`'s baseline table (a real run on this machine,
 *    recorded once — the test itself only asserts sanity; it does not auto-write the doc, so the
 *    recorded baseline can't be silently overwritten by a routine local benchmark-gated CI run).
 */
import { describe, it, expect, afterAll } from "vitest";
import { PostgresDocStore, NodePgClient } from "@helipod/docstore-postgres";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "@helipod/docstore-postgres/test-support/embedded-pg";
import type { DocStore } from "@helipod/docstore";
import { SimpleIndexCatalog, mutation, type RegisteredFunction } from "@helipod/executor";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { shardIdList, encodeStorageIndexId } from "@helipod/id-codec";
import { PgliteClient } from "../test/pglite-client";

/* -------------------------------------------------------------------------- */
/* Bench fixture: one sharded table ("bench", sharded by channelId), two ops    */
/* -------------------------------------------------------------------------- */

const BENCH_TABLE = 40501;
const BENCH_INDEX_ID = encodeStorageIndexId(BENCH_TABLE, "by_channel");
const byChannel = {
  table: "bench",
  tableNumber: BENCH_TABLE,
  index: "by_channel",
  fields: ["channelId"],
  indexId: BENCH_INDEX_ID,
};

/** The 64-doc pool the rmw80 mix's RMWs target (mirrors the brief's "80% inserts + 20% RMW over a
 *  64-doc pool routed per shard" — pool keys `pool-0..63` spread across every shard via the same
 *  jump-hash router the kernel uses, so an 8-shard cell exercises RMW contention on EVERY shard). */
const POOL_SIZE = 64;

function freshCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  // Declared sharded (shardKey = "channelId") — mirrors `examples/chat`'s `messages.shardKey(...)`
  // and the fixture app's `messages` table (`test/fixtures/app/convex/schema.ts`).
  catalog.addTable("bench", BENCH_TABLE, undefined, false, "channelId");
  catalog.addIndex(byChannel);
  return catalog;
}

function benchModules(): Record<string, RegisteredFunction> {
  return {
    // insert-heavy mix: a brand-new document per call — unique-doc inserts on the sharded table.
    "bench:insert": mutation<{ channelId: string; tag: string }, string>({
      shardBy: "channelId",
      handler: (ctx, { channelId, tag }) => ctx.db.insert("bench", { channelId, tag, counter: 0 }),
    }),
    // rmw80's 20% slice: read the (single, pre-seeded) doc for this channel, bump its counter.
    // Helipod has no `ctx.db.patch` — read-merge-replace, same pattern as the fixture app's
    // `notes:update` (`test/fixtures/app/convex/notes.ts`).
    "bench:rmw": mutation<{ channelId: string }, null>({
      shardBy: "channelId",
      handler: async (ctx, { channelId }) => {
        const docs = await ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect();
        const d = docs[0];
        if (!d) return null; // pool not seeded for this key — treat as a no-op rather than throw
        const counter = (d["counter"] as number | undefined) ?? 0;
        await ctx.db.replace(d["_id"] as string, { ...d, counter: counter + 1 });
        return null;
      },
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* runCommitBench — the interface T5 re-runs verbatim                          */
/* -------------------------------------------------------------------------- */

export interface CommitBenchOpts {
  /** A DocStore already wired the way the caller wants it exercised (PGlite-backed, or a real-PG
   *  `NodePgClient` with a per-shard commit pool matching `numShards` — see `prepareFleetNode`).
   *  `runCommitBench` takes ownership of neither construction nor teardown of `store`. */
  store: DocStore;
  numShards: number;
  clients: number;
  mix: "insert" | "rmw80";
  /** Measurement window, seconds (the brief's "measure 5s per cell"). */
  seconds: number;
  /** Warmup window before measurement starts, milliseconds. Default 2000 (the brief's "warmup 2s")
   *  — overridable so CI-fast smoke cells don't have to pay the full warmup. */
  warmupMs?: number;
  /** Fleet B4, T5 — the group-commit flag under test. When true the runtime routes every shard's
   *  commits through the two-buffer stage-then-flush committer (`HELIPOD_GROUP_COMMIT=1`'s runtime
   *  effect). Default false: the "before" run measures the exact shipped path the T1 baseline did, so
   *  the baseline call sites (and the PGlite smokes) are behavior-unchanged. */
  groupCommit?: boolean;
}

export interface CommitBenchResult {
  opsPerSec: number;
  p50Ms: number;
  p99Ms: number;
  /** UNEXPECTED errors observed DURING the measurement window (warmup + pool-seeding errors are not
   *  counted). The sanity gate asserts this is 0 on the shipped path. OCC retry-exhaustion is NOT
   *  counted here — see `occConflicts`. */
  errors: number;
  /** OCC conflicts that exhausted the transactor's deterministic-replay budget (`maxRetries` = 8,
   *  `packages/transactor/src/shard-writer.ts`) during the measurement window. Under the rmw80
   *  mix's deliberately contended 64-doc pool at high client counts this is EXPECTED shipped-path
   *  behavior (`OccConflictError`, `code: "OCC_CONFLICT"`, documented client-retryable), so it is
   *  reported as its own column rather than tripping the zero-errors sanity gate — and it's a
   *  number T5 wants anyway (group commit changes contention behavior under load). */
  occConflicts: number;
  totalOps: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return sortedMs[idx]!;
}

/**
 * Drive N concurrent client loops through a real `EmbeddedRuntime` over `store`, firing mutations
 * back-to-back (no client-side concurrency cap beyond `clients` itself — each loop is one logical
 * "client" hammering as fast as the engine will accept). Warmup discards its ops/errors/latencies;
 * only the measurement window counts. Errors are caught per-op (a thrown mutation does not abort
 * the loop) so one bad op can't zero out the whole cell's throughput number.
 */
export async function runCommitBench(opts: CommitBenchOpts): Promise<CommitBenchResult> {
  const { store, numShards, clients, mix, seconds } = opts;
  const warmupMs = opts.warmupMs ?? 2000;

  const runtime = await createEmbeddedRuntime({
    store,
    catalog: freshCatalog(),
    modules: benchModules(),
    numShards,
    groupCommit: opts.groupCommit ?? false,
  });

  // Pre-seed the RMW pool (untimed — runs before warmup even starts).
  if (mix === "rmw80") {
    for (let i = 0; i < POOL_SIZE; i++) {
      await runtime.run<string>("bench:insert", { channelId: `pool-${i}`, tag: "seed" });
    }
  }

  let insertSeq = 0;
  let opCount = 0;
  let errorCount = 0;
  let occConflictCount = 0;
  const latenciesMs: number[] = [];

  /** Structural OCC check (error `code`, not `instanceof`) — robust across dist/src duplication. */
  function isOccConflict(e: unknown): boolean {
    return (e as { code?: string } | null | undefined)?.code === "OCC_CONFLICT";
  }

  function pickOp(clientIdx: number): { path: string; args: Record<string, string> } {
    const doInsert = mix === "insert" || Math.random() < 0.8; // rmw80: 80% insert, 20% RMW
    if (doInsert) {
      insertSeq += 1;
      // High-entropy channelId → spreads uniformly across every shard via the jump-hash router,
      // exercising genuine cross-shard parallelism at numShards > 1 ("unique-doc inserts").
      const channelId = `ins-${clientIdx}-${insertSeq}-${Math.random().toString(36).slice(2, 10)}`;
      return { path: "bench:insert", args: { channelId, tag: "load" } };
    }
    const poolIdx = Math.floor(Math.random() * POOL_SIZE);
    return { path: "bench:rmw", args: { channelId: `pool-${poolIdx}` } };
  }

  // Deadlines are computed ONCE, up front, and every loop iteration checks wall-clock `Date.now()`
  // against them directly — deliberately NOT driven by an external `setTimeout`-based flag flip.
  // A tight `while (...) { await runtime.run(...) }` loop across `clients` concurrent loops can
  // resolve entirely via the microtask queue (no real macrotask I/O in the PGlite/in-process path),
  // which STARVES Node's timer phase — an external `sleep(warmupMs)` driving a `measuring`/`stop`
  // flag would then never fire, hanging the benchmark forever. `Date.now()` is a plain syscall, not
  // gated on the timer phase, so checking it inline is immune to this starvation class.
  const startedAt = Date.now();
  const measureStartAt = startedAt + warmupMs;
  const measureEndAt = measureStartAt + seconds * 1000;

  async function clientLoop(clientIdx: number): Promise<void> {
    let iter = 0;
    while (Date.now() < measureEndAt) {
      const { path, args } = pickOp(clientIdx);
      const before = Date.now();
      const t0 = performance.now();
      try {
        await runtime.run(path, args);
        const after = Date.now();
        if (before >= measureStartAt && after <= measureEndAt) {
          latenciesMs.push(performance.now() - t0);
          opCount += 1;
        }
      } catch (e) {
        const after = Date.now();
        if (before >= measureStartAt && after <= measureEndAt) {
          if (isOccConflict(e)) occConflictCount += 1;
          else errorCount += 1;
        }
      }
      // Periodic macrotask yield: keeps this loop from monopolizing the microtask queue for its
      // entire run (fairness across the other `clients - 1` loops; belt-and-braces against the
      // starvation class described above, on top of the deadline check already being immune to it).
      iter += 1;
      if (iter % 64 === 0) await new Promise<void>((r) => setImmediate(r));
    }
  }

  const loops = Array.from({ length: clients }, (_, i) => clientLoop(i));
  await Promise.all(loops);

  latenciesMs.sort((a, b) => a - b);
  return {
    opsPerSec: opCount / seconds,
    p50Ms: percentile(latenciesMs, 0.5),
    p99Ms: percentile(latenciesMs, 0.99),
    errors: errorCount,
    occConflicts: occConflictCount,
    totalOps: opCount,
  };
}

/* -------------------------------------------------------------------------- */
/* PGlite smoke (always on, CI-fast) — 2 cells, proves the harness works        */
/* -------------------------------------------------------------------------- */

describe("Fleet B4, Task 1 — commit-throughput benchmark harness (PGlite smoke)", () => {
  it("1 shard / 4 clients / insert mix: nonzero throughput, zero errors", async () => {
    const client = new PgliteClient();
    const store = new PostgresDocStore(client);
    try {
      const result = await runCommitBench({
        store,
        numShards: 1,
        clients: 4,
        mix: "insert",
        seconds: 1,
        warmupMs: 300,
      });
      expect(result.opsPerSec).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
      expect(result.totalOps).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  }, 20_000);

  it("8 shards / 8 clients / rmw80 mix: nonzero throughput, zero errors", async () => {
    const client = new PgliteClient();
    const store = new PostgresDocStore(client);
    try {
      const result = await runCommitBench({
        store,
        numShards: 8,
        clients: 8,
        mix: "rmw80",
        seconds: 1,
        warmupMs: 300,
      });
      expect(result.opsPerSec).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
      expect(result.totalOps).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  }, 20_000);
});

/* -------------------------------------------------------------------------- */
/* Real-Postgres full matrix (embedded-postgres-gated — mirrors fleet-e2e.test.ts) */
/* -------------------------------------------------------------------------- */

const HAS_EMBEDDED_PG = embeddedPgAvailable();
// Opt-in on top of the embedded-postgres gate (HELIPOD_BENCH=1): the matrix is ~4.5 minutes of
// DELIBERATE full-throttle Postgres load. Platform-availability alone made it run inside every full
// `bun run test`, where it resource-starved the timing-sensitive fleet-e2e scenarios in the same
// parallel pass — the root cause of the recurring "fleet flake" (diagnosed 2026-07-09: the
// simultaneous-boot E2E timed out at 42s while the two bench matrices held the machine for 90s +
// 186s). Benchmarks are load generators, not tests: they run only when explicitly asked for
// (T5-gate runs, perf work), mirroring bench-fanout-pg's HELIPOD_BENCH_FANOUT_PG pattern.
const RUN_BENCH = HAS_EMBEDDED_PG && process.env["HELIPOD_BENCH"] === "1";
const maybeDescribe = RUN_BENCH ? describe : describe.skip;

let pgServer: EmbeddedPg | undefined;

async function startPostgresContainer(): Promise<{ port: number }> {
  pgServer = await startEmbeddedPg();
  return { port: pgServer.port };
}

async function stopPostgresContainer(): Promise<void> {
  await pgServer?.stop();
  pgServer = undefined;
}

/** Build a store wired the way `prepareFleetNode` wires a real writer (`../src/node.ts`): a
 *  `NodePgClient` with a per-shard commit pool (`commitPool: { shards: shardIdList(numShards) }`)
 *  so different shards' commits are genuinely concurrent Postgres transactions — the SAME
 *  production wiring, not a simplified stand-in. No lease/fleet machinery is layered on top: this
 *  benchmark measures the store/transactor commit path itself (what group commit touches), not
 *  multi-node coordination. */
function buildRealPgStore(databaseUrl: string, numShards: number): { store: PostgresDocStore; client: NodePgClient } {
  const client = new NodePgClient({
    connectionString: databaseUrl,
    applicationName: `helipod-b4-bench-${numShards}`,
    commitPool: { shards: shardIdList(numShards) },
  });
  return { store: new PostgresDocStore(client), client };
}

interface MatrixCell {
  numShards: number;
  clients: number;
  mix: "insert" | "rmw80";
  result: CommitBenchResult;
}

maybeDescribe("Fleet B4, Task 1 — commit-throughput benchmark (real Postgres, full matrix)", () => {
  afterAll(async () => {
    await stopPostgresContainer();
  });

  it(
    "full matrix: 1/8/64 clients × 1/8 shards × insert/rmw80 — sanity gate + prints the results table",
    async () => {
      const { port } = await startPostgresContainer();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

      const CLIENT_COUNTS = [1, 8, 64];
      const SHARD_COUNTS = [1, 8];
      const MIXES: Array<"insert" | "rmw80"> = ["insert", "rmw80"];

      const cells: MatrixCell[] = [];
      for (const numShards of SHARD_COUNTS) {
        for (const mix of MIXES) {
          for (const clients of CLIENT_COUNTS) {
            const { store, client } = buildRealPgStore(databaseUrl, numShards);
            try {
              const result = await runCommitBench({ store, numShards, clients, mix, seconds: 5, warmupMs: 2000 });
              cells.push({ numShards, clients, mix, result });
              expect(result.opsPerSec).toBeGreaterThan(0);
              expect(result.errors).toBe(0);
            } finally {
              await client.close();
            }
          }
        }
      }

      // Print a copy-pasteable table — the numbers this task's report + b4-benchmark.md transcribe
      // as the recorded baseline (a real run on this machine; see the doc's machine-context notes).
      // eslint-disable-next-line no-console
      console.log("\n=== Fleet B4 baseline (real Postgres, this machine) ===");
      // eslint-disable-next-line no-console
      console.log("shards | mix    | clients | ops/s   | p50 ms | p99 ms | occConflicts | errors");
      for (const c of cells) {
        // eslint-disable-next-line no-console
        console.log(
          `${String(c.numShards).padStart(6)} | ${c.mix.padEnd(6)} | ${String(c.clients).padStart(7)} | ` +
            `${c.result.opsPerSec.toFixed(1).padStart(7)} | ${c.result.p50Ms.toFixed(2).padStart(6)} | ` +
            `${c.result.p99Ms.toFixed(2).padStart(6)} | ${String(c.result.occConflicts).padStart(12)} | ${c.result.errors}`,
        );
      }
    },
    600_000,
  );
});

/* -------------------------------------------------------------------------- */
/* Fleet B4, Task 5 — group commit ON: the before/after gate run (real PG)     */
/* -------------------------------------------------------------------------- */

/**
 * The gate run. For every matrix cell, `runCommitBench` is invoked TWICE against the SAME container
 * (same session, same machine state) — once with the flag OFF (the "before", re-establishing the
 * baseline apples-to-apples rather than trusting a prior recording) and once with it ON. Prints a
 * combined before/after table with the per-cell speedup. The decisive insert-heavy 64-client cells
 * (1-shard and 8-shard) are additionally re-run a SECOND time with the flag ON so the report can
 * quote both if they differ materially (the brief's anti-massage rule). This test only prints; the
 * numbers are transcribed by hand into `b4-benchmark.md` — a routine benchmark-gated CI run cannot
 * silently overwrite the recorded gate result.
 */
let t5PgServer: EmbeddedPg | undefined;

async function startT5Postgres(): Promise<{ port: number }> {
  t5PgServer = await startEmbeddedPg();
  return { port: t5PgServer.port };
}

interface BeforeAfterCell {
  numShards: number;
  clients: number;
  mix: "insert" | "rmw80";
  before: CommitBenchResult;
  after: CommitBenchResult;
}

maybeDescribe("Fleet B4, Task 5 — group commit ON vs OFF (real Postgres, gate run)", () => {
  afterAll(async () => {
    await t5PgServer?.stop();
    t5PgServer = undefined;
  });

  it(
    "before/after matrix: 1/8/64 clients × 1/8 shards × insert/rmw80, flag OFF then ON — prints the gate table",
    async () => {
      const { port } = await startT5Postgres();
      const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

      const CLIENT_COUNTS = [1, 8, 64];
      const SHARD_COUNTS = [1, 8];
      const MIXES: Array<"insert" | "rmw80"> = ["insert", "rmw80"];

      async function runCell(numShards: number, clients: number, mix: "insert" | "rmw80", groupCommit: boolean): Promise<CommitBenchResult> {
        const { store, client } = buildRealPgStore(databaseUrl, numShards);
        try {
          const result = await runCommitBench({ store, numShards, clients, mix, seconds: 5, warmupMs: 2000, groupCommit });
          expect(result.opsPerSec).toBeGreaterThan(0);
          expect(result.errors).toBe(0);
          return result;
        } finally {
          await client.close();
        }
      }

      const cells: BeforeAfterCell[] = [];
      for (const numShards of SHARD_COUNTS) {
        for (const mix of MIXES) {
          for (const clients of CLIENT_COUNTS) {
            const before = await runCell(numShards, clients, mix, false);
            const after = await runCell(numShards, clients, mix, true);
            cells.push({ numShards, clients, mix, before, after });
          }
        }
      }

      // Decisive-cell repeat (flag ON, second run) — 64-client insert at 1 and 8 shards.
      const decisive1 = await runCell(1, 64, "insert", true);
      const decisive8 = await runCell(8, 64, "insert", true);

      // eslint-disable-next-line no-console
      console.log("\n=== Fleet B4 T5 gate (real Postgres, this machine) — before(OFF) / after(ON) ===");
      // eslint-disable-next-line no-console
      console.log("shards | mix    | clients | before ops/s | after ops/s | speedup | after p50 | after p99 | occ(a) | err(a)");
      for (const c of cells) {
        const speedup = c.after.opsPerSec / c.before.opsPerSec;
        // eslint-disable-next-line no-console
        console.log(
          `${String(c.numShards).padStart(6)} | ${c.mix.padEnd(6)} | ${String(c.clients).padStart(7)} | ` +
            `${c.before.opsPerSec.toFixed(1).padStart(12)} | ${c.after.opsPerSec.toFixed(1).padStart(11)} | ` +
            `${speedup.toFixed(2).padStart(6)}x | ${c.after.p50Ms.toFixed(2).padStart(9)} | ${c.after.p99Ms.toFixed(2).padStart(9)} | ` +
            `${String(c.after.occConflicts).padStart(6)} | ${c.after.errors}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(
        `\nDecisive cell repeats (flag ON, 2nd run): ` +
          `1sh/64/insert = ${decisive1.opsPerSec.toFixed(1)} ops/s; 8sh/64/insert = ${decisive8.opsPerSec.toFixed(1)} ops/s`,
      );
    },
    900_000,
  );
});
