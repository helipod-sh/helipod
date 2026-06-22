/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { v, defineSchema, defineTable } from "@stackbase/values";

// A COMBINED app: a SHARDED table AND a GLOBAL table, in one deployment.
//   - `messages` is `.shardKey("roomId")`: one DO per room (per-shard DO-SQLite MVCC store).
//   - `counters` is `.global()` with a unique `by_key` index: lives in the ONE shared D1 database
//     (`env.DB`), readable and writable from EVERY shard-DO.
// This is the first-ever composition of the multi-shard router with the `.global()`/D1 tier — it
// proves a global row written through one shard-DO is visible from another, and that the D1 unique
// index is enforced across shards.
export default defineSchema({
  messages: defineTable({ roomId: v.string(), body: v.string() })
    .index("by_room", ["roomId"])
    .shardKey("roomId"),
  counters: defineTable({ key: v.string(), value: v.number() })
    .index("by_key", ["key"], { unique: true })
    .global(),
});
