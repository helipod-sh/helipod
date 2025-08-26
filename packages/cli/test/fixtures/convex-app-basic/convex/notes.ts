import { mutation, query } from "./_generated/server";
export const add = mutation({ handler: (ctx, args: { body: string }) => ctx.db.insert("notes", { body: args.body }) });
export const list = query({ handler: async (ctx) => (await ctx.db.query("notes", "by_creation").collect()).map((d: { body: string }) => d.body) });
