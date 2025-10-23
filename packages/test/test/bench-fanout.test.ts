/**
 * Reactive fan-out benchmark. Complements bench-commit (which measures the WRITE path only) by
 * measuring the REACTIVE path: N loopback subscriptions, a writer that invalidates them, and how
 * fast/how-many re-runs result — plus event-loop utilization as the Bun-Workers saturation signal.
 * Drives the real client -> sync protocol -> SubscriptionManager -> invalidation path (the
 * mechanism in packages/test/src/reactivity.ts), over in-memory SQLite (synchronous reads => the
 * re-execution CPU is on the main thread, which is exactly what we want to observe saturate).
 * See docs/dev/research/reactivity/fanout-benchmark.md (report) and
 * docs/superpowers/specs/2026-07-09-reactive-fanout-benchmark-design.md (design).
 */
import { describe, it, expect } from "vitest";
import { NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { SimpleIndexCatalog, mutation, query, type RegisteredFunction } from "@stackbase/executor";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { StackbaseClient, loopbackTransport } from "@stackbase/client";
import { performance } from "node:perf_hooks";

const BENCH_TABLE = 40601;
const BENCH_INDEX_ID = encodeStorageIndexId(BENCH_TABLE, "by_channel");
const byChannel = {
  table: "bench",
  tableNumber: BENCH_TABLE,
  index: "by_channel",
  fields: ["channelId"],
  indexId: BENCH_INDEX_ID,
};

function freshCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("bench", BENCH_TABLE, undefined, false, "channelId");
  catalog.addIndex(byChannel);
  return catalog;
}

function benchModules(): Record<string, RegisteredFunction> {
  return {
    // A subscription reads its channel's rows. For the "point" variant a channel holds exactly one
    // (counter) row => constant re-run cost regardless of how many writes happened. For "scan" the
    // channel also holds K pool rows => a wider, still-constant collect.
    "bench:byChannel": query<{ channelId: string }, unknown>({
      handler: (ctx, { channelId }) =>
        ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect(),
    }),
    // The invalidating write: bump the channel's counter row and stamp postAt (passed in as an
    // ARGUMENT — computed client-side, so the handler stays deterministic, no clock read inside).
    "bench:bump": mutation<{ channelId: string; postAt: number }, null>({
      shardBy: "channelId",
      handler: async (ctx, { channelId, postAt }) => {
        const docs = await ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect();
        const counter = docs.find((d) => (d as Record<string, unknown>)["kind"] === "counter") as
          | Record<string, unknown>
          | undefined;
        if (counter) {
          const n = (counter["n"] as number | undefined) ?? 0;
          await ctx.db.replace(counter["_id"] as string, { ...counter, n: n + 1, postAt });
        }
        return null;
      },
    }),
    "bench:seedCounter": mutation<{ channelId: string }, string>({
      shardBy: "channelId",
      handler: (ctx, { channelId }) =>
        ctx.db.insert("bench", { channelId, kind: "counter", n: 0, postAt: 0 }),
    }),
    "bench:seedPool": mutation<{ channelId: string; i: number }, string>({
      shardBy: "channelId",
      handler: (ctx, { channelId, i }) =>
        ctx.db.insert("bench", { channelId, kind: "pool", i, n: 0, postAt: 0 }),
    }),
  };
}

async function buildRuntime(): Promise<EmbeddedRuntime> {
  const store = new SqliteDocStore(new NodeSqliteAdapter({ path: ":memory:" }));
  return createEmbeddedRuntime({ store, catalog: freshCatalog(), modules: benchModules() });
}

const POOL_SIZE = 20; // scan-variant rows per channel

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return sortedMs[idx]!;
}

/** Channels for a shape: broadcast = 1 channel with N subs; selective = N channels, 1 sub each. */
function channelsForShape(shape: "broadcast" | "selective", subscriptions: number): string[] {
  if (shape === "broadcast") return Array.from({ length: subscriptions }, () => "c0");
  return Array.from({ length: subscriptions }, (_, i) => `c${i}`);
}

