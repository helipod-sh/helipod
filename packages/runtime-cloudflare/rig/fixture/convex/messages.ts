import { query, mutation } from "@stackbase/executor";

export const send = mutation<{ conversationId: string; body: string }, string>({
  handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
});

export const list = query<{ conversationId: string }, unknown[]>({
  handler: (ctx, { conversationId }) =>
    ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
});
