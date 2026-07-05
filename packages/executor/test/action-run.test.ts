import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { jsonToConvex, type JSONValue } from "@helipod/values";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, action, type RegisteredFunction, type UdfResult } from "../src/index";

// Self-contained harness (mirrors row-policy.test.ts) rather than EmbeddedRuntime/composeComponents:
// `@helipod/component` and `@helipod/runtime-embedded` both depend on `@helipod/executor`, so
// pulling either into packages/executor's own devDependencies would make the workspace's package
// graph cyclic (turbo's `^build` topological order rejects it outright). This harness exercises the
// exact same seam runtime.ts wires — a `let executorRef` closure resolving paths through a module
// map and re-entering `executor.run` — without inverting the dependency direction between packages.
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

describe("action execution", () => {
  it("runs an action outside a txn; ctx.runMutation commits; ctx.runQuery reads it back; native globals work; NO ctx.db", async () => {
    const r = await makeRuntime({
      "app:add": mutation(async (ctx: any, a: { body: string }) => ctx.db.insert("notes", { body: a.body })),
      "app:list": query(async (ctx: any) => (await ctx.db.query("notes", "by_creation").collect()).map((d: any) => d.body)),
      "app:act": action(async (ctx: any, a: { body: string }) => {
        expect((ctx as any).db).toBeUndefined();               // core invariant: no db
        const rnd = Math.random(); const t = Date.now();        // native globals available
        await ctx.runMutation("app:add", { body: a.body });     // fresh write txn
        const list = await ctx.runQuery("app:list", {});        // fresh read txn, sees the write
        return { list, hadRandom: typeof rnd === "number", hadClock: typeof t === "number" };
      }),
    });
    const res = await r.runAction("app:act", { body: "hello" });
    expect((res.value as any).list).toEqual(["hello"]);
    expect((res.value as any).hadRandom && (res.value as any).hadClock).toBe(true);
  });

  it("a nested ctx.runAction runs; a handler throw rejects with the error", async () => {
    const r = await makeRuntime({
      "app:inner": action(async () => 42),
      "app:outer": action(async (ctx: any) => await ctx.runAction("app:inner", {})),
      "app:boom": action(async () => { throw new Error("kaboom"); }),
    });
    expect((await r.runAction("app:outer", {})).value).toBe(42);
    await expect(r.runAction("app:boom", {})).rejects.toThrow(/kaboom/);
  });
});
