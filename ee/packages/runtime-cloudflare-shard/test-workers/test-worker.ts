/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * The test Worker loaded into workerd by the vitest-pool-workers project. This is the real M1 stack:
 *   - `export default` — the MULTI-SHARD router (`createShardWorkerHandler`) from THIS ee package. It
 *     resolves each request's owning shard-DO name and forwards to it. Driving it via `SELF.fetch`
 *     exercises the full Worker→shard-DO path.
 *   - `export class FixtureStackbaseDO extends StackbaseDurableObject` — a shard-DO: the UNMODIFIED
 *     free host class (M1 reuses Slice 3 verbatim). N distinct shard keys ⇒ N distinct instances of
 *     this class, each with its own DO-SQLite.
 *
 * The fixture app has a SHARDED `messages` table (`.shardKey("roomId")`) so the router's
 * derive-from-args path routes `messages:send` by its `roomId` arg. Inside any single DO the engine
 * runs at `numShards: 1` (each DO IS one shard), so the kernel's shard guards short-circuit — the
 * physical partition is the DO boundary, not an in-engine ring.
 */
import { query, mutation } from "@stackbase/executor";
import { v, defineSchema, defineTable } from "@stackbase/values";
import type { LoadedProject } from "@stackbase/cli/project";
import { StackbaseDurableObject, createShardWorkerHandler, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare-shard";

const schema = defineSchema({
  messages: defineTable({ roomId: v.string(), body: v.string() })
    .index("by_room", ["roomId"])
    .shardKey("roomId"),
});

const messages = {
  send: mutation({
    args: { roomId: v.string(), body: v.string() },
    shardBy: "roomId",
    handler: (ctx, { roomId, body }) => ctx.db.insert("messages", { roomId, body }),
  }),
  list: query<{ roomId: string }, unknown[]>({
    handler: (ctx, { roomId }) => ctx.db.query("messages", "by_room").eq("roomId", roomId).collect(),
  }),
};

const loaded: LoadedProject = { schema, modules: { messages } };

export class FixtureStackbaseDO extends StackbaseDurableObject {
  protected appConfig(): DurableObjectAppConfig {
    return { loaded, adminKey: "workerd-test-admin-key" };
  }
}

// The Worker's default export IS the multi-shard router — `loaded` lets a POST /api/run derive a
// sharded mutation's key from its args. `SELF.fetch(...)` in the tests drives this real routing.
export default createShardWorkerHandler("STACKBASE_DO", { mode: "key", loaded });
