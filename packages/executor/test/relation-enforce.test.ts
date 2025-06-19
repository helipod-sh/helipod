import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";
import type { PolicyRegistry, PolicyContextProvider, RelationRegistry } from "../src/policy";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  for (const [t, n] of [["documents", 6001], ["document_shares", 6002]] as const) {
    catalog.addTable(t, n);
    catalog.addIndex({ table: t, tableNumber: n, index: "by_creation", fields: [], indexId: encodeStorageIndexId(n, "by_creation") });
  }
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// A document is readable if a document_shares row names the caller.
const registry: PolicyRegistry = new Map([
  ["documents", { read: () => ({ sharedWith: { some: { userId: "u1" } } }) }],
]);
const relations: RelationRegistry = {
  toMany: new Map([["documents", new Map([["sharedWith", { table: "document_shares", field: "documentId" }]])]]),
  toOne: new Map(),
};
const provider: PolicyContextProvider[] = [{ namespace: "authz", build: () => ({ auth: { userId: "u1" } }) }];

describe("relation-predicate enforcement", () => {
  it("a shared document is visible; an unshared one is not; privileged sees all", async () => {
    const ex = await harness();
    const d1 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("documents", { title: "shared" }) })), {}, { privileged: true })).value._id;
    const d2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("documents", { title: "secret" }) })), {}, { privileged: true })).value._id;
    await ex.run(mutation(async (ctx) => ctx.db.insert("document_shares", { documentId: d1, userId: "u1" })), {}, { privileged: true });

    const opts = { policyRegistry: registry, policyProviders: provider, relationRegistry: relations };
    const visible = await ex.run<any[]>(query(async (ctx) => ctx.db.query("documents", "by_creation").collect()), {}, opts);
    expect(visible.value.map((d) => d.title)).toEqual(["shared"]);          // only d1

    const secret = await ex.run<any>(query(async (ctx) => ctx.db.get(d2)), {}, opts);
    expect(secret.value).toBeNull();                                        // unshared → null

    const all = await ex.run<any[]>(query(async (ctx) => ctx.db.query("documents", "by_creation").collect()), {}, { privileged: true });
    expect(all.value.length).toBe(2);                                       // privileged sees both
  });
});
