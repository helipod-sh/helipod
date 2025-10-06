import { v } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";

// `messages` is sharded by `channelId` (schema.ts). A mutation that writes it must declare which
// shard it runs on — `shardBy: "channelId"` routes each send to the shard owning that channel.
// The args validator names `channelId` (required, same string type as the table's shard-key field)
// so codegen's D7 cross-check passes; the kernel's per-document ownership guard is the always-on
// backstop at every tier.
export const send = mutation({
  args: { channelId: v.string(), body: v.string() },
  shardBy: "channelId",
  handler: (ctx, args) => ctx.db.insert("messages", { channelId: args.channelId, body: args.body }),
});

// Schedules a `messages:send` for `delayMs` from now (Convex-parity `ctx.scheduler.runAfter`). Used
// by the fleet multi-writer E2E's driver-forward proof: this scheduling mutation writes an unsharded
// `scheduler/jobs` row (so it runs on the DEFAULT-shard holder — the node the scheduler driver runs
// on), and when the driver later dispatches the due job, `messages:send`'s `shardBy: "channelId"`
// routes the dispatch to whichever writer owns that channel's shard — forwarding cross-node when that
// is a DIFFERENT node than the driver's. `ctx` is cast to `any` (the scheduler surface is injected by
// the composed component, exactly as in `packages/cli/test/scheduler-e2e.test.ts`).
export const scheduleSend = mutation({
  args: { channelId: v.string(), body: v.string(), delayMs: v.number() },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (ctx: any, args) =>
    ctx.scheduler.runAfter(args.delayMs, "messages:send", { channelId: args.channelId, body: args.body }),
});

// Cross-shard list: a QUERY reads every shard (the scan guard short-circuits for non-sharded
// readers), so an open scan over `by_channel` returns rows from ALL shards — the substrate for the
// consistent cross-shard subscription proof.
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("messages", "by_channel").collect()).map((d) => ({ channelId: d.channelId, body: d.body })),
});

// Wrong-shard write: the mutation's `shardBy` resolves its shard from the `channelId` arg, but the
// handler inserts a document whose OWN `channelId` field is `misroutedTo`. When those two values
// route to different shards, the kernel's write guard rejects the insert (the document does not
// belong on the shard the mutation runs on) — proving the guard fires through the real server.
export const sendMisrouted = mutation({
  args: { channelId: v.string(), misroutedTo: v.string(), body: v.string() },
  shardBy: "channelId",
  handler: (ctx, args) => ctx.db.insert("messages", { channelId: args.misroutedTo, body: args.body }),
});
