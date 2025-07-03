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
  catalog.addTable("items", 8001);
  catalog.addIndex({ table: "items", tableNumber: 8001, index: "by_creation", fields: [], indexId: encodeStorageIndexId(8001, "by_creation") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("paginate cap (executor end-to-end)", () => {
  it("maxScan cap threads through ctx.db.query().paginate() and returns scanCapped: true", async () => {
    const ex = await harness();

    // seed 10 rows; only n===9 matches the filter
    for (let n = 0; n < 10; n++) {
      const nVal = n;
      await ex.run(mutation(async (ctx) => ctx.db.insert("items", { n: nVal })), {}, { privileged: true });
    }

    // Run a query UDF: paginate with maxScan=4, filter n===9 — should stop before finding the match
    const result = await ex.run<{ page: unknown[]; hasMore: boolean; scanCapped: boolean }>(
      query(async (ctx) => {
        return ctx.db.query("items", "by_creation").where("eq", "n", 9).paginate({ pageSize: 5, maxScan: 4 });
      }),
      {},
      { privileged: true },
    );

    expect(result.value.scanCapped).toBe(true);
    expect(result.value.hasMore).toBe(true);
    expect(result.value.page.length).toBeLessThan(5);
  });

  it("no maxScan → scanCapped is false and full result returned", async () => {
    const ex = await harness();

    for (let n = 0; n < 3; n++) {
      const nVal = n;
      await ex.run(mutation(async (ctx) => ctx.db.insert("items", { n: nVal })), {}, { privileged: true });
    }

    const result = await ex.run<{ page: unknown[]; hasMore: boolean; nextCursor: string | null; scanCapped: boolean }>(
      query(async (ctx) => {
        return ctx.db.query("items", "by_creation").paginate({ pageSize: 50 });
      }),
      {},
      { privileged: true },
    );

    expect(result.value.scanCapped).toBe(false);
    expect(result.value.page.length).toBe(3);
    expect(result.value.hasMore).toBe(false);
  });
});
