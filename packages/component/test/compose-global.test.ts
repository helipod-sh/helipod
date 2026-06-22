import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { composeTables } from "../src/compose";

function app(schema: ReturnType<typeof defineSchema>) {
  return { app: { schemaJson: schema.export(), moduleMap: {} } as never, components: [] as never[] };
}

describe("composeTables + .global()", () => {
  it("a .global() table gets catalog mode 'global'", () => {
    const { catalog } = composeTables(app(defineSchema({
      users: defineTable({ email: v.string() }).global().index("by_email", ["email"], { unique: true }),
    })) as never);
    expect(catalog.getTable("users")!.mode).toBe("global");
  });
  it("rejects .unique() on a .shardBy table at schema-load", () => {
    expect(() => composeTables(app(defineSchema({
      msgs: defineTable({ room: v.string(), handle: v.string() }).shardKey("room").index("by_handle", ["handle"], { unique: true }),
    })) as never)).toThrow(/unique.*shard|shard.*unique/i);
  });
  it("allows .unique() on a .global() table", () => {
    expect(() => composeTables(app(defineSchema({
      u: defineTable({ email: v.string() }).global().index("by_email", ["email"], { unique: true }),
    })) as never)).not.toThrow();
  });

  // ── Whole-branch review Fix 2: .global() is app-schema-only, not component-schema ────────────
  it("rejects a .global() table declared inside a COMPONENT schema at compose time", () => {
    const componentSchema = defineSchema({
      widgets: defineTable({ label: v.string() }).global(),
    });
    const input = {
      app: { schemaJson: defineSchema({}).export(), moduleMap: {} } as never,
      components: [
        {
          name: "acme",
          schema: componentSchema,
          modules: {},
        },
      ] as never[],
    };
    expect(() => composeTables(input as never)).toThrow(
      /\.global\(\) tables are only supported in the app schema.*table "widgets".*component "acme"/is,
    );
  });

  it("does NOT throw for a .global() table declared in the APP schema alongside a component", () => {
    const input = {
      app: {
        schemaJson: defineSchema({
          users: defineTable({ email: v.string() }).global(),
        }).export(),
        moduleMap: {},
      } as never,
      components: [
        {
          name: "acme",
          schema: defineSchema({ local: defineTable({ n: v.number() }) }),
          modules: {},
        },
      ] as never[],
    };
    expect(() => composeTables(input as never)).not.toThrow();
  });
});
