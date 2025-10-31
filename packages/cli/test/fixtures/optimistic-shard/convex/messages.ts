import { mutation, query } from "@stackbase/executor";
import { v } from "@stackbase/values";

// `messages` is sharded by `channelId` (schema.ts) — a mutation that writes it declares which
// shard it runs on via `shardBy` (mirrors examples/chat's `messages:send`).
export const send = mutation({
  args: { channelId: v.string(), body: v.string() },
  shardBy: "channelId",
  handler: (ctx, args) => ctx.db.insert("messages", { channelId: args.channelId, body: args.body }),
});

// CROSS-SHARD read: a full `by_channel` scan with no shard-key filter reads every shard's ring.
export const listAll = query({
  args: {},
  handler: (ctx) => ctx.db.query("messages", "by_channel").collect(),
});
