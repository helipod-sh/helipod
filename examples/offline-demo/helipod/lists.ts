import { v } from "@helipod/values";
import { query, mutation } from "./_generated/server";

const listShape = v.object({
  _id: v.id("lists"),
  _creationTime: v.number(),
  name: v.string(),
  locked: v.boolean(),
});

export const list = query({
  args: {},
  returns: v.array(listShape),
  // Every table carries the implicit `by_creation` index (creation order) — there is no bare
  // full-table scan; an index name is always required.
  handler: (ctx) => ctx.db.query("lists", "by_creation").collect(),
});

export const create = mutation({
  // `_id` optional: when present it's a client-minted id (mintId, offline create-then-reference)
  // passed straight through to insert — the documented worked-example shape. Omitted → the engine
  // mints one, exactly as before client-supplied ids existed.
  args: { _id: v.optional(v.string()), name: v.string() },
  returns: v.id("lists"),
  handler: (ctx, args) => ctx.db.insert("lists", { ...args, locked: false }),
});

export const lock = mutation({
  args: { id: v.id("lists") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null; // already gone — locking nothing is a no-op, not an error
    await ctx.db.replace(id, { name: doc.name as string, locked: true });
    return null;
  },
});
