import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";

describe("driver seam", () => {
  it("starts a component driver after boot; onCommit fires on a commit; runFunction runs a registered fn", async () => {
    const commits: number[] = [];
    let ran = 0;
    const driver = {
      name: "toy",
      start(ctx: any) {
        ctx.onCommit((inv: any) => { commits.push(inv.commitTs); void ctx.runFunction("toy:bump", {}); });
      },
    };
    const schema = defineSchema({ counters: defineTable({ n: v.number() }) });
    const c = composeComponents(
      { schemaJson: schema.export(), moduleMap: { "app:add": mutation(async (ctx) => ctx.db.insert("counters", { n: 1 })) } },
      [{ name: "toy", schema: defineSchema({}), modules: { bump: mutation(async () => { ran += 1; return null; }) }, driver }],
    );
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: c.catalog, modules: c.moduleMap,
      componentNames: c.componentNames, contextProviders: c.contextProviders, policyRegistry: c.policyRegistry,
      policyProviders: c.policyProviders, relationRegistry: c.relationRegistry, bootSteps: c.bootSteps, drivers: c.drivers,
    });
    await r.run("app:add", {});
    await new Promise((res) => setTimeout(res, 30)); // let the async commit fan-out + runFunction settle
    expect(commits.length).toBeGreaterThan(0);       // onCommit fired for the app:add commit
    expect(ran).toBeGreaterThan(0);                  // runFunction("toy:bump") executed
  });
});
