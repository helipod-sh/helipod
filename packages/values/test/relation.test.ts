import { describe, it, expect } from "vitest";
import { defineTable, v } from "../src/index";

describe("TableDefinition.relation", () => {
  it("serializes declared to-many relations into the table JSON", () => {
    const t = defineTable({ ownerId: v.string(), orgId: v.id("orgs") })
      .relation("sharedWith", { table: "document_shares", field: "documentId" });
    expect(t.export().relations).toEqual([{ name: "sharedWith", table: "document_shares", field: "documentId" }]);
  });

  it("defaults to an empty relations array when none are declared", () => {
    expect(defineTable({ a: v.string() }).export().relations).toEqual([]);
  });

  it("is chainable with index()/shardKey()", () => {
    const t = defineTable({ conversationId: v.id("conversations"), body: v.string() })
      .index("by_conv", ["conversationId"])
      .relation("reactions", { table: "reactions", field: "messageId" })
      .shardKey("conversationId");
    const j = t.export();
    expect(j.relations).toEqual([{ name: "reactions", table: "reactions", field: "messageId" }]);
    expect(j.indexes).toHaveLength(1);
    expect(j.shardKey).toBe("conversationId");
  });
});
