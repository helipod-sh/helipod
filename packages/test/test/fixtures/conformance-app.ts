import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

export const schema = defineSchema({
  docs: defineTable({ owner: v.string(), n: v.number(), tag: v.string(), note: v.optional(v.string()) }).index("by_owner_n", ["owner", "n"]),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;
export const mod = {
  insert: mutation(async (ctx: A, a: A) => ctx.db.insert("docs", a)),
  // Stackbase has NO ctx.db.patch — partial update is read-merge-replace (a documented Convex divergence).
  patchViaReplace: mutation(async (ctx: A, a: { id: string; patch: A }) => {
    const cur = await ctx.db.get(a.id);
    await ctx.db.replace(a.id, { ...cur, ...a.patch });
    return null;
  }),
  replace: mutation(async (ctx: A, a: { id: string; doc: A }) => { await ctx.db.replace(a.id, a.doc); return null; }),
  del: mutation(async (ctx: A, a: { id: string }) => { await ctx.db.delete(a.id); return null; }),
  get: query(async (ctx: A, a: { id: string }) => ctx.db.get(a.id)),
  allDesc: query(async (ctx: A) => ctx.db.query("docs", "by_creation").order("desc").collect()),
  ownerRange: query(async (ctx: A, a: { owner: string; lo: number; hi: number }) =>
    ctx.db.query("docs", "by_owner_n").eq("owner", a.owner).gte("n", a.lo).lt("n", a.hi).collect()),
  ownerEq: query(async (ctx: A, a: { owner: string }) =>
    ctx.db.query("docs", "by_owner_n").eq("owner", a.owner).collect()),
  page: query(async (ctx: A, a: { cursor: string | null; num: number }) =>
    ctx.db.query("docs", "by_creation").paginate({ cursor: a.cursor, pageSize: a.num })),
};
