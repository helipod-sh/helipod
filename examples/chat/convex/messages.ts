import { query, mutation } from "./_generated/server";

// `messages` is sharded by `conversationId` (schema.ts), so a mutation that writes it must
// declare which shard it runs on — `shardBy: "conversationId"` routes each send to the shard
// owning that conversation. Omitting it is a shard mistake the engine rejects at every tier.
export const send = mutation({
  shardBy: "conversationId",
  handler: (ctx, args: { conversationId: string; author: string; body: string }) =>
    ctx.db.insert("messages", { conversationId: args.conversationId, author: args.author, body: args.body }),
});

export const list = query({
  handler: (ctx, args: { conversationId: string }) =>
    ctx.db.query("messages", "by_conversation").eq("conversationId", args.conversationId).collect(),
});

export const listPaginated = query({
  handler: (ctx, args: { conversationId: string; cursor?: string | null; pageSize?: number }) =>
    ctx.db
      .query("messages", "by_conversation")
      .eq("conversationId", args.conversationId)
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, pageSize: args.pageSize ?? 20 }),
});
