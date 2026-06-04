import { defineSchema, defineTable, v } from "@stackbase/values";
export default defineSchema({ notes: defineTable({ text: v.string() }) });
