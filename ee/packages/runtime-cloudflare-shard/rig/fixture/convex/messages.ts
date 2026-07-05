/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
import { query, mutation } from "@helipod/executor";
import { v } from "@helipod/values";

// `shardBy: "roomId"` — the router routes each send to the DO owning that room's shard.
export const send = mutation({
  args: { roomId: v.string(), body: v.string() },
  shardBy: "roomId",
  handler: (ctx, { roomId, body }) => ctx.db.insert("messages", { roomId, body }),
});

export const list = query<{ roomId: string }, unknown[]>({
  handler: (ctx, { roomId }) => ctx.db.query("messages", "by_room").eq("roomId", roomId).collect(),
});
