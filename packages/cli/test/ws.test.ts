import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { query, mutation } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, webSocketTransport, anyApi } from "@helipod/client";
import { loadProject, startDevServer, type LoadedProject } from "../src/index";

const schema = defineSchema({
  messages: defineTable({ conversationId: v.id("conversations"), body: v.string() }).index("by_conversation", ["conversationId"]),
  conversations: defineTable({ title: v.string() }),
});
const messagesModule = {
  send: mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  list: query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};
const loaded: LoadedProject = { schema, modules: { messages: messagesModule } };
const api = anyApi as { messages: { send: { __path: string }; list: { __path: string } } };

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("reactive sync over a real WebSocket", () => {
  it("pushes a live update across the network when another client mutates", async () => {
    const project = loadProject(loaded);
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const server = await startDevServer(
      runtime,
      { port: 0, ip: "127.0.0.1" },
    );
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;
    const clientA = new HelipodClient(webSocketTransport(wsUrl));
    const clientB = new HelipodClient(webSocketTransport(wsUrl));

    try {
      const updates: Array<Array<{ body: string }>> = [];
      clientA.subscribe(api.messages.list, { conversationId: "c1" }, (v) => updates.push(v as Array<{ body: string }>));
      await waitFor(() => updates.length >= 1);
      expect(updates[0]).toEqual([]);

      await clientB.mutation(api.messages.send, { conversationId: "c1", body: "over-the-wire" });
      await waitFor(() => updates.length >= 2);
      expect(updates.at(-1)!.map((d) => d.body)).toEqual(["over-the-wire"]);
    } finally {
      clientA.close();
      clientB.close();
      await server.close();
    }
  });
});
