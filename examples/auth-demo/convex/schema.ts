import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});
