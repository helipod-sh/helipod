import { v } from "@stackbase/values";
import { query, mutation } from "./_generated/server";

// `messages` is sharded by `conversationId` (schema.ts), so a mutation that writes it must
// declare which shard it runs on — `shardBy: "conversationId"` routes each send to the shard
// owning that conversation. Omitting it is a shard mistake the engine rejects at every tier.
// An `args` validator naming `conversationId` (required, same `v.id("conversations")` type as
// the table's own shard-key field) is required too — codegen cross-checks the pairing at
// build time (D7) so a shardBy/args mismatch is caught before it ever reaches the kernel guards.
export const send = mutation({
  args: { conversationId: v.id("conversations"), author: v.string(), body: v.string() },
  // `returns` (optional but recommended, docs/enduser/optimistic-updates.md#return-type-typing)
  // is what makes `useMutation(api.messages.send).withOptimisticUpdate(...)`'s store typed below.
  returns: v.id("messages"),
  shardBy: "conversationId",
  handler: (ctx, args) =>
    ctx.db.insert("messages", { conversationId: args.conversationId, author: args.author, body: args.body }),
});

export const list = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(
    v.object({
      _id: v.id("messages"),
      _creationTime: v.number(),
      conversationId: v.id("conversations"),
      author: v.string(),
      body: v.string(),
    }),
  ),
  handler: (ctx, args) => ctx.db.query("messages", "by_conversation").eq("conversationId", args.conversationId).collect(),
});

export const listPaginated = query({
  handler: (ctx, args: { conversationId: string; cursor?: string | null; pageSize?: number }) =>
    ctx.db
      .query("messages", "by_conversation")
      .eq("conversationId", args.conversationId)
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, pageSize: args.pageSize ?? 20 }),
});
