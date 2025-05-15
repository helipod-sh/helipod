import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createClientState, applyServerMessage, type SyncClientState } from "@stackbase/sync";
import { createEmbeddedRuntime, InMemoryWriteFanoutAdapter } from "../src/index";

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

async function makeRuntime(fanoutAdapter?: InMemoryWriteFanoutAdapter) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  return createEmbeddedRuntime({ store, catalog, modules, fanoutAdapter });
}

function client(conn: { onMessage(l: (m: import("@stackbase/sync").ServerMessage) => void): () => void }): SyncClientState {
  const state = createClientState();
  conn.onMessage((m) => applyServerMessage(state, m));
  return state;
}

describe("embedded runtime — in-process reactive loop", () => {
  it("an in-process client subscribes and receives a reactive update when another client writes", async () => {
    const runtime = await makeRuntime();
    const connA = runtime.connect("sA");
    const connB = runtime.connect("sB");
    const stateA = client(connA);

    await connA.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] });
    expect(stateA.queries.get(1)).toEqual([]);

    await connB.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "hello" } });

    expect(stateA.needsResync).toBe(false);
    expect((stateA.queries.get(1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["hello"]);
  });

  it("the write-fan-out adapter receives the serializable delta for every commit", async () => {
    const adapter = new InMemoryWriteFanoutAdapter();
    const runtime = await makeRuntime(adapter);
    const conn = runtime.connect("s1");

    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "x" } });

    expect(adapter.published).toHaveLength(1);
    const delta = adapter.published[0]!;
    expect(delta.tables).toContain(encodeStorageTableId(MESSAGES));
    expect(delta.commitTs).toBeGreaterThan(0);
    expect(delta.ranges.length).toBeGreaterThan(0); // serializable ranges (base64), not in-memory buffers
    expect(() => JSON.stringify(delta)).not.toThrow();
  });

  it("swapping the fan-out adapter is a no-op to app behavior", async () => {
    const custom = new InMemoryWriteFanoutAdapter();
    const runtime = await makeRuntime(custom);
    const connA = runtime.connect("sA");
    const connB = runtime.connect("sB");
    const stateA = client(connA);

    await connA.send({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }], remove: [] });
    await connB.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "swapped" } });

    expect((stateA.queries.get(1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["swapped"]);
    expect(custom.published).toHaveLength(1); // the swapped adapter is the one in use
  });

  it("supports direct function invocation (run) for HTTP/CLI", async () => {
    const runtime = await makeRuntime();
    const id = (await runtime.run<string>("messages:send", { conversationId: "c1", body: "direct" })).value;
    expect(typeof id).toBe("string");
    const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(list.value.map((d) => d.body)).toEqual(["direct"]);
  });
});
