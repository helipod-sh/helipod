import { defineSchema, defineTable, v } from "@helipod/values";

export default defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});
