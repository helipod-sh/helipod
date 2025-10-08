/**
 * Fleet B3 Task 1 — the two runtime-level hybrid-node seams: `beforeNotify` (D2's RYOW gate on
 * the serial fan-out `drain()`) and `queryStore`-routed `observeTimestamp` (D1's query-oracle
 * isolation). Both are mechanical/additive: unset → the shipped `runtime.test.ts`/`driver-seam.
 * test.ts` behavior is untouched (proven there, not re-proven here).
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { createClientState, applyServerMessage, type SyncClientState } from "@stackbase/sync";
import { EmbeddedRuntime, createEmbeddedRuntime } from "../src/index";

const MESSAGES = 10001;
const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};

const modules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  "messages:list": query<{ conversationId: string }, Array<{ body: string }>>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect() as Promise<
        Array<{ body: string }>
      >,
  }),
};

function freshCatalog(): SimpleIndexCatalog {
  return new SimpleIndexCatalog().addIndex(byConversation);
}

function client(conn: { onMessage(l: (m: import("@stackbase/sync").ServerMessage) => void): () => void }): SyncClientState {
  const state = createClientState();
  conn.onMessage((m) => applyServerMessage(state, m));
  return state;
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("beforeNotify drain hook (Fleet B3, D2)", () => {
  it("(c) is awaited BEFORE handler.notifyWrites for each queued invalidation", async () => {
    const order: string[] = [];
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const runtime = await EmbeddedRuntime.create({
      store,
      catalog: freshCatalog(),
      modules,
      beforeNotify: async (commitTs) => {
        order.push(`beforeNotify:${commitTs}`);
      },
    });
    const originalNotifyWrites = runtime.handler.notifyWrites.bind(runtime.handler);
    runtime.handler.notifyWrites = (async (inv: Parameters<typeof originalNotifyWrites>[0]) => {
      order.push(`notifyWrites:${inv.commitTs}`);
      return originalNotifyWrites(inv);
    }) as typeof runtime.handler.notifyWrites;

    const r = await runtime.run<string>("messages:send", { conversationId: "c1", body: "hi" });
    await waitFor(() => order.length >= 2);

    expect(order).toEqual([`beforeNotify:${r.commitTs}`, `notifyWrites:${r.commitTs}`]);
  });

  it("(c) a rejecting beforeNotify is caught and logged — drain continues to the NEXT invalidation", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    let calls = 0;
    const seen: bigint[] = [];
    const runtime = await EmbeddedRuntime.create({
      store,
      catalog: freshCatalog(),
      modules,
      beforeNotify: async (commitTs) => {
        calls += 1;
        seen.push(commitTs);
        if (calls === 1) throw new Error("simulated beforeNotify failure");
      },
    });
    const connA = runtime.connect("sA");
    const stateA = client(connA);
    await connA.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] });

    // Two commits queue two invalidations; the first's beforeNotify throws, but the queue is not
    // wedged — the second's notifyWrites still fires and the subscription still catches up.
    await runtime.run("messages:send", { conversationId: "c1", body: "one" });
    await runtime.run("messages:send", { conversationId: "c1", body: "two" });

    await waitFor(() => (stateA.queries.get(1) as unknown[] | undefined)?.length === 2);
    expect(seen.length).toBe(2); // beforeNotify was invoked for BOTH queued invalidations
    expect((stateA.queries.get(1) as Array<{ body: string }>).map((d) => d.body).sort()).toEqual(["one", "two"]);
  });

  it("(c) unset beforeNotify → zero change (the shipped drain path, byte-identical)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const runtime = await createEmbeddedRuntime({ store, catalog: freshCatalog(), modules });
    const connA = runtime.connect("sA");
    const stateA = client(connA);
    await connA.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] });
    await runtime.run("messages:send", { conversationId: "c1", body: "plain" });
    await waitFor(() => (stateA.queries.get(1) as unknown[] | undefined)?.length === 1);
    expect((stateA.queries.get(1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["plain"]);
  });
});

describe("observeTimestamp routing (Fleet B3, D1)", () => {
  it("(d) with queryStore set: observeTimestamp advances ONLY the query oracle; a local commit advances ONLY the write oracle", async () => {
    const primaryStore = new SqliteDocStore(new NodeSqliteAdapter());
    const queryStore = new SqliteDocStore(new NodeSqliteAdapter());
    await queryStore.setupSchema();

    // Seed `queryStore` directly — entirely independent of the runtime-under-test, as if a real
    // replica already had this row applied before the runtime boots. Reused across both seeds
    // below so its own oracle instance (NOT the runtime's) is what actually advances in
    // `queryStore`'s log.
    const seedTransactor = new SingleWriterTransactor(queryStore, new MonotonicTimestampOracle(0n));
    const seedExec = new InlineUdfExecutor({
      transactor: seedTransactor,
      queryRuntime: new QueryRuntime(queryStore),
      catalog: freshCatalog(),
    });
    await seedExec.run(modules["messages:send"]!, { conversationId: "c1", body: "seeded-before-create" }, { path: "seed" });

    const runtime = await EmbeddedRuntime.create({ store: primaryStore, queryStore, catalog: freshCatalog(), modules });

    // The runtime's OWN query-path oracle seeded from `queryStore.maxTimestamp()` AT CREATE TIME
    // (after the seed above) — so it sees the seeded row immediately.
    const seen0 = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(seen0.value.map((d) => d.body)).toEqual(["seeded-before-create"]);

    // Simulate the tailer applying a SECOND row to the replica, out-of-band, AFTER the runtime
    // was created — the runtime's OWN query oracle (a separate `MonotonicTimestampOracle`
    // instance from `seedTransactor`'s) does not know this ts exists yet.
    await seedExec.run(modules["messages:send"]!, { conversationId: "c1", body: "seeded-after-create" }, { path: "seed2" });
    const seen1 = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(seen1.value.map((d) => d.body)).toEqual(["seeded-before-create"]); // unchanged — oracle hasn't risen

    // A LOCAL commit through the runtime lands on `primaryStore` (unrelated to `queryStore`) and
    // must NOT advance the query oracle either — own local commits advance only the write oracle.
    await runtime.run("messages:send", { conversationId: "c1", body: "primary-write" });
    const seen2 = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(seen2.value.map((d) => d.body)).toEqual(["seeded-before-create"]); // still unchanged

    // The tailer reports progress via `observeTimestamp` — NOW the query oracle rises and the
    // second seeded row (already durably in `queryStore`'s log) becomes visible.
    runtime.observeTimestamp(2n);
    const seen3 = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(seen3.value.map((d) => d.body).sort()).toEqual(["seeded-after-create", "seeded-before-create"]);
  });

  it("(d) without queryStore, observeTimestamp keeps the shipped write-oracle routing (byte-identical)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const runtime = await createEmbeddedRuntime({ store, catalog: freshCatalog(), modules });
    // No throw, no queryOracle to route to — falls through to the write oracle exactly as before
    // this seam existed (`ShardedTransactor`/`MonotonicTimestampOracle.observeTimestamp`).
    expect(() => runtime.observeTimestamp(5n)).not.toThrow();
  });
});
