// Mirrors packages/runtime-embedded/test/action-run.test.ts's harness (composeComponents +
// EmbeddedRuntime.create — the non-cyclic integration point), but exercises the public
// `runtime.runHttpAction` (Task 3): dispatch an httpAction by path, pass the raw `Request`
// through untouched, and return the handler's `Response`.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { defineSchema, defineTable, v } from "@helipod/values";
import { query, mutation, httpAction } from "@helipod/executor";
import { EmbeddedRuntime } from "../src/index";

async function makeRuntime(modules: Record<string, any>) {
  const schema = defineSchema({ notes: defineTable({ body: v.string() }) });
  const c = composeComponents({ schemaJson: schema.export(), moduleMap: modules }, []);
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
    componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
    policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    tableNumbers: c.tableNumbers,
  });
}

describe("runtime.runHttpAction", () => {
  it("runs an httpAction by path and returns its Response", async () => {
    const r = await makeRuntime({
      "http:ping": httpAction(async () => new Response("pong", { status: 200 })),
    });
    const res = await r.runHttpAction("http:ping", new Request("http://x/ping", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("threads the raw Request through untouched (method + body visible to the handler)", async () => {
    const r = await makeRuntime({
      "http:echo": httpAction(async (_ctx: any, req: Request) => {
        const body = await req.text();
        return new Response(JSON.stringify({ method: req.method, body }), { status: 201 });
      }),
    });
    const res = await r.runHttpAction("http:echo", new Request("http://x/echo", { method: "POST", body: "hello" }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ method: "POST", body: "hello" });
  });

  it("rejects an internal path", async () => {
    const r = await makeRuntime({
      "http:_secret": httpAction(async () => new Response("nope")),
    });
    await expect(r.runHttpAction("http:_secret", new Request("http://x/s"))).rejects.toThrow(/unknown function/);
  });

  it("rejects an unknown path", async () => {
    const r = await makeRuntime({
      "http:ping": httpAction(async () => new Response("pong")),
    });
    await expect(r.runHttpAction("http:missing", new Request("http://x/m"))).rejects.toThrow(/unknown function/);
  });

  it("rejects a non-httpAction path", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).map((d: any) => d.body)),
    });
    await expect(r.runHttpAction("app:list", new Request("http://x/q"))).rejects.toThrow(/not an httpAction/);
  });
});
