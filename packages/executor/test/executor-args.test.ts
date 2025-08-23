import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { v } from "@stackbase/values";
import { ArgumentValidationError } from "@stackbase/errors";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, action, type UdfResult } from "../src/index";

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog();
  // Wire a no-op `invoke` so the action assertion genuinely exercises the guard (rather than
  // being short-circuited by the "no invoke runner" error the bare executor throws for actions).
  exec = new InlineUdfExecutor({
    transactor,
    queryRuntime: new QueryRuntime(store),
    catalog,
    invoke: async () => ({ value: null, logs: [], committed: false, commitTs: 0n, readRanges: [], oplog: null }) as unknown as UdfResult,
  });
});

const run = (fn: Parameters<InlineUdfExecutor["run"]>[0], args: unknown) => exec.run(fn, args, { path: "app:fn" });

describe("executor — argument validation", () => {
  const echo = mutation({ args: { n: v.number() }, handler: (_ctx, args) => args.n });

  it("accepts well-typed args and runs the handler", async () => {
    const res = await run(echo, { n: 5 });
    expect(res.value).toBe(5);
  });

  it("rejects a wrong-typed arg with ArgumentValidationError", async () => {
    await expect(run(echo, { n: "not-a-number" })).rejects.toBeInstanceOf(ArgumentValidationError);
    await expect(run(echo, { n: "not-a-number" })).rejects.toThrow(/do not match validator/);
  });

  it("rejects a missing required arg", async () => {
    await expect(run(echo, {})).rejects.toBeInstanceOf(ArgumentValidationError);
  });

  it("rejects an extra (undeclared) arg (strict object)", async () => {
    await expect(run(echo, { n: 1, extra: true })).rejects.toBeInstanceOf(ArgumentValidationError);
  });

  it("accepts arbitrary args when the function declares no validator", async () => {
    const loose = mutation((_ctx, args) => args);
    const res = await run(loose, { anything: [1, 2, 3], nested: { ok: true } });
    expect(res.value).toEqual({ anything: [1, 2, 3], nested: { ok: true } });
  });

  it("validates an action's args too (guard runs before the action dispatch)", async () => {
    const act = action({ args: { x: v.string() }, handler: async (_ctx, args) => args.x });
    await expect(run(act, { x: 123 })).rejects.toBeInstanceOf(ArgumentValidationError);
  });
});
