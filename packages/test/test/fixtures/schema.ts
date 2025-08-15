import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  messages: defineTable({ body: v.string() }),
});
