// packages/executor/test/component-scope-ids.test.ts
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
  for (const [name, n] of [["messages", 10001], ["auth/sessions", 10002]] as const) {
    catalog.addTable(name, n);
    catalog.addIndex({ table: name, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("namespace-scoped ctx.db — id-based ops", () => {
  it("denies get/delete of a document whose table is outside the namespace", async () => {
    const executor = await harness();
    // app inserts into messages, capturing the id
    const appId = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("messages", { body: "secret" })), {}, {})).value;
    // a component (namespace "auth") must NOT be able to get that app document by id
    const steal = query(async (ctx) => ctx.db.get(appId));
    await expect(executor.run(steal, {}, { namespace: "auth" })).rejects.toThrow(/namespace|forbidden/i);
    const del = mutation(async (ctx) => ctx.db.delete(appId));
    await expect(executor.run(del, {}, { namespace: "auth" })).rejects.toThrow(/namespace|forbidden/i);
  });

  it("allows get of a document in the component's own namespace", async () => {
    const executor = await harness();
    const id = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })), {}, { namespace: "auth" })).value;
    const got = await executor.run<{ token: string } | null>(query(async (ctx) => ctx.db.get(id)), {}, { namespace: "auth" });
    expect(got.value?.token).toBe("t");
  });
});
