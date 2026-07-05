import { v, defineSchema, defineTable } from "@helipod/values";

// Shards B2a (T5) dev-tier fixture: a table sharded by `channelId`, exercising the SAME
// always-on kernel ownership guards at Tier 0 (`helipod dev`'s virtual shards) as fleet —
// see packages/cli/test/shard-dev-boot.test.ts.
export default defineSchema({
  messages: defineTable({ channelId: v.string(), body: v.string() })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});
