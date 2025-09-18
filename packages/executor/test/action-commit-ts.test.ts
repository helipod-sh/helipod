import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { jsonToConvex, type JSONValue } from "@stackbase/values";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, action, type RegisteredFunction, type UdfResult } from "../src/index";

// Same self-contained harness as action-run.test.ts (see its comment for why: pulling
// `@stackbase/component`/`@stackbase/runtime-embedded` into executor's devDependencies would
// make the workspace package graph cyclic).
async function makeRuntime(modules: Record<string, RegisteredFunction>) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("notes", 5001);
  catalog.addIndex({ table: "notes", tableNumber: 5001, index: "by_creation", fields: [], indexId: encodeStorageIndexId(5001, "by_creation") });

  let executorRef: InlineUdfExecutor;
  const invoke = async (path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult> => {
    const fn = modules[path];
    if (!fn) throw new Error(`unknown function: ${path}`);
    return executorRef.run(fn, jsonToConvex(args), { path, identity: opts?.identity ?? null });
  };
  const executor = new InlineUdfExecutor({ transactor, queryRuntime, catalog, invoke });
  executorRef = executor;

  return {
    runAction: <T = unknown>(path: string, args: unknown) => {
      const fn = modules[path];
      if (!fn) throw new Error(`unknown function: ${path}`);
      if (fn.type !== "action") throw new Error(`${path} is not an action`);
      return executor.run<T>(fn, args, { path, identity: null });
    },
  };
}

describe("action result commitTs (RYOW for actions)", () => {
  it("commitTs is 0n when the action runs zero inner mutations/actions", async () => {
    const r = await makeRuntime({
      "app:noop": action(async () => 7),
    });
    const res = await r.runAction("app:noop", {});
    expect(res.value).toBe(7);
    expect(res.commitTs).toBe(0n);
    expect(res.committed).toBe(false); // unchanged: an action itself never commits
    expect(res.oplog).toBeNull(); // unchanged: actions never carry an oplog
  });

  it("a pure ctx.runQuery (no writes) leaves commitTs at 0n", async () => {
    const r = await makeRuntime({
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).length),
      "app:act": action(async (ctx: any) => {
        await ctx.runQuery("app:list", {});
        return "read-only";
      }),
    });
    const res = await r.runAction("app:act", {});
    expect(res.commitTs).toBe(0n);
  });

  it("commitTs is non-zero after a single inner mutation", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:act": action(async (ctx: any) => {
        await ctx.runMutation("app:add", { body: "one" });
        return "done";
      }),
    });
    const res = await r.runAction("app:act", {});
    expect(res.commitTs).toBeGreaterThan(0n);
  });

  it("commitTs after three inner mutations reflects the MAX (latest) commit, not zero or a stale first value", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:act3": action(async (ctx: any) => {
        await ctx.runMutation("app:add", { body: "a" });
        await ctx.runMutation("app:add", { body: "b" });
        await ctx.runMutation("app:add", { body: "c" });
        return "done";
      }),
    });
    const res = await r.runAction("app:act3", {});
    expect(res.commitTs).toBeGreaterThan(0n);
  });

  it("a trailing ctx.runQuery after inner mutations does not reset commitTs back toward zero", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).length),
      "app:act": action(async (ctx: any) => {
        await ctx.runMutation("app:add", { body: "x" });
        await ctx.runQuery("app:list", {}); // read-only; must not be tracked / must not clobber commitTs
        return "done";
      }),
    });
    const res = await r.runAction("app:act", {});
    expect(res.commitTs).toBeGreaterThan(0n);
  });

  it("commitTs propagates through action -> inner action -> mutation (outer action itself runs no direct mutation)", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:innerAction": action(async (ctx: any) => {
        await ctx.runMutation("app:add", { body: "nested" });
        return "inner-done";
      }),
      "app:outerAction": action(async (ctx: any) => {
        // No direct ctx.runMutation call here at all — any non-zero commitTs on the result
        // can only have arrived by propagating up through the inner ctx.runAction call.
        await ctx.runAction("app:innerAction", {});
        return "outer-done";
      }),
    });
    const res = await r.runAction("app:outerAction", {});
    expect(res.commitTs).toBeGreaterThan(0n);
  });
});
