/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
import { v, defineSchema, defineTable } from "@helipod/values";

// A minimal SHARDED app: messages partitioned by room. `.shardKey("roomId")` makes the multi-shard
// router derive `messages:send`'s owning DO from its `roomId` arg — one DO per room.
export default defineSchema({
  messages: defineTable({ roomId: v.string(), body: v.string() })
    .index("by_room", ["roomId"])
    .shardKey("roomId"),
});