export interface FanoutBenchOpts {
  subscriptions: number;
  shape: "broadcast" | "selective";
  queryCost: "point" | "scan";
  seconds: number;
  warmupMs?: number;
}
export interface FanoutBenchResult {
  reRunsPerSec: number;
  propP50Ms: number;
  propP99Ms: number;
  eluDuringStorm: number;
  writesPerSec: number;
  subsMatchedAvg: number;
  errors: number;
}

export async function runFanoutBench(opts: FanoutBenchOpts): Promise<FanoutBenchResult> {
  const warmupMs = opts.warmupMs ?? 2000;
  const runtime = await buildRuntime();

  // Distinct channels this run touches (deduped), each seeded with a counter row (+ pool rows for scan).
  const subChannels = channelsForShape(opts.shape, opts.subscriptions);
  const distinctChannels = [...new Set(subChannels)];
  for (const channelId of distinctChannels) {
    await runtime.run("bench:seedCounter", { channelId });
    if (opts.queryCost === "scan") {
      for (let i = 0; i < POOL_SIZE; i++) await runtime.run("bench:seedPool", { channelId, i });
    }
  }

  // One shared client, N subscriptions. Each re-run reads the channel's counter row, and if its
  // postAt is a real (post-warmup) stamp, records now-postAt as one propagation sample.
  const client = new StackbaseClient(loopbackTransport(runtime.connect()));
  const latenciesMs: number[] = [];
  let reRuns = 0;
  let errors = 0;
  let measuring = false;

  function onValue(value: unknown): void {
    if (!measuring) return;
    const arr = value as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(arr)) return;
    const counter = arr.find((d) => d["kind"] === "counter");
    const postAt = (counter?.["postAt"] as number | undefined) ?? 0;
    if (postAt > 0) {
      latenciesMs.push(performance.now() - postAt);
      reRuns += 1;
    }
  }

  for (const channelId of subChannels) {
    client.subscribe("bench:byChannel", { channelId }, onValue, () => {
      if (measuring) errors += 1;
    });
  }
  // Let all initial computes settle before measuring (they carry postAt=0 and are skipped anyway).
  await new Promise((r) => setTimeout(r, 200));

  // Writer loop: bump channels round-robin, stamping postAt at post time. Deadline via Date.now()
  // (NOT a setTimeout flag — a tight await loop starves Node's timer phase; see bench-commit).
  let bumps = 0;
  let writeIdx = 0;
  const startedAt = Date.now();
  const measureStartAt = startedAt + warmupMs;
  const measureEndAt = measureStartAt + opts.seconds * 1000;
  let eluStart = performance.eventLoopUtilization();

  let iter = 0;
  while (Date.now() < measureEndAt) {
    if (!measuring && Date.now() >= measureStartAt) {
      measuring = true;
      eluStart = performance.eventLoopUtilization(); // reset the ELU baseline at window start
    }
    const channelId = distinctChannels[writeIdx % distinctChannels.length]!;
    writeIdx += 1;
    const before = Date.now();
    try {
      await runtime.run("bench:bump", { channelId, postAt: performance.now() });
      if (before >= measureStartAt) bumps += 1;
    } catch {
      if (before >= measureStartAt) errors += 1;
    }
    iter += 1;
    if (iter % 64 === 0) await new Promise<void>((r) => setImmediate(r));
  }
  // Drain in-flight re-runs, then snapshot ELU over the measurement window.
  await new Promise((r) => setTimeout(r, 100));
  const elu = performance.eventLoopUtilization(eluStart);
  client.close();

  latenciesMs.sort((a, b) => a - b);
  return {
    reRunsPerSec: reRuns / opts.seconds,
    propP50Ms: percentile(latenciesMs, 0.5),
    propP99Ms: percentile(latenciesMs, 0.99),
    eluDuringStorm: elu.utilization,
    writesPerSec: bumps / opts.seconds,
    subsMatchedAvg: bumps > 0 ? reRuns / bumps : 0,
    errors,
  };
}

