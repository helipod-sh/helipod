import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";

// D1: Stackbase has no `.withIndex(cb)` — range predicates chain directly on the
// QueryBuilder returned by `ctx.db.query(table, index)`:
//   ctx.db.query(table, index).eq(field, val).gte(field, val).lt(field, val).order(dir).collect()

describe("conformance — index reads", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  async function seed() {
    // seed deterministically via t.run (privileged, single transaction)
    await t.run(async (ctx) => {
      await ctx.db.insert("docs", { owner: "a", n: 1, tag: "x" });
      await ctx.db.insert("docs", { owner: "a", n: 2, tag: "x" });
      await ctx.db.insert("docs", { owner: "a", n: 3, tag: "x" });
      await ctx.db.insert("docs", { owner: "b", n: 1, tag: "y" });
      await ctx.db.insert("docs", { owner: "b", n: 2, tag: "y" });
    });
  }

  it("range read returns only matching rows for the given owner", async () => {
    await seed();
    const rows = await t.query<Array<{ owner: string; n: number }>>("mod:ownerRange", { owner: "a", lo: 1, hi: 3 });
    expect(rows.every((r) => r.owner === "a")).toBe(true);
  });

  it("the range is half-open: gte(lo) includes lo, lt(hi) excludes hi", async () => {
    await seed();
    // seeded n=1,2,3 for owner "a"; query lo=1 hi=3 should get n in {1,2}, NOT 3
    const rows = await t.query<Array<{ n: number }>>("mod:ownerRange", { owner: "a", lo: 1, hi: 3 });
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });

  it("range results are index-ordered ascending by n", async () => {
    await t.run(async (ctx) => {
      // insert out of n-order to prove the index (not insertion order) determines result order
      await ctx.db.insert("docs", { owner: "a", n: 3, tag: "x" });
      await ctx.db.insert("docs", { owner: "a", n: 1, tag: "x" });
      await ctx.db.insert("docs", { owner: "a", n: 2, tag: "x" });
    });
    const rows = await t.query<Array<{ n: number }>>("mod:ownerRange", { owner: "a", lo: 1, hi: 4 });
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3]);
  });

  it("equality-only read returns all rows for that owner and none of another owner's", async () => {
    await seed();
    const aRows = await t.query<Array<{ owner: string }>>("mod:ownerEq", { owner: "a" });
    const bRows = await t.query<Array<{ owner: string }>>("mod:ownerEq", { owner: "b" });
    expect(aRows).toHaveLength(3);
    expect(aRows.every((r) => r.owner === "a")).toBe(true);
    expect(bRows).toHaveLength(2);
    expect(bRows.every((r) => r.owner === "b")).toBe(true);
  });
});
