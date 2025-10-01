import { v } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";

// `messages` is sharded by `channelId` (schema.ts) — a mutation that writes it must declare
// which shard it runs on via `shardBy`. This mirrors examples/chat's `messages:send`.
export const send = mutation({
  args: { channelId: v.string(), body: v.string() },
  shardBy: "channelId",
  handler: (ctx, args) => ctx.db.insert("messages", { channelId: args.channelId, body: args.body }),
});

// Deliberately routes on `channelId` but WRITES `otherChannelId` into the sharded field — a
// cross-shard mismatch the kernel's write-ownership guard must reject (see
// packages/cli/test/shard-dev-boot.test.ts, which proves this errors only once the REAL
// NUM_SHARDS is threaded end to end through the dev boot path).
export const sendWrongShard = mutation({
  args: { channelId: v.string(), otherChannelId: v.string(), body: v.string() },
  shardBy: "channelId",
  handler: (ctx, args) => ctx.db.insert("messages", { channelId: args.otherChannelId, body: args.body }),
});

export const list = query({
  args: { channelId: v.string() },
  handler: (ctx, args) => ctx.db.query("messages", "by_channel").eq("channelId", args.channelId).collect(),
});
