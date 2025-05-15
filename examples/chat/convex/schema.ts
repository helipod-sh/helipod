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
});