describe("bench-fanout — harness smoke (CI-fast, always on)", () => {
  it("broadcast: one bump wakes every subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "broadcast", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeGreaterThan(10); // ~20 subs matched per bump (broadcast)
  }, 30_000);

  it("selective: one bump wakes ~one subscription", async () => {
    const r = await runFanoutBench({
      subscriptions: 20, shape: "selective", queryCost: "point", seconds: 1, warmupMs: 300,
    });
    expect(r.reRunsPerSec).toBeGreaterThan(0);
    expect(r.errors).toBe(0);
    expect(r.subsMatchedAvg).toBeLessThan(3); // surgical: ~1 sub matched per bump
  }, 30_000);
});

describe("bench-fanout — fixture wiring", () => {
  it("a bump invalidates a subscription reading the same channel", async () => {
    const runtime = await buildRuntime();
    await runtime.run("bench:seedCounter", { channelId: "c0" });
    const client = new StackbaseClient(loopbackTransport(runtime.connect()));
    let reruns = 0;
    const values: unknown[] = [];
    client.subscribe("bench:byChannel", { channelId: "c0" }, (v) => {
      reruns += 1;
      values.push(v);
    });
    // wait for first compute
    await new Promise((r) => setTimeout(r, 50));
    const firstReruns = reruns;
    await runtime.run("bench:bump", { channelId: "c0", postAt: performance.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(reruns).toBeGreaterThan(firstReruns); // the write re-ran the subscription
    client.close();
  }, 20_000);
});

const RUN_MATRIX = process.env["STACKBASE_BENCH_FANOUT"] === "1";
const matrixDescribe = RUN_MATRIX ? describe : describe.skip;

interface MatrixCell {
  subscriptions: number;
  shape: "broadcast" | "selective";
  queryCost: "point" | "scan";
  result: FanoutBenchResult;
}

matrixDescribe("bench-fanout — full matrix (opt-in: STACKBASE_BENCH_FANOUT=1)", () => {
  it("7 cells: point across the 3x2 grid + one scan headline — prints the table", async () => {
    // point across the full subscriptions x shape grid, plus one scan cell at the headline.
    const cellSpecs: Array<Omit<MatrixCell, "result">> = [];
    for (const shape of ["broadcast", "selective"] as const) {
      for (const subscriptions of [100, 1_000, 10_000]) {
        cellSpecs.push({ subscriptions, shape, queryCost: "point" });
      }
    }
    cellSpecs.push({ subscriptions: 10_000, shape: "broadcast", queryCost: "scan" });

    const cells: MatrixCell[] = [];
    for (const spec of cellSpecs) {
      const result = await runFanoutBench({ ...spec, seconds: 5, warmupMs: 2000 });
      cells.push({ ...spec, result });
      expect(result.errors).toBe(0);
      expect(result.reRunsPerSec).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log("\n=== Reactive fan-out benchmark (in-process, in-memory SQLite, this machine) ===");
    // eslint-disable-next-line no-console
    console.log("subs   | shape      | qcost | reRuns/s | propP50 | propP99 | ELU   | writes/s | matchedAvg");
    for (const c of cells) {
      const r = c.result;
      // eslint-disable-next-line no-console
      console.log(
        `${String(c.subscriptions).padStart(6)} | ${c.shape.padEnd(10)} | ${c.queryCost.padEnd(5)} | ` +
          `${r.reRunsPerSec.toFixed(0).padStart(8)} | ${r.propP50Ms.toFixed(2).padStart(7)} | ` +
          `${r.propP99Ms.toFixed(2).padStart(7)} | ${r.eluDuringStorm.toFixed(3).padStart(5)} | ` +
          `${r.writesPerSec.toFixed(0).padStart(8)} | ${r.subsMatchedAvg.toFixed(1).padStart(10)}`,
      );
    }
  }, 600_000);
});
