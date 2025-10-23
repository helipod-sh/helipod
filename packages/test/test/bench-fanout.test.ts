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
