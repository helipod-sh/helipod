import { query, mutation } from "@helipod/executor";

export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});
