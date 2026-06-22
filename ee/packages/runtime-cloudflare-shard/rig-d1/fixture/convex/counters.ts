/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { query, mutation } from "@stackbase/executor";
import { v } from "@stackbase/values";

// `counters` is a `.global()` table: its rows live in the shared D1 database, not in any one shard's
// DO-SQLite. A write routed to shard A's DO and a read routed to shard B's DO see the SAME row —
// that is the composition proof. The `by_key` unique index is enforced globally (across all shards).

export const create = mutation({
  args: { key: v.string(), value: v.number() },
  handler: (ctx, { key, value }) => ctx.db.insert("counters", { key, value }),
});

export const getByKey = query<{ key: string }, unknown>({
  handler: async (ctx, { key }) => {
    const rows = await ctx.db.query("counters", "by_key").eq("key", key).collect();
    return (rows[0] as { _id: string; key: string; value: number } | undefined) ?? null;
  },
});
