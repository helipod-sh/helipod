/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * The mode-"hash" fixture Worker (M2d) — a SIBLING of `test-worker.ts` (mode "key"), run through its
 * OWN vitest-pool-workers project (`vitest.workers.hash.config.ts` / `wrangler.hash.jsonc`) so the two
 * fixtures never collide inside one workerd instance (a single `SELF` binds to exactly one default
 * export / one wrangler config; `singleWorker: true` — used by both projects — means every test file
 * within ONE project shares that one Worker, so a mode-"hash" fan-out fixture needs its own project).
 *
 * fanOut (M2d) is only well-defined for a FIXED shard count (`route.ts`'s `FANOUT_REQUIRES_FIXED_SHARDS`
 * guard) — mode "key" (the `test-worker.ts` fixture) has no enumerable shard set. This fixture pins
 * `numShards: 4` (`shardIdList(4) === ["default", "s1", "s2", "s3"]`) so `fanout.worker.test.ts` can
 * write across all four shards and prove the router's fan-out-and-concat path on REAL Durable Objects.
 *
 * Reuses the SAME `messages` schema/functions as `test-worker.ts` (grounding §7) plus two additions:
 *   - `messages:listAll` — a shard-key-LESS list query (`fanOut` fans a single query out to every
 *     shard; the query itself takes no `roomId` and simply collects everything the shard-DO holds).
 *   - `messages:listAllStrict` — identical, but throws if any row's `body` is the sentinel `"BOOM"`,
 *     used to induce a REAL (non-mocked) single-shard failure inside genuine workerd: a row seeded
 *     with body `"BOOM"` on exactly one shard makes THAT shard's `/api/run` respond non-200 while the
 *     others still succeed, exercising `worker.ts`'s failures-as-data `partial.failedShards` path
 *     end-to-end rather than only via the Node-level scripted-namespace unit test.
 */
import { query, mutation } from "@helipod/executor";
import { v, defineSchema, defineTable } from "@helipod/values";
import type { LoadedProject } from "@helipod/cli/project";
import { HelipodDurableObject, createShardWorkerHandler, type DurableObjectAppConfig } from "@helipod/runtime-cloudflare-shard";

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
  /** Shard-key-less: what a fanOut request calls on EVERY shard-DO. */
  listAll: query<Record<string, never>, unknown[]>({
    handler: (ctx) => ctx.db.query("messages", "by_room").collect(),
  }),
  /** Same as `listAll`, but throws when this shard's own data contains the "BOOM" sentinel — used to
   *  induce a genuine single-shard failure inside real workerd (see file banner). */
  listAllStrict: query<Record<string, never>, unknown[]>({
    handler: async (ctx) => {
      const rows = (await ctx.db.query("messages", "by_room").collect()) as Array<{ body: string }>;
      if (rows.some((r) => r.body === "BOOM")) throw new Error("listAllStrict: BOOM sentinel present on this shard");
      return rows;
    },
  }),
};

const loaded: LoadedProject = { schema, modules: { messages } };

export class FixtureHelipodDOHash extends HelipodDurableObject {
  protected appConfig(): DurableObjectAppConfig {
    return { loaded, adminKey: "workerd-test-admin-key-hash" };
  }
}

// The Worker's default export is the multi-shard router, fixed at numShards: 4 (mode "hash") — the
// enumerable shard set fanOut requires. `SELF.fetch(...)` in fanout.worker.test.ts drives this real
// routing, exactly as multishard.worker.test.ts drives the mode-"key" router in its own project.
export default createShardWorkerHandler("HELIPOD_DO", { mode: "hash", numShards: 4, loaded });
