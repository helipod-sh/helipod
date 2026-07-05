import { v, defineSchema, defineTable } from "@helipod/values";

// v2: additive only — same table/index, plus a new OPTIONAL field. tableNumbers must stay stable
// with v1 for `diffSchema` to accept this as a valid live hot-swap.
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string(), pinned: v.optional(v.boolean()) }).index("by_box", [
    "box",
  ]),
});
