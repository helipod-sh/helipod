// Integration-level counterpart to packages/executor/test/action-run.test.ts: that test exercises
// the executor's action branch + invoke seam directly (self-contained, no component composition,
// to avoid a package-graph cycle — @helipod/component/@helipod/runtime-embedded both depend on
// @helipod/executor). This test lives here instead, where composeComponents/EmbeddedRuntime are
// already real (non-cyclic) dependencies, and exercises the FULL path: runtime.ts's `let executorRef`
// closure wiring `invoke` into the executor, and the public `runtime.runAction`.
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { defineSchema, defineTable, v } from "@helipod/values";
import { query, mutation, action } from "@helipod/executor";
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

describe("action execution (runtime wiring)", () => {
  it("runs an action outside a txn; ctx.runMutation commits; ctx.runQuery reads it back; native globals work; NO ctx.db", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).map((d: any) => d.body)),
      "app:act": action(async (ctx: any, a: { body: string }) => {
        expect((ctx as any).db).toBeUndefined();               // core invariant: no db
        const rnd = Math.random(); const t = Date.now();        // native globals available
        await ctx.runMutation("app:add", { body: a.body });     // fresh write txn
        const list = await ctx.runQuery("app:list", {});        // fresh read txn, sees the write
        return { list, hadRandom: typeof rnd === "number", hadClock: typeof t === "number" };
      }),
    });
    const res = await r.runAction("app:act", { body: "hello" });
    expect((res.value as any).list).toEqual(["hello"]);
    expect((res.value as any).hadRandom && (res.value as any).hadClock).toBe(true);
  });

  it("a nested ctx.runAction runs; a handler throw rejects with the error", async () => {
    const r = await makeRuntime({
      "app:inner": action(async () => 42),
      "app:outer": action(async (ctx: any) => await ctx.runAction("app:inner", {})),
      "app:boom": action(async () => { throw new Error("kaboom"); }),
    });
    expect((await r.runAction("app:outer", {})).value).toBe(42);
    await expect(r.runAction("app:boom", {})).rejects.toThrow(/kaboom/);
  });

  it("runAction rejects an unknown path and a non-action path", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
    });
    await expect(r.runAction("app:missing", {})).rejects.toThrow();
    await expect(r.runAction("app:add", { body: "x" })).rejects.toThrow(/not an action/);
  });
});
