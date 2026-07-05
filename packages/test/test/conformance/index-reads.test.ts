import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";
import { mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

// D1: Helipod has no `.withIndex(cb)` — range predicates chain directly on the
// QueryBuilder returned by `ctx.db.query(table, index)`:
//   ctx.db.query(table, index).eq(field, val).gte(field, val).lt(field, val).order(dir).collect()

describe("conformance — index reads", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
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

  it("an empty range (lo past hi, or gte(x)+lt(x)) returns zero rows without erroring", async () => {
    await seed();
    // lo > hi: the interval's start key sorts after its end key.
    const crossed = await t.query<Array<{ n: number }>>("mod:ownerRange", { owner: "a", lo: 3, hi: 1 });
    expect(crossed).toEqual([]);
    // gte(x).lt(x): the half-open interval degenerates to nothing.
    const degenerate = await t.query<Array<{ n: number }>>("mod:ownerRange", { owner: "a", lo: 2, hi: 2 });
    expect(degenerate).toEqual([]);
  });
});

// A second, INLINE `createTestHelipod` over a single-field index (`by_n`, not the shared
// fixture's compound `by_owner_n`) — exercises operators/behaviors the shared `mod.ts` doesn't
// expose: `.gt`/`.lte` (opposite-boundary inclusivity from the `.gte`/`.lt` test above),
// `.order("desc")` on a non-`by_creation` index, and `.take(n)` (the `limit`/`consumedRange`-trim
// path in `query-runtime.ts`'s `collect`).
const idxSchema = defineSchema({
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
});

const idxMod = {
  insert: mutation(async (ctx: A, a: A) => ctx.db.insert("items", a)),
  gtLte: query(async (ctx: A, a: { lo: number; hi: number }) =>
    ctx.db.query("items", "by_n").gt("n", a.lo).lte("n", a.hi).collect()),
  descRange: query(async (ctx: A, a: { lo: number; hi: number }) =>
    ctx.db.query("items", "by_n").gte("n", a.lo).lte("n", a.hi).order("desc").collect()),
  takeRange: query(async (ctx: A, a: { lo: number; hi: number; limit: number }) =>
    ctx.db.query("items", "by_n").gte("n", a.lo).lt("n", a.hi).take(a.limit).collect()),
};

describe("conformance — index reads (inline single-field index, gt/lte/desc/take)", () => {
  let t2: TestHelipod;

  beforeEach(async () => {
    t2 = await createTestHelipod({ modules: { "mod.ts": idxMod, "schema.ts": { default: idxSchema } } });
    await t2.run(async (ctx) => {
      for (const n of [1, 2, 3, 4, 5]) await ctx.db.insert("items", { n });
    });
  });

  afterEach(async () => {
    await t2.close();
  });

  it("gt(lo) EXCLUDES lo and lte(hi) INCLUDES hi — the opposite boundary behavior from gte/lt", async () => {
    // seeded n=1..5; gt(1).lte(4) should get n in {2,3,4}: 1 excluded, 4 included.
    const rows = await t2.query<Array<{ n: number }>>("mod:gtLte", { lo: 1, hi: 4 });
    expect(rows.map((r) => r.n)).toEqual([2, 3, 4]);
  });

  it(".order(\"desc\") on a range read over a non-by_creation index returns descending index order", async () => {
    // seeded n=1..5; gte(2).lte(4) + desc should get n in {2,3,4} ordered [4,3,2].
    const rows = await t2.query<Array<{ n: number }>>("mod:descRange", { lo: 2, hi: 4 });
    expect(rows.map((r) => r.n)).toEqual([4, 3, 2]);
  });

  it(".take(n) on a range read returns only the first n rows of the range", async () => {
    // seeded n=1..5; gte(1).lt(5) spans {1,2,3,4}; take(2) should return only the first 2: [1,2].
    const rows = await t2.query<Array<{ n: number }>>("mod:takeRange", { lo: 1, hi: 5, limit: 2 });
    expect(rows.map((r) => r.n)).toEqual([1, 2]);
  });
});
