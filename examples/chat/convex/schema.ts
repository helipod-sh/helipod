import { defineSchema, defineTable, v } from "@stackbase/values";

export default defineSchema({
  conversations: defineTable({
    title: v.string(),
  }),
  messages: defineTable({
    conversationId: v.id("conversations"),
    author: v.string(),
    body: v.string(),
  })
    .index("by_conversation", ["conversationId"])
    // The conversation is the shard key (scale-seam #1): single-writer-per-conversation
    // at Tier 2, unbounded write scale. At Tier 0 it's metadata; the same code spans both.
    .shardKey("conversationId"),
  // `@stackbase/triggers` reference pattern (see `../stackbase.config.ts` + `./audit.ts`): one row
  // per delivered `messages` change, keyed by the log's own stable `changeId` so a redelivered
  // change (the documented at-least-once bound — see `docs/enduser/triggers.md`) is a no-op, not a
  // duplicate row.
  auditLog: defineTable({
    changeId: v.string(),
    table: v.string(),
    docId: v.string(),
    op: v.string(),
  }).index("by_changeId", ["changeId"]),
});
