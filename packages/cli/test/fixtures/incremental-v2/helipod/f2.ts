import { query, mutation } from "@helipod/executor";

export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

// v2 adds this mutation via a delta deploy that changes ONLY this file — the E2E proves it's
// callable immediately and fans out reactively to a subscription opened before the deploy, while
// schema.ts/f1.ts land in `unchanged`.
export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});
