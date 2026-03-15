import { query, mutation } from "./_generated/server";

export const get = query(async (ctx) => ctx.auth.getUserId());

export const myNotes = query(async (ctx) => {
  const uid = await ctx.auth.getUserId();
  if (!uid) return [];
  return ctx.db.query("notes", "byUser").eq("userId", uid).collect();
});

export const add = mutation(async (ctx, { body }: { body: string }) => {
  const uid = await ctx.auth.getUserId();
  if (!uid) throw new Error("not authenticated");
  return ctx.db.insert("notes", { userId: uid, body });
});
