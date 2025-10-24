/**
 * Reactive fan-out benchmark harness — the store-agnostic core, importable by both the in-process
 * SQLite benchmark (`../test/bench-fanout.test.ts`) and the real-Postgres variant that lives in
 * `ee/packages/fleet` (which owns the `@stackbase/docstore-postgres` dependency — keeping it out of
 * THIS package avoids a docstore-postgres <-> test build cycle). `runFanoutBench` takes a `store`,
 * so the caller decides which backend to exercise; it never imports a driver directly.
 *
 * Drives the real client -> sync protocol -> SubscriptionManager -> engine invalidation path (the
 * mechanism in `./reactivity.ts`): N loopback subscriptions, a writer that invalidates them, and how
 * fast / how many re-runs result — plus event-loop utilization. See
 * `docs/dev/research/reactivity/fanout-benchmark.md`.
 */
import { NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { DocStore } from "@stackbase/docstore";
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

const POOL_SIZE = 20; // scan-variant rows per channel

export function freshCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("bench", BENCH_TABLE, undefined, false, "channelId");
  catalog.addIndex(byChannel);
  return catalog;
}

export function benchModules(): Record<string, RegisteredFunction> {
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

async function buildRuntime(store?: DocStore): Promise<EmbeddedRuntime> {
  const s = store ?? new SqliteDocStore(new NodeSqliteAdapter({ path: ":memory:" }));
  return createEmbeddedRuntime({ store: s, catalog: freshCatalog(), modules: benchModules() });
}

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length));
  return sortedMs[idx]!;
}

/** Channels for a shape: broadcast = 1 channel with N subs; selective = N channels, 1 sub each.
 *  `prefix` namespaces channels so PG cells sharing one database across cells don't collide. */
function channelsForShape(
  shape: "broadcast" | "selective",
  subscriptions: number,
  prefix: string,
): string[] {
  if (shape === "broadcast") return Array.from({ length: subscriptions }, () => `${prefix}0`);
  return Array.from({ length: subscriptions }, (_, i) => `${prefix}${i}`);
}

export interface FanoutBenchOpts {
  subscriptions: number;
  shape: "broadcast" | "selective";
  queryCost: "point" | "scan";
  seconds: number;
  warmupMs?: number;
  /** Store to run against. Default: a fresh in-memory SQLite store. Pass a PostgresDocStore to
   *  measure the reactive path over a real, async, network-backed store. The caller owns the
   *  passed store's teardown (runFanoutBench does not close it). */
  store?: DocStore;
  /** Channel-name prefix (default "c"). Distinguish cells that share one database (PG matrix). */
  channelPrefix?: string;
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
  const runtime = await buildRuntime(opts.store);

  // Distinct channels this run touches (deduped), each seeded with a counter row (+ pool rows for scan).
  const subChannels = channelsForShape(opts.shape, opts.subscriptions, opts.channelPrefix ?? "c");
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
