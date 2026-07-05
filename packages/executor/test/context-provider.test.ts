import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime } from "@helipod/query-engine";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, type ContextProvider } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("auth/sessions", 10002);
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "by_creation", fields: [], indexId: encodeStorageIndexId(10002, "by_creation") });
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "byToken", fields: ["token"], indexId: encodeStorageIndexId(10002, "byToken") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// a provider that resolves the ambient identity to a session's userId, reading its own namespace
const authProvider: ContextProvider = {
  name: "auth",
  namespace: "auth",
  build: (cctx) => ({
    whoami: async (): Promise<string | null> => {
      if (!cctx.identity) return null;
      const [s] = await cctx.db.query("sessions", "byToken").eq("token", cctx.identity).collect();
      return s ? (s.userId as string) : null;
    },
  }),
};

describe("ctx-contribution hook", () => {
  it("a facade resolves the ambient identity in its own namespace", async () => {
    const executor = await harness();
    // seed a session (namespace auth)
    await executor.run(mutation(async (ctx) => ctx.db.insert("sessions", { userId: "u1", token: "tok" })), {}, { namespace: "auth" });
    // an app query that ONLY uses ctx.auth.whoami() — no ctx.db of its own
    const me = query(async (ctx) => (ctx as unknown as { auth: { whoami(): Promise<string | null> } }).auth.whoami());
    const ok = await executor.run<string | null>(me, {}, { contextProviders: [authProvider], identity: "tok" });
    expect(ok.value).toBe("u1");
    const bad = await executor.run<string | null>(me, {}, { contextProviders: [authProvider], identity: "nope" });
    expect(bad.value).toBeNull();
  });

  it("records the facade's read in the CALLER's read-set (reactivity)", async () => {
    const executor = await harness();
    await executor.run(mutation(async (ctx) => ctx.db.insert("sessions", { userId: "u1", token: "tok" })), {}, { namespace: "auth" });
    const me = query(async (ctx) => (ctx as unknown as { auth: { whoami(): Promise<string | null> } }).auth.whoami());
    const r = await executor.run(me, {}, { contextProviders: [authProvider], identity: "tok" });
    // the query touched NO table of its own; any recorded read proves the facade's read landed in the caller's read-set
    expect(r.readRanges.length).toBeGreaterThan(0);
  });

  it("throws on a context key that collides with a reserved ctx key", async () => {
    const executor = await harness();
    const bad: ContextProvider = { name: "db", namespace: "auth", build: () => ({}) };
    await expect(executor.run(query(async () => 1), {}, { contextProviders: [bad] })).rejects.toThrow(/collide|reserved/i);
  });
});
