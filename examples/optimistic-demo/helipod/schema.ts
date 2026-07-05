import { defineSchema, defineTable, v } from "@helipod/values";

// Counters live ON option rows: each vote is a read-modify-write increment, so rapid fire shows
// stacked optimistic layers as a climbing number — the demo's whole point.
export default defineSchema({
  polls: defineTable({
    question: v.string(),
    closed: v.boolean(),
  }),
  options: defineTable({
    pollId: v.id("polls"),
    label: v.string(),
    votes: v.number(),
    // DEVIATION from the task-1 brief's verbatim schema: all option rows created by one
    // `polls:create` call share the same `_creationTime` (the mutation's single snapshotTs), and
    // the `by_poll` index's tiebreak is a random 16-byte `_id` — so without an explicit ordinal,
    // `options:list`'s row order for a poll's initial options is non-deterministic. `order`
    // pins the label array's original position; `options:list` sorts by it.
    order: v.number(),
  }).index("by_poll", ["pollId"]),
});
