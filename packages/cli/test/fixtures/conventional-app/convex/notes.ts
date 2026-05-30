import { query, mutation } from "./_generated/server";

// The conventional Convex/Stackbase authoring shape — value imports from ./_generated/server
// (extensionless). This is what real apps + every example use, and what fails under Node's ESM
// resolver with bare import(). loadConvexDir only IMPORTS this module (to read its exports); the
// handlers are never executed here.
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});
