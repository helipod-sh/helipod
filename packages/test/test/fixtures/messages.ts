import { mutation, query } from "@stackbase/executor";

export const send = mutation(async (ctx: any, args: { body: string }) => ctx.db.insert("messages", { body: args.body }));
export const list = query(async (ctx: any) => ctx.db.query("messages", "by_creation").collect());
