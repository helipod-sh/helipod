import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type WriteRouter } from "../src/index";

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
  "messages:list": query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};

async function makeRuntime(extra?: { writeRouter?: WriteRouter; deferDrivers?: boolean; drivers?: any[] }) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  return { runtime: await createEmbeddedRuntime({ store, catalog, modules, ...extra }), store };
}

describe("write-router seam", () => {
  it("routes a mutation through forward() when not the local writer", async () => {
    const forward = vi.fn(async () => 42);
    let localWriter = false;
    const router: WriteRouter = { isLocalWriter: () => localWriter, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const result = await runtime.run("messages:send", { conversationId: "c1", body: "hi" });
    expect(result.value).toBe(42);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("mutation", "messages:send", { conversationId: "c1", body: "hi" }, null);
  });

  it("never routes a query, even when not the local writer", async () => {
    const forward = vi.fn(async () => 42);
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const list = await runtime.run("messages:list", { conversationId: "c1" });
    expect(list.value).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it("flipping isLocalWriter back to true makes the mutation execute locally again", async () => {
    const forward = vi.fn(async () => 42);
    let localWriter = false;
    const router: WriteRouter = { isLocalWriter: () => localWriter, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    await runtime.run("messages:send", { conversationId: "c1", body: "routed" });
    expect(forward).toHaveBeenCalledTimes(1);

    localWriter = true;
    const id = (await runtime.run<string>("messages:send", { conversationId: "c1", body: "local" })).value;
    expect(typeof id).toBe("string");
    expect(forward).toHaveBeenCalledTimes(1); // still just the one call from before — this one ran locally

    const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(list.value.map((d) => d.body)).toEqual(["local"]);
  });

  it("routes an action through forward() with kind 'action' when not the local writer", async () => {
    const forward = vi.fn(async () => "action-result");
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const actionModules: Record<string, RegisteredFunction> = {
      ...modules,
      "mod:doThing": {
        type: "action",
        handler: async () => "should-not-run-locally",
      } as unknown as RegisteredFunction,
    };
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byConversation);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules: actionModules, writeRouter: router });

    const result = await runtime.runAction("mod:doThing", { x: 1 });
    expect(result.value).toBe("action-result");
    expect(forward).toHaveBeenCalledWith("action", "mod:doThing", { x: 1 }, null);
  });
});

describe("deferred driver start", () => {
  it("skips starting drivers at create() when deferDrivers is true; startDrivers() starts them exactly once", async () => {
    let started = 0;
    const stubDriver = {
      name: "stub",
      start: vi.fn(async () => {
        started += 1;
      }),
    };
    const { runtime } = await makeRuntime({ deferDrivers: true, drivers: [stubDriver] });

    expect(stubDriver.start).not.toHaveBeenCalled();
    expect(started).toBe(0);

    await runtime.startDrivers();
    expect(stubDriver.start).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);

    // Idempotent: a second call is a no-op.
    await runtime.startDrivers();
    expect(stubDriver.start).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);
  });
});

describe("observeTimestamp", () => {
  it("advances the oracle so a subsequent local mutation commits past the observed timestamp", async () => {
    const { runtime, store } = await makeRuntime();

    runtime.observeTimestamp(100n);
    await runtime.run("messages:send", { conversationId: "c1", body: "after-observe" });

    const max = await store.maxTimestamp();
    expect(max).toBeGreaterThan(100n);
  });
});
