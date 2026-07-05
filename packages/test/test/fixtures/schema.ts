import { defineSchema, defineTable, v } from "@helipod/values";

export default defineSchema({
  messages: defineTable({ body: v.string() }),
});
