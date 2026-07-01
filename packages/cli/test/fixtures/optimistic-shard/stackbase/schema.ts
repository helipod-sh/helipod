import { v, defineSchema, defineTable } from "@stackbase/values";

// Optimistic-updates D12 fixture (packages/cli/test/optimistic-e2e.test.ts): a table sharded by
// `channelId`, exercising the always-on kernel ownership guards at Tier 0 (`stackbase dev`'s
// virtual shards). `listAll` is a deliberately CROSS-SHARD query (full index scan, no shard-key
// `.eq`) — the read set spans every shard, which is what makes the concurrent cross-shard
// no-flicker race reachable.
export default defineSchema({
  messages: defineTable({ channelId: v.string(), body: v.string() })
    .index("by_channel", ["channelId"])
    .shardKey("channelId"),
});
