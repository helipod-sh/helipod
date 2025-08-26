import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

describe("conformance — db CRUD", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("insert returns a usable id", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("get round-trips an inserted document", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const doc = await t.query("mod:get", { id });
    expect(doc).toMatchObject({ owner: "a", n: 1, tag: "x" });
  });

  it("Stackbase has no ctx.db.patch — partial update is read-merge-replace", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation("mod:patchViaReplace", { id, patch: { n: 2 } });
    // unspecified fields (owner, tag) are retained — this is a MERGE, not an overwrite
    expect(await t.query("mod:get", { id })).toMatchObject({ owner: "a", n: 2, tag: "x" });
  });

  it("replace overwrites the whole document (dropped optional field is gone)", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x", note: "keep" });
    // replace with a doc that omits the optional `note` field entirely — all required fields present
    await t.mutation("mod:replace", { id, doc: { owner: "a", n: 9, tag: "y" } });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc).toMatchObject({ owner: "a", n: 9, tag: "y" });
    expect(doc.note).toBeUndefined(); // proves full overwrite, not a merge — the optional field was dropped
  });

  it("replace must keep the doc schema-valid — dropping a required field rejects", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    // `tag` is required by schema; omitting it on replace must be rejected, not silently accepted
    await expect(t.mutation("mod:replace", { id, doc: { owner: "a", n: 9 } })).rejects.toThrow(/does not match schema/);
  });

  it("delete makes a subsequent get return null", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation("mod:del", { id });
    expect(await t.query("mod:get", { id })).toBeNull();
  });

  it("order(desc) over by_creation returns creation-descending order", async () => {
    const id1 = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const id2 = await t.mutation<string>("mod:insert", { owner: "a", n: 2, tag: "x" });
    const id3 = await t.mutation<string>("mod:insert", { owner: "a", n: 3, tag: "x" });
    const rows = (await t.query<Array<{ _id: string }>>("mod:allDesc", {}));
    expect(rows.map((r) => r._id)).toEqual([id3, id2, id1]);
  });
});

// ---------------------------------------------------------------------------
// Extended DB-CRUD conformance — inline schema/module (mirrors reactivity.test.ts's
// pattern) so we can exercise `.order("asc")`, `.take(n)`, `.where(...)`, system
// fields, read-your-own-writes, rollback, and re-insert-after-delete without
// touching the shared conformance-app fixture.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const extSchema = defineSchema({
  docs: defineTable({ owner: v.string(), n: v.number(), tag: v.string() }),
});

const extMod = {
  insert: mutation(async (ctx: A, a: A) => ctx.db.insert("docs", a)),
  get: query(async (ctx: A, a: { id: string }) => ctx.db.get(a.id)),
  del: mutation(async (ctx: A, a: { id: string }) => {
    await ctx.db.delete(a.id);
    return null;
  }),
  allAsc: query(async (ctx: A) => ctx.db.query("docs", "by_creation").order("asc").collect()),
  allDesc: query(async (ctx: A) => ctx.db.query("docs", "by_creation").order("desc").collect()),
  take: query(async (ctx: A, a: { n: number }) => ctx.db.query("docs", "by_creation").order("asc").take(a.n).collect()),
  whereTag: query(async (ctx: A, a: { tag: string }) =>
    ctx.db.query("docs", "by_creation").where("eq", "tag", a.tag).collect()),
  whereGt: query(async (ctx: A, a: { n: number }) =>
    ctx.db.query("docs", "by_creation").where("gt", "n", a.n).collect()),
  // Read-your-own-writes: insert then immediately query within the SAME mutation transaction.
  insertThenQuery: mutation(async (ctx: A, a: { owner: string; n: number; tag: string }) => {
    const id = await ctx.db.insert("docs", a);
    return { id, viaGet: await ctx.db.get(id), viaQuery: await ctx.db.query("docs", "by_creation").collect() };
  }),
  // Delete then immediately query within the SAME mutation transaction.
  deleteThenQuery: mutation(async (ctx: A, a: { id: string }) => {
    await ctx.db.delete(a.id);
    return { viaGet: await ctx.db.get(a.id), viaQuery: await ctx.db.query("docs", "by_creation").collect() };
  }),
  // Insert, then throw — the whole transaction must roll back, leaving no trace.
  insertThenThrow: mutation(async (ctx: A, a: A) => {
    await ctx.db.insert("docs", a);
    throw new Error("boom");
  }),
};

