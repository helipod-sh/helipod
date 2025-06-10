// packages/executor/test/component-facades.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, query, type ContextProvider } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return new InlineUdfExecutor({ transactor: new SingleWriterTransactor(store, new MonotonicTimestampOracle()), queryRuntime: new QueryRuntime(store), catalog: new SimpleIndexCatalog() });
}

describe("Component→Component facades", () => {
  it("a later provider's build receives the facades of earlier providers", async () => {
    const a: ContextProvider = { name: "a", namespace: "a", build: () => ({ hello: () => "world" }) };
    const b: ContextProvider = { name: "b", namespace: "b", build: (cctx) => ({
      viaA: () => (cctx.components.a as { hello(): string }).hello(),
    }) };
    const fn = query(async (ctx) => (ctx as unknown as { b: { viaA(): string } }).b.viaA());
    const r = await (await harness()).run<string>(fn, {}, { contextProviders: [a, b] });
    expect(r.value).toBe("world");
  });
});
