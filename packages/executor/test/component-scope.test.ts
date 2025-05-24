import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  // app table "messages" (10001) + component table "auth/sessions" (10002), each with by_creation
  for (const [name, n] of [["messages", 10001], ["auth/sessions", 10002]] as const) {
    catalog.addTable(name, n);
    catalog.addIndex({ table: name, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("namespace-scoped ctx.db — name-based ops", () => {
  it("resolves a component's bare table name to its namespaced table", async () => {
    const executor = await harness();
    const insert = mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })); // bare name
    const id = (await executor.run<string>(insert, {}, { namespace: "auth" })).value;
    expect(typeof id).toBe("string");

    const list = query(async (ctx) => ctx.db.query("sessions", "by_creation").collect());
    const docs = (await executor.run<Array<{ token: string }>>(list, {}, { namespace: "auth" })).value;
    expect(docs.map((d) => d.token)).toEqual(["t"]);
  });

  it("denies a component reading a table outside its namespace (the boundary)", async () => {
    const executor = await harness();
    const readApp = query(async (ctx) => ctx.db.query("messages", "by_creation").collect());
    await expect(executor.run(readApp, {}, { namespace: "auth" })).rejects.toThrow(/unknown table|unknown index/);
  });

  it("the app (namespace '') resolves bare names unchanged", async () => {
    const executor = await harness();
    const insert = mutation(async (ctx) => ctx.db.insert("messages", { body: "hi" }));
    const id = (await executor.run<string>(insert, {}, {})).value; // no namespace → ""
    expect(typeof id).toBe("string");
  });
});
