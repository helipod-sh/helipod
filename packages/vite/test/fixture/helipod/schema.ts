import { defineSchema, defineTable, v } from "@helipod/values";
export default defineSchema({ notes: defineTable({ text: v.string() }) });
