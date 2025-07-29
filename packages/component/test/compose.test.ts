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

  it("throws on a duplicate table full-name instead of silently aliasing", () => {
    const dup = defineComponent({ name: "auth", schema: defineSchema({ sessions: defineTable({ y: v.string() }) }), modules: {} });
    expect(() => composeTables({ app: { schemaJson: appSchema }, components: [auth, dup] })).toThrow(/duplicate table/);
  });

  it("rejects a table name containing a namespace separator", () => {
    const bad = defineSchema({ "a/b": defineTable({ x: v.string() }) }).export();
    expect(() => composeTables({ app: { schemaJson: bad }, components: [] })).toThrow(/may not contain/);
  });

  describe("existingTableNumbers (deploy renumber-safety)", () => {
    const scheduler = defineComponent({
      name: "scheduler",
      schema: defineSchema({ jobs: defineTable({ x: v.string() }) }),
      modules: {},
    });
    const notesPlusTagsSchema = defineSchema({
      notes: defineTable({ body: v.string() }),
      tags: defineTable({ name: v.string() }),
    }).export();

    it("without a seed: today's positional numbering (app first, then components) — unchanged", () => {
      const { tableNumbers } = composeTables({ app: { schemaJson: notesPlusTagsSchema }, components: [scheduler] });
      // app tables (notes, tags) get 10001/10002; the component table comes after, at 10003.
      expect(tableNumbers["notes"]).toBe(10001);
      expect(tableNumbers["tags"]).toBe(10002);
      expect(tableNumbers["scheduler/jobs"]).toBe(10003);
    });

    it("with a seed: existing tables (app AND component) keep their numbers; only the new table gets a fresh one", () => {
      const { tableNumbers } = composeTables({
        app: { schemaJson: notesPlusTagsSchema },
        components: [scheduler],
        existingTableNumbers: { notes: 10001, "scheduler/jobs": 10002 },
      });
      expect(tableNumbers["notes"]).toBe(10001); // unchanged
      expect(tableNumbers["scheduler/jobs"]).toBe(10002); // unchanged — the critical assertion
      expect(tableNumbers["tags"]).toBeGreaterThan(10002); // new table, NOT 10002 (no collision)
      expect(tableNumbers["tags"]).not.toBe(10002);
    });
  });
});
