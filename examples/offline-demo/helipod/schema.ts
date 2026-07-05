import { defineSchema, defineTable, v } from "@helipod/values";

// Both tables are deliberately UNSHARDED (no .shardKey()): client-supplied `mintId` ids — the
// offline create-then-reference chain this example exists to demonstrate — are v1-restricted to
// unsharded tables on the default ring (docs/enduser/offline.md, "v1 restrictions").
export default defineSchema({
  lists: defineTable({
    name: v.string(),
    locked: v.boolean(),
  }),
  items: defineTable({
    listId: v.id("lists"),
    label: v.string(),
    done: v.boolean(),
  }).index("by_list", ["listId"]),
});