describe("conformance — db CRUD (extended)", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": extMod, "schema.ts": { default: extSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it(".order(\"asc\") over by_creation returns creation-ascending (oldest-first) order", async () => {
    const id1 = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const id2 = await t.mutation<string>("mod:insert", { owner: "a", n: 2, tag: "x" });
    const id3 = await t.mutation<string>("mod:insert", { owner: "a", n: 3, tag: "x" });
    const rows = await t.query<Array<{ _id: string }>>("mod:allAsc", {});
    expect(rows.map((r) => r._id)).toEqual([id1, id2, id3]);
  });

  it(".take(n) limits the result to n rows", async () => {
    await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation<string>("mod:insert", { owner: "a", n: 2, tag: "x" });
    await t.mutation<string>("mod:insert", { owner: "a", n: 3, tag: "x" });
    const rows = await t.query<Array<{ n: number }>>("mod:take", { n: 2 });
    expect(rows).toHaveLength(2);
    // take(2) in ascending creation order keeps the two oldest rows
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });

  it(".where(op, field, value) applies a post-scan filter over a non-indexed field", async () => {
    await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation<string>("mod:insert", { owner: "a", n: 2, tag: "y" });
    await t.mutation<string>("mod:insert", { owner: "a", n: 3, tag: "x" });

    const eqRows = await t.query<Array<{ tag: string }>>("mod:whereTag", { tag: "x" });
    expect(eqRows).toHaveLength(2);
    expect(eqRows.every((r) => r.tag === "x")).toBe(true);

    const gtRows = await t.query<Array<{ n: number }>>("mod:whereGt", { n: 1 });
    expect(gtRows.map((r) => r.n).sort()).toEqual([2, 3]);
  });

  it("every doc carries system fields _id and _creationTime not present in the insert payload", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc._id).toBe(id);
    expect(typeof doc._creationTime).toBe("number");
  });

  it("read-your-own-writes via ctx.db.get: a get run inside the same mutation sees a just-inserted row", async () => {
    const res = await t.mutation<{ id: string; viaGet: { owner: string } | null }>(
      "mod:insertThenQuery",
      { owner: "fresh", n: 1, tag: "x" },
    );
    // ctx.db.get() overlays the transaction's own staged writes (single-writer-transactor.ts's
    // TransactionContextImpl.get: `const local = this.staged.get(id); if (local) return local.value;`)
    // — a point read-by-id sees an insert made earlier in the SAME mutation.
    expect(res.viaGet).toMatchObject({ owner: "fresh" });
  });

  it("read-your-own-writes via ctx.db.get: a get run inside the same mutation does not see a just-deleted row", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const res = await t.mutation<{ viaGet: unknown }>("mod:deleteThenQuery", { id });
    expect(res.viaGet).toBeNull();
  });

  // FINDING: ctx.db.query(...).collect() does NOT see the mutation's own uncommitted writes —
  // it diverges from ctx.db.get(), which does (see the two passing tests above). QueryRuntime.collect
  // (packages/query-engine/src/query-runtime.ts) scans the DocStore directly at the transaction's
  // `snapshotTs` via `docStore.index_scan(...)` and never consults the transaction's staged-write
  // buffer (`TransactionContextImpl.staged`, packages/transactor/src/single-writer-transactor.ts) the
  // way `ctx.db.get`'s `ctx.txn.get()` does. Concretely: inserting a row and then immediately running
  // an INDEX query in the same mutation handler does NOT return that row; deleting a row and then
  // immediately running an index query in the same mutation still returns the now-deleted row. This is
  // a real divergence from Convex, where `ctx.db.query()` inside a mutation reflects all of that
  // mutation's own prior writes. Kept skipped (not faked green) — a fix would need QueryRuntime.collect
  // (and .paginate) to merge `ctx.staged` over the DocStore scan before evaluating range/filters.
  it.skip("read-your-own-writes via ctx.db.query: a query run inside the same mutation sees a just-inserted row", async () => {
    const res = await t.mutation<{ id: string; viaQuery: Array<{ owner: string }> }>(
      "mod:insertThenQuery",
      { owner: "fresh", n: 1, tag: "x" },
    );
    expect(res.viaQuery.some((r) => r.owner === "fresh")).toBe(true);
  });

  it.skip("read-your-own-writes via ctx.db.query: a query run inside the same mutation does not see a just-deleted row", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const res = await t.mutation<{ viaQuery: Array<{ _id: string }> }>("mod:deleteThenQuery", { id });
    expect(res.viaQuery.some((r) => r._id === id)).toBe(false);
  });

  it("mutation rollback: a mutation that inserts then throws leaves no row behind", async () => {
    await expect(t.mutation("mod:insertThenThrow", { owner: "a", n: 1, tag: "x" })).rejects.toThrow(/boom/);
    const rows = await t.query<Array<unknown>>("mod:allAsc", {});
    expect(rows).toHaveLength(0);
  });

  it("re-insert after delete: deleting a row then inserting identical fields yields a NEW, distinct id", async () => {
    const id1 = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation("mod:del", { id: id1 });
    const id2 = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    expect(id2).not.toBe(id1);
    // the old id must not resolve to the new row (deletion is not "undone" by re-insert)
    expect(await t.query("mod:get", { id: id1 })).toBeNull();
    expect(await t.query("mod:get", { id: id2 })).toMatchObject({ owner: "a", n: 1, tag: "x" });
  });
});
