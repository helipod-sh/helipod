import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { defineComponent } from "../src/define-component";
import { composeTables } from "../src/compose";

const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) }).export();
const auth = defineComponent({ name: "auth", schema: defineSchema({ sessions: defineTable({ token: v.string() }) }), modules: {} });
const other = defineComponent({ name: "other", schema: defineSchema({ sessions: defineTable({ x: v.string() }) }), modules: {} });

describe("composeTables", () => {
  it("namespaces component tables so same-named tables don't collide", () => {
    const { tableNumbers } = composeTables({ app: { schemaJson: appSchema }, components: [auth, other] });
    // app table stays bare; component tables are namespaced
    expect(tableNumbers["messages"]).toBeGreaterThan(0);
    expect(tableNumbers["auth/sessions"]).toBeGreaterThan(0);
    expect(tableNumbers["other/sessions"]).toBeGreaterThan(0);
    // the two `sessions` tables get DISTINCT numbers (no collision)
    expect(tableNumbers["auth/sessions"]).not.toBe(tableNumbers["other/sessions"]);
  });

  it("registers each table's by_creation index in the catalog under its full name", () => {
    const { catalog } = composeTables({ app: { schemaJson: appSchema }, components: [auth] });
    expect(catalog.getTable("messages")?.tableNumber).toBeGreaterThan(0);
    expect(catalog.getTable("auth/sessions")?.tableNumber).toBeGreaterThan(0);
  });
});
