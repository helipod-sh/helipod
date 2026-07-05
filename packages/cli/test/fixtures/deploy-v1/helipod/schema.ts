import { v, defineSchema, defineTable } from "@helipod/values";

// v1: a `notes` table (box, text) with a secondary index — the deploy E2E's initial live schema.
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});
