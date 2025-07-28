import { query } from "@stackbase/executor";

// v1 ships only the query — `notes:add` doesn't exist yet until v2 is deployed live.
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});
