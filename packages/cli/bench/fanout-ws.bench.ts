/**
 * Reactive fan-out — WebSocket end-to-end cell. Boots a REAL dev server and connects K real WS
 * clients to one channel; measures write -> each client RECEIVES the push (true end-to-end
 * propagation, including sync-protocol serialization + the loopback socket). The in-process
 * packages/test/test/bench-fanout.test.ts measures the re-execution throughput + O(N) match cost;
 * THIS measures the user-facing latency of one write reaching K subscribers.
 *
 * Boot pattern mirrors action-e2e.test.ts: build a runtime from an inline loadProject({schema,
 * modules}) and hand it to startDevServer(runtime, {port, ip}) — no fixture dir / codegen needed.
 * Opt-in (HELIPOD_BENCH_FANOUT_WS=1) — heavier than the in-process run (spins a server + K sockets).
 */
import { describe, it, expect } from "vitest";
import { performance } from "node:perf_hooks";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { loadProject, startDevServer } from "../src/index";
import { HelipodClient, webSocketTransport } from "@helipod/client";

const RUN_WS = process.env["HELIPOD_BENCH_FANOUT_WS"] === "1";
const wsDescribe = RUN_WS ? describe : describe.skip;

const schema = defineSchema({
  bench: defineTable({ channelId: v.string(), kind: v.string(), n: v.number(), postAt: v.number() })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});

const appModule = {
  byChannel: query<{ channelId: string }, unknown>({
    handler: (ctx, { channelId }) =>
      ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect(),
  }),
  seed: mutation({
    args: { channelId: v.string() },
    shardBy: "channelId",
    handler: (ctx, { channelId }) =>
      ctx.db.insert("bench", { channelId, kind: "counter", n: 0, postAt: 0 }),
  }),
  bump: mutation({
    args: { channelId: v.string(), postAt: v.number() },
    shardBy: "channelId",
    handler: async (ctx, { channelId, postAt }) => {
      const docs = await ctx.db.query("bench", "by_channel").eq("channelId", channelId).collect();
      const c = docs.find((d) => (d as Record<string, unknown>)["kind"] === "counter") as
        | Record<string, unknown>
        | undefined;
      if (c) await ctx.db.replace(c["_id"] as string, { ...c, n: ((c["n"] as number) ?? 0) + 1, postAt });
      return null;
    },
  }),
};

function percentile(sortedMs: readonly number[], q: number): number {
  if (sortedMs.length === 0) return 0;
  return sortedMs[Math.min(sortedMs.length - 1, Math.floor(q * sortedMs.length))]!;
}

wsDescribe("bench-fanout-ws — end-to-end propagation (opt-in: HELIPOD_BENCH_FANOUT_WS=1)", () => {
  it("K WS clients on one channel: measures write -> each client receives push", async () => {
    const project = loadProject({ schema, modules: { bench: appModule } });
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    try {
      await runtime.run("bench:seed", { channelId: "c0" });

      const K = 100;
      const clients = Array.from({ length: K }, () => new HelipodClient(webSocketTransport(wsUrl)));
      const latencies: number[] = [];
      let received = 0;
      let subscribed = 0;

      await Promise.all(
        clients.map(
          (client) =>
            new Promise<void>((resolve) => {
              let first = true;
              client.subscribe("bench:byChannel", { channelId: "c0" }, (value) => {
                if (first) {
                  first = false;
                  subscribed += 1;
                  resolve(); // first compute = subscription established
                  return;
                }
                const arr = value as Array<Record<string, unknown>>;
                const counter = arr.find((d) => d["kind"] === "counter");
                const postAt = (counter?.["postAt"] as number | undefined) ?? 0;
                if (postAt > 0) {
                  latencies.push(performance.now() - postAt);
                  received += 1;
                }
              });
            }),
        ),
      );
      expect(subscribed).toBe(K);

      // One write; every client should receive the push.
      const postAt = performance.now();
      await runtime.run("bench:bump", { channelId: "c0", postAt });
      await new Promise((r) => setTimeout(r, 2000)); // wait for fan-out to arrive

      for (const c of clients) c.close();
      expect(received).toBe(K); // all K clients saw the update

      latencies.sort((a, b) => a - b);
      // eslint-disable-next-line no-console
      console.log(
        `\n=== bench-fanout WS end-to-end (K=${K} clients, this machine) ===\n` +
          `received=${received}/${K}  propP50=${percentile(latencies, 0.5).toFixed(2)}ms  ` +
          `propP99=${percentile(latencies, 0.99).toFixed(2)}ms`,
      );
    } finally {
      await server.close();
    }
  }, 120_000);
});
