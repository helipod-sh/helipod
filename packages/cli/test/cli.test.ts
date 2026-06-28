import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import {
  loadProject,
  push,
  resolveDevOptions,
  handleHttpRequest,
  startDevServer,
  type LoadedProject,
} from "../src/index";

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

async function makeRuntime(): Promise<{ runtime: EmbeddedRuntime; functions: string[]; tables: string[] }> {
  const project = loadProject(loaded);
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const runtime = await createEmbeddedRuntime({ store, catalog: project.catalog, modules: project.moduleMap });
  return { runtime, functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) };
}

describe("loadProject", () => {
  it("builds the catalog, module map, and manifest from schema + modules", () => {
    const p = loadProject(loaded);
    expect(Object.keys(p.moduleMap).sort()).toEqual(["messages:list", "messages:send"]);
    expect(p.tableNumbers.messages).toBe(10001);
    expect(p.tableNumbers.conversations).toBe(10002);
    expect(p.catalog.getIndex("messages", "by_conversation")?.fields).toEqual(["conversationId"]);
    expect(p.catalog.getIndex("messages", "by_creation")).toBeDefined(); // implicit default index
    const mod = p.manifest.find((m) => m.path === "messages")!;
    expect(mod.functions.map((f) => `${f.name}:${f.type}`).sort()).toEqual(["list:query", "send:mutation"]);
  });
});

describe("push (load → codegen)", () => {
  it("produces typed generated files", () => {
    const { generated } = push(loaded);
    expect(generated.dataModel.content).toContain('messages: { document: { _id: Id<"messages">; _creationTime: number; conversationId: Id<"conversations">; body: string } };');
    expect(generated.api.content).toContain('send: FunctionReference<"mutation"');
    expect(generated.files).toHaveLength(5); // dataModel, api, internal, server, ids
  });
});

describe("resolveDevOptions", () => {
  it("applies defaults and overrides", () => {
    expect(resolveDevOptions()).toMatchObject({ port: 3000, ip: "127.0.0.1", functionsDir: "stackbase" });
    expect(resolveDevOptions({ port: 9000, functionsDir: "backend" })).toMatchObject({ port: 9000, functionsDir: "backend" });
  });
});

describe("HTTP routing", () => {
  it("serves the dashboard, health, and direct function runs", async () => {
    const { runtime, functions, tables } = await makeRuntime();
    const info = { functions, tables };

    const dash = await handleHttpRequest(runtime, { method: "GET", path: "/_dashboard" }, info);
    expect(dash.status).toBe(200);
    expect(dash.body).toContain("Stackbase");

    const health = await handleHttpRequest(runtime, { method: "GET", path: "/api/health" }, info);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });

    const sent = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/api/run", body: JSON.stringify({ path: "messages:send", args: { conversationId: "c1", body: "hi" } }) },
      info,
    );
    expect(sent.status).toBe(200);
    expect(typeof JSON.parse(sent.body).value).toBe("string");

    const list = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/api/run", body: JSON.stringify({ path: "messages:list", args: { conversationId: "c1" } }) },
      info,
    );
    expect((JSON.parse(list.body).value as Array<{ body: string }>).map((d) => d.body)).toEqual(["hi"]);

    const bad = await handleHttpRequest(runtime, { method: "POST", path: "/api/run", body: JSON.stringify({ path: "nope" }) }, info);
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });
});

describe("dev server (real node:http)", () => {
  it("boots and responds over HTTP", async () => {
    const { runtime } = await makeRuntime();
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    try {
      const dash = await fetch(`${server.url}/_dashboard`);
      expect(dash.status).toBe(200);
      expect(await dash.text()).toContain("Stackbase");

      const run = await fetch(`${server.url}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "messages:send", args: { conversationId: "c1", body: "over-http" } }),
      });
      expect(run.status).toBe(200);
      expect(typeof (await run.json()).value).toBe("string");
    } finally {
      await server.close();
    }
  });

  it("reports live function/table counts after a hot-swap, not a stale boot snapshot", async () => {
    const { runtime } = await makeRuntime();
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    try {
      const before = await (await fetch(`${server.url}/api/health`)).json();
      expect(before.functions).toBe(2); // messages:list + messages:send

      // Hot-swap in an extra function, as a deploy / dev reload does. Health must reflect it live —
      // the count was previously a boot-time snapshot that went stale after the first setModules.
      const base = loadProject(loaded).moduleMap;
      runtime.setModules({ ...base, "messages:extra": base["messages:list"]! });

      const after = await (await fetch(`${server.url}/api/health`)).json();
      expect(after.functions).toBe(3);
    } finally {
      await server.close();
    }
  });
});

describe("hot reload (setModules)", () => {
  it("swaps functions while preserving stored data", async () => {
    const { runtime } = await makeRuntime();
    await runtime.run("messages:send", { conversationId: "c1", body: "before reload" });

    // Reload: re-register the (same) module map — the store and its data survive.
    const reloaded = loadProject(loaded);
    runtime.setModules(reloaded.moduleMap);

    const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(list.value.map((d) => d.body)).toEqual(["before reload"]); // data persisted across reload

    // Swapping to an empty map makes the old function unresolvable (proves the swap is live).
    runtime.setModules({});
    await expect(runtime.run("messages:send", { conversationId: "c1", body: "x" })).rejects.toThrow(/unknown function/);
  });
});

describe("dev options: functions directory", () => {
  it("resolves to stackbase by default", () => {
    expect(resolveDevOptions({}).functionsDir).toBe("stackbase");
  });

  it("honors an explicit value", () => {
    expect(resolveDevOptions({ functionsDir: "convex" }).functionsDir).toBe("convex");
  });
});
