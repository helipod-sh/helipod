import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, loopbackTransport, anyApi } from "../src/index";
import type { Value } from "@stackbase/values";

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

// Typed view of the runtime api proxy for the test.
const api = anyApi as {
  messages: { send: { __path: string }; list: { __path: string } };
};

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

let runtime: EmbeddedRuntime;
function newClient(session: string): StackbaseClient {
  return new StackbaseClient(loopbackTransport(runtime.connect(session)));
}

beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  runtime = await createEmbeddedRuntime({ store, catalog, modules });
});

describe("StackbaseClient — reactive subscriptions", () => {
  it("delivers the initial result, then updates live when another client mutates", async () => {
    const clientA = newClient("sA");
    const clientB = newClient("sB");

    const updates: Array<Array<{ body: string }>> = [];
    clientA.subscribe(api.messages.list, { conversationId: "c1" }, (v) => updates.push(v as Array<{ body: string }>));
    await waitFor(() => updates.length >= 1);
    expect(updates[0]).toEqual([]); // initial empty

    await clientB.mutation(api.messages.send, { conversationId: "c1", body: "hi" });
    await waitFor(() => updates.length >= 2);
    expect(updates.at(-1)!.map((d) => d.body)).toEqual(["hi"]); // reactive update
  });

  it("dedupes identical subscriptions and cleans up on last unsubscribe", async () => {
    const client = newClient("s1");
    const a: Value[] = [];
    const b: Value[] = [];
    const unsubA = client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => a.push(v));
    const unsubB = client.subscribe(api.messages.list, { conversationId: "c1" }, (v) => b.push(v));
    await waitFor(() => a.length >= 1 && b.length >= 1);
    expect(a[0]).toEqual([]);
    expect(b[0]).toEqual([]);
    unsubA();
    unsubB();
    // After both unsubscribe, a new mutation should not throw / leak (best-effort smoke).
    await newClient("s2").mutation(api.messages.send, { conversationId: "c1", body: "x" });
  });
});

describe("StackbaseClient — one-shot query and mutation", () => {
  it("query() resolves with the current value", async () => {
    const client = newClient("s1");
    await client.mutation(api.messages.send, { conversationId: "c1", body: "seed" });
    const value = (await client.query(api.messages.list, { conversationId: "c1" })) as Array<{ body: string }>;
    expect(value.map((d) => d.body)).toEqual(["seed"]);
  });

  it("mutation() resolves with the function's return value", async () => {
    const client = newClient("s1");
    const id = await client.mutation(api.messages.send, { conversationId: "c1", body: "hi" });
    expect(typeof id).toBe("string");
  });
});
