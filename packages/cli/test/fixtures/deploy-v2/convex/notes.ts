import { query, mutation } from "@stackbase/executor";

export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

// v2 adds this mutation — the E2E proves it's callable (and reactively fans out) immediately
// after a live deploy, with no server restart.
export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});
