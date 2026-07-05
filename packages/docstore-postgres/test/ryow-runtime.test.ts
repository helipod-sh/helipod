import { describe, it, expect, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "@helipod/test";
import { mutation } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";

// Read-your-own-writes for ctx.db.query, exercised against the REAL engine on a Postgres docstore
// (PGlite = real Postgres semantics in WASM, in-process — no Docker). The RYOW overlay lives in the
// query engine and is docstore-independent (it merges the transaction's staged writes over the
// committed `index_scan` in JS, re-sorting with `compareKeyBytes`); this proves it behaves the same
// on Postgres as the SQLite conformance suite proves for `:memory:`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({ docs: defineTable({ owner: v.string() }) });

const mod = {
  insert: mutation(async (ctx: A, a: { owner: string }) => ctx.db.insert("docs", a)),
  // insert then query within the SAME mutation transaction
  insertThenQuery: mutation(async (ctx: A, a: { owner: string }) => {
    await ctx.db.insert("docs", a);
    return ctx.db.query("docs", "by_creation").collect();
  }),
  // delete then query within the SAME mutation transaction
  deleteThenQuery: mutation(async (ctx: A, a: { id: string }) => {
    await ctx.db.delete(a.id);
    return ctx.db.query("docs", "by_creation").collect();
  }),
};

describe("read-your-own-writes on Postgres (PGlite)", () => {
  let t: TestHelipod;

  const boot = async () => {
    t = await createTestHelipod({
      modules: { "mod.ts": mod, "schema.ts": { default: schema } },
      store: new PostgresDocStore(new PgliteClient()),
    });
  };

  afterEach(async () => {
    await t?.close();
  });

  it("a query inside a mutation sees the mutation's own just-inserted row", async () => {
    await boot();
    const rows = await t.mutation<Array<{ owner: string }>>("mod:insertThenQuery", { owner: "fresh" });
    expect(rows.some((r) => r.owner === "fresh")).toBe(true);
  });

  it("a query inside a mutation does not see the mutation's own just-deleted row", async () => {
    await boot();
    const id = await t.mutation<string>("mod:insert", { owner: "a" });
    const rows = await t.mutation<Array<{ _id: string }>>("mod:deleteThenQuery", { id });
    expect(rows.some((r) => r._id === id)).toBe(false);
  });
});
