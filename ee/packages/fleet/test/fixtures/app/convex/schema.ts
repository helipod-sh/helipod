import { v, defineSchema, defineTable } from "@stackbase/values";

// v2: additive only — same table/index, plus a new OPTIONAL field. tableNumbers must stay stable
// with v1 for `diffSchema` to accept this as a valid live hot-swap.
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string(), pinned: v.optional(v.boolean()) }).index("by_box", [
    "box",
  ]),
  // Sharded table (Shards B2a) — routed by `channelId` (mirrors examples/chat's `messages`
  // `.shardKey("conversationId")`). Every tier evaluates the ownership guards; the fleet E2E
  // uses two channelId values routing to DIFFERENT shards to prove cross-shard commits, a
  // consistent cross-shard subscription, and the write guard through the real server.
  messages: defineTable({ channelId: v.string(), body: v.string() })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});
