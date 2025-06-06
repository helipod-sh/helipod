import { query } from "./_generated/server";
export const get = query(async (ctx) => ctx.auth.getUserId());
