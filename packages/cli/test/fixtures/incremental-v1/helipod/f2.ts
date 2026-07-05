import { query } from "@helipod/executor";

// f2 v1: only `list` exists — `f2:add` doesn't exist yet until the ONE-FILE delta deploy (v2)
// lands it live.
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});
