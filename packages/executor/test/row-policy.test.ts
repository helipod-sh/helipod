import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";
import type { PolicyRegistry, PolicyContextProvider } from "../src/policy";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("todos", 5001);
  catalog.addIndex({ table: "todos", tableNumber: 5001, index: "by_creation", fields: [], indexId: encodeStorageIndexId(5001, "by_creation") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// Registry: todos are readable only when ownerId === the caller's userId.
const registry: PolicyRegistry = new Map([
  ["todos", { read: ({ auth }) => ({ ownerId: auth.userId }) }],
]);
// A synthetic provider that reports the caller as "u1".
const asUser = (userId: string | null): PolicyContextProvider[] => [{
  namespace: "authz",
  build: () => ({ auth: { userId, identity: null, can: async () => false, roles: async () => [], scopesWith: async () => [] } }),
}];

describe("row read policy", () => {
  it("filters query/get to visible rows; privileged bypasses", async () => {
    const ex = await harness();
    // seed two owners (privileged → full table, no policy)
    const idU1 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u1", text: "a" }) })), {}, { privileged: true })).value._id;
    const idU2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u2", text: "b" }) })), {}, { privileged: true })).value._id;

    const opts = { policyRegistry: registry, policyProviders: asUser("u1") };

    const visible = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, opts);
    expect(visible.value.map((d) => d.ownerId)).toEqual(["u1"]);            // only u1's row

    const mine = await ex.run<any>(query(async (ctx) => ctx.db.get(idU1)), {}, opts);
    expect(mine.value?.text).toBe("a");
    const theirs = await ex.run<any>(query(async (ctx) => ctx.db.get(idU2)), {}, opts);
    expect(theirs.value).toBeNull();                                        // hidden → null, no existence leak

    const all = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, { privileged: true });
    expect(all.value.length).toBe(2);                                       // privileged sees everything
  });

  it("anonymous (userId null) sees zero rows (deny-by-default via predicate)", async () => {
    const ex = await harness();
    await ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u1", text: "a" })), {}, { privileged: true });
    const none = await ex.run<any[]>(query(async (ctx) => ctx.db.query("todos", "by_creation").collect()), {}, { policyRegistry: registry, policyProviders: asUser(null) });
    expect(none.value).toEqual([]);                                         // ownerId === null matches nothing
  });
});

describe("row write policy — replace post-image", () => {
  const writeRegistry: PolicyRegistry = new Map([
    ["todos", { write: ({ auth }, row) => row["ownerId"] === auth.userId }],
  ]);

  it("blocks replace when the resulting row reassigns ownership (post-image check)", async () => {
    const ex = await harness();
    const opts = { policyRegistry: writeRegistry, policyProviders: asUser("u1") };

    // seed a row owned by u1 (privileged insert bypasses policy)
    const id = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u1", text: "orig" }) })), {}, { privileged: true })).value._id;

    // u1 tries to hand the row to u2 — post-image check must REJECT this
    await expect(
      ex.run(mutation(async (ctx) => ctx.db.replace(id, { ownerId: "u2", text: "hijack" })), {}, opts),
    ).rejects.toThrow(/write policy on todos/);
  });

  it("allows replace when ownership is preserved (pre- and post-image both pass)", async () => {
    const ex = await harness();
    const opts = { policyRegistry: writeRegistry, policyProviders: asUser("u1") };

    // seed a row owned by u1 (privileged)
    const id = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u1", text: "orig" }) })), {}, { privileged: true })).value._id;

    // u1 edits the row keeping ownerId — should succeed
    await expect(
      ex.run(mutation(async (ctx) => ctx.db.replace(id, { ownerId: "u1", text: "edited" })), {}, opts),
    ).resolves.toBeDefined();
  });
});

describe("row write policy", () => {
  const writeRegistry = new Map([
    ["todos", { write: ({ auth }: { auth: { userId: string | null } }, row: Record<string, unknown>) => row.ownerId === auth.userId }],
  ]);

  it("blocks writing a row you don't own; allows your own; privileged bypasses", async () => {
    const ex = await harness();
    const opts = { policyRegistry: writeRegistry, policyProviders: asUser("u1") };

    // insert as u1: own row ok, other's row Forbidden
    await expect(ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u1", text: "ok" })), {}, opts)).resolves.toBeDefined();
    await expect(ex.run(mutation(async (ctx) => ctx.db.insert("todos", { ownerId: "u2", text: "no" })), {}, opts)).rejects.toThrow(/write policy on todos/);

    // seed a u2 row privileged, then u1's replace/delete of it is Forbidden (pre-write row is u2's)
    const u2 = (await ex.run<{ _id: string }>(mutation(async (ctx) => ({ _id: await ctx.db.insert("todos", { ownerId: "u2", text: "x" }) })), {}, { privileged: true })).value._id;
    await expect(ex.run(mutation(async (ctx) => ctx.db.replace(u2, { ownerId: "u2", text: "y" })), {}, opts)).rejects.toThrow(/write policy on todos/);
    await expect(ex.run(mutation(async (ctx) => ctx.db.delete(u2)), {}, opts)).rejects.toThrow(/write policy on todos/);

    // privileged can delete it
    await expect(ex.run(mutation(async (ctx) => ctx.db.delete(u2)), {}, { privileged: true })).resolves.toBeDefined();
  });
});
