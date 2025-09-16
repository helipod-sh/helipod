import { query, mutation, action } from "@stackbase/executor";
import type { Id } from "./_generated/dataModel";

export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

// Bare `db.get(id)` read — exercises the DOCUMENT-keyspace invalidation bridge (a write to this
// exact id must re-run this subscription), distinct from `list`'s index-range read.
export const get = query({
  handler: async (ctx, { id }: { id: Id<"notes"> }) => {
    const d = await ctx.db.get(id);
    return d ? { box: d.box, text: d.text } : null;
  },
});

export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});

// Stackbase has no ctx.db.patch (a documented Convex divergence) — read-merge-replace instead.
export const update = mutation({
  handler: async (ctx, { id, text }: { id: Id<"notes">; text: string }) => {
    const cur = await ctx.db.get(id);
    if (cur) await ctx.db.replace(id, { ...cur, text });
    return null;
  },
});

// An ACTION that writes via ctx.runMutation — exercises the fleet action-forwarding + read-your-own-
// writes path (the writer surfaces the inner mutation's commitTs; the sync node's forwarder waits for
// its replica watermark to reach it, so an IMMEDIATE read on the same sync node sees the row).
export const addViaAction = action({
  handler: async (
    ctx: { runMutation: (path: string, args: Record<string, unknown>) => Promise<unknown> },
    { box, text }: { box: string; text: string },
  ): Promise<unknown> => ctx.runMutation("notes:add", { box, text }),
});
