/**
 * Task 2 (Slice 1) — the process host reimplemented on the `RuntimeHost` seam, with ZERO behavior
 * change. `ProcessRuntimeHost.serve` delegates to the same `startDevServer` every other E2E in this
 * suite drives, so those tests are the real oracle; this file adds the direct proof that a runtime
 * served THROUGH the seam still answers `GET /api/health`, round-trips a `POST /api/run` mutation,
 * and fans a commit out to a live WebSocket subscription — plus the `satisfies RuntimeHost` check.
 */
import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime, type RuntimeHost } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { loadProject, ProcessRuntimeHost, type LoadedProject } from "../src/index";

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

async function makeRuntime(): Promise<EmbeddedRuntime> {
  const project = loadProject(loaded);
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  return createEmbeddedRuntime({ store, catalog: project.catalog, modules: project.moduleMap });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("ProcessRuntimeHost (the RuntimeHost seam)", () => {
  it("is a RuntimeHost", () => {
    // Compile-time: the process host structurally satisfies the neutral seam. Runtime: it exists.
    const host = new ProcessRuntimeHost() satisfies RuntimeHost;
    expect(typeof host.serve).toBe("function");
  });

  it("serves health + a run mutation through host.serve()", async () => {
    const runtime = await makeRuntime();
    const server = await new ProcessRuntimeHost().serve(runtime, { port: 0, ip: "127.0.0.1" });
    try {
      const health = await fetch(`${server.url}/api/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe("ok");

      const run = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "messages:send", args: { conversationId: "c1", body: "via-seam" } }),
      });
      expect(run.status).toBe(200);
      expect(typeof (await run.json()).value).toBe("string");
    } finally {
      await server.close();
    }
  });

  it("fans a commit out to a live WebSocket subscription through host.serve()", async () => {
    const runtime = await makeRuntime();
    const server = await new ProcessRuntimeHost().serve(runtime, { port: 0, ip: "127.0.0.1" });
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;
    const clientA = new StackbaseClient(webSocketTransport(wsUrl));
    const clientB = new StackbaseClient(webSocketTransport(wsUrl));
    try {
      const updates: Array<Array<{ body: string }>> = [];
      clientA.subscribe(api.messages.list, { conversationId: "c1" }, (val) => updates.push(val as Array<{ body: string }>));
      await waitFor(() => updates.length >= 1);
      expect(updates[0]).toEqual([]);

      await clientB.mutation(api.messages.send, { conversationId: "c1", body: "pushed-via-seam" });
      await waitFor(() => updates.length >= 2);
      expect(updates.at(-1)!.map((d) => d.body)).toEqual(["pushed-via-seam"]);
    } finally {
      clientA.close();
      clientB.close();
      await server.close();
    }
  });
});
