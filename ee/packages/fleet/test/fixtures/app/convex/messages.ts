import { v } from "@helipod/values";
import { query, mutation } from "@helipod/executor";

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

// Sharded read-modify-write: read the (single, pre-seeded) message for `channelId` on the shard that
// owns it, then replace its body with a bumped `<body>#<n>` suffix. Helipod has no `ctx.db.patch`
// (a documented Convex divergence) — read-merge-replace, same shape as `notes:update`. `shardBy`
// routes the whole RMW to the channel's owning shard. Used by the B4 group-commit concurrent-load
// E2E as the 20% RMW slice of the storm (each client bumps its OWN dedicated channel, so the RMWs
// exercise the read-then-replace path + grow the MVCC chain per doc WITHOUT cross-client same-doc
// contention — the storm's zero-error invariant, not an OCC-conflict probe).
export const bump = mutation({
  args: { channelId: v.string() },
  shardBy: "channelId",
  handler: async (ctx, args) => {
    const docs = await ctx.db.query("messages", "by_channel").eq("channelId", args.channelId).collect();
    const d = docs[0];
    if (!d) return null; // channel not seeded — no-op rather than throw (keeps the storm error-free)
    const body = d.body;
    const m = /#(\d+)$/.exec(body);
    const next = m ? Number(m[1]) + 1 : 1;
    await ctx.db.replace(d["_id"] as string, { ...d, body: `${body.replace(/#\d+$/, "")}#${next}` });
    return null;
  },
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
