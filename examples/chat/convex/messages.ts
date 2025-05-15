import { query, mutation } from "./_generated/server";

export const send = mutation({
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
