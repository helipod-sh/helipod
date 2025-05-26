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
  catalog.addTable("auth/sessions", 10002);
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "by_creation", fields: [], indexId: encodeStorageIndexId(10002, "by_creation") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("privileged execution", () => {
  it("a privileged function can insert into and read any full-named table (no scoping)", async () => {
    const executor = await harness();
    // privileged: pass the FULL table name; no namespace prefix is applied
    const id = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("auth/sessions", { token: "t" })), {}, { privileged: true })).value;
    // privileged get by an id whose table is "auth/sessions" must NOT be blocked (requireOwnTable skipped)
    const got = await executor.run<{ token: string } | null>(query(async (ctx) => ctx.db.get(id)), {}, { privileged: true });
    expect(got.value?.token).toBe("t");
  });
});
