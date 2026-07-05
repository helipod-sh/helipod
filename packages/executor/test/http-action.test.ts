import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, httpAction, type UdfResult } from "../src/index";

// Self-contained harness (mirrors action-run.test.ts's makeRuntime): `@helipod/component` and
// `@helipod/runtime-embedded` both depend on `@helipod/executor`, so pulling either into
// packages/executor's own devDependencies would make the workspace's package graph cyclic. This
// harness builds the same `ExecutorDeps` an httpAction needs — no db is ever touched by an
// httpAction (see ACTION_PROFILE/HTTP_ACTION_PROFILE), but `runActionFn` needs a real transactor/
// queryRuntime/catalog to construct, and an `invoke` stub for the `ctx.runQuery`/`runMutation`/
// `runAction` seam.
async function makeExecutor(opts?: { onInvoke?: (path: string, args: unknown) => unknown }): Promise<InlineUdfExecutor> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();

  const invoke = async (path: string, args: unknown): Promise<UdfResult> => {
    const result = (opts?.onInvoke?.(path, args) ?? { value: null }) as { value: unknown };
    return { value: result.value, logs: [], committed: false, commitTs: 0n, readRanges: [], oplog: null };
  };

  return new InlineUdfExecutor({ transactor, queryRuntime, catalog, invoke });
}

describe("httpAction executor", () => {
  it("runs a Request -> Response handler outside any txn, no ctx.db", async () => {
    const seen: unknown[] = [];
    const fn = httpAction(async (ctx, request: Request) => {
      seen.push((ctx as { db?: unknown }).db); // must be undefined
      const body = await request.text();
      return new Response(`echo:${body}`, { status: 201, headers: { "x-test": "1" } });
    });
    const exec = await makeExecutor();
    const req = new Request("http://x/webhook", { method: "POST", body: "hi" });
    const res = await exec.run(fn, req, { path: "http:echo" });
    const response = res.value as Response;
    expect(seen[0]).toBeUndefined(); // no ctx.db on an httpAction
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe("echo:hi");
    expect(res.committed).toBe(false); // ran outside any txn
  });

  it("ctx.runMutation reaches the invoke seam", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const fn = httpAction(async (ctx) => {
      await (ctx as { runMutation: (p: string, a: unknown) => Promise<unknown> }).runMutation("app:mark", { id: 1 });
      return new Response("ok");
    });
    const exec = await makeExecutor({
      onInvoke: (path, args) => {
        calls.push({ path, args });
        return { value: null };
      },
    });
    await exec.run(fn, new Request("http://x/w", { method: "POST" }), { path: "http:m" });
    expect(calls).toEqual([{ path: "app:mark", args: { id: 1 } }]);
  });
});
