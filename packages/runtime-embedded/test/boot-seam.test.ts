import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents, defineComponent } from "@helipod/component";
import { EmbeddedRuntime } from "../src/index";
import { defineSchema, defineTable, v, type SchemaDefinition } from "@helipod/values";
import { query } from "@helipod/executor";

const bootc = defineComponent({
  name: "bootc",
  schema: defineSchema({ marks: defineTable({ note: v.string() }) }) as unknown as SchemaDefinition,
  modules: { list: query(async (ctx) => ctx.db.query("marks", "by_creation").collect()) },
  boot: async (ctx) => { await ctx.db.insert("marks", { note: "booted" }); },
});

describe("component boot seam", () => {
  it("runs a component's boot step once at runtime create (namespaced write)", async () => {
    const c = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [bootc]);
    expect(c.bootSteps).toHaveLength(1);
    const r = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: c.catalog, modules: c.moduleMap, componentNames: c.componentNames, bootSteps: c.bootSteps,
    });
    const rows = (await r.run<any[]>("bootc:list", {})).value;
    expect(rows.map((m) => m.note)).toEqual(["booted"]);
  });
});
