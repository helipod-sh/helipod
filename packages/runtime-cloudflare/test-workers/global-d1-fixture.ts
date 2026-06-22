/**
 * A real-workerd DO host wiring a `.global()` D1-backed table (M2b Task 9), plus a local (root)
 * table for the co-write guard test. Booted by `global-d1-e2e.test.ts` inside a genuine Durable
 * Object (workerd), against miniflare's REAL D1 emulation bound as `env.DB`.
 *
 * `counters` is `.global()` with a unique `by_key` index (exercises the D1-unique-violation
 * scenario); `localItems` is an ordinary root (MVCC) table (exercises the cross-store co-write
 * guard). NOT product code — a test fixture. Safe to delete with this branch's tests.
 */
import { query, mutation } from "@stackbase/executor";
import { v, defineSchema, defineTable } from "@stackbase/values";
import type { LoadedProject } from "@stackbase/cli/project";
import { StackbaseDurableObject, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";
import { bindingD1Client, type D1Binding } from "@stackbase/docstore-d1";

const schema = defineSchema({
  counters: defineTable({ key: v.string(), value: v.number() })
    .index("by_key", ["key"], { unique: true })
    .global(),
  localItems: defineTable({ name: v.string() }).index("by_creation", []),
});

const counters = {
  create: mutation({
    handler: (ctx, { key, value }: { key: string; value: number }) => ctx.db.insert("counters", { key, value }),
  }),
  getByKey: query({
    handler: async (ctx, { key }: { key: string }) => {
      const rows = await ctx.db.query("counters", "by_key").eq("key", key).collect();
      return (rows[0] as { _id: string; key: string; value: number } | undefined) ?? null;
    },
  }),
  // Same-mutation read-your-own-writes: insert, then read the row back (by id AND by index)
  // BEFORE the handler returns — proves the pending overlay, not just the post-commit D1 read.
  createAndReadBack: mutation({
    handler: async (ctx, { key, value }: { key: string; value: number }) => {
      const id = await ctx.db.insert("counters", { key, value });
      const byId = await ctx.db.get(id);
      const byIndex = await ctx.db.query("counters", "by_key").eq("key", key).collect();
      return { id, byId, byIndexCount: byIndex.length };
    },
  }),
  // Writes a `.global()` row AND a sharded/root row in the SAME mutation — must throw
  // `CrossStoreWriteError` before either write's transaction resolves.
  coWrite: mutation({
    handler: async (ctx, { key, value, name }: { key: string; value: number; name: string }) => {
      await ctx.db.insert("counters", { key, value });
      await ctx.db.insert("localItems", { name });
      return "unreachable";
    },
  }),
  // Inserts a `.global()` row, then throws — the whole mutation must abort, so the staged D1
  // write must NEVER be flushed (abort-safety).
  insertThenThrow: mutation({
    handler: async (ctx, { key, value }: { key: string; value: number }) => {
      await ctx.db.insert("counters", { key, value });
      throw new Error("deliberate abort after global insert");
    },
  }),
};

const localItems = {
  list: query({ handler: (ctx) => ctx.db.query("localItems", "by_creation").collect() }),
};

const loaded: LoadedProject = { schema, modules: { counters, localItems } };

export class GlobalD1DO extends StackbaseDurableObject {
  protected appConfig(env: unknown): DurableObjectAppConfig {
    const db = (env as { DB?: D1Binding }).DB;
    return {
      loaded,
      adminKey: "global-d1-admin-key",
      ...(db ? { d1: bindingD1Client(db) } : {}),
    };
  }
}
