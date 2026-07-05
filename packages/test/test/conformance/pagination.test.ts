import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";
import { mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

// D2/D3: Helipod's `paginate` takes `{ cursor?, pageSize, maxScan? }` (not Convex's
// `{ numItems }`) and returns `{ page, nextCursor, hasMore, scanCapped }` (not Convex's
// `{ isDone, continueCursor }`). `isDone` ≡ `!hasMore`; `continueCursor` ≡ `nextCursor`.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

type Page = { page: Array<{ _id: string }>; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };

describe("conformance — pagination", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedFive(): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) {
      ids.push(await t.mutation("mod:insert", { owner: "a", n, tag: "x" }));
    }
    return ids;
  }

  it("first page: pageSize=2 over 5 rows returns 2 rows, hasMore=true, a non-null nextCursor", async () => {
    await seedFive();
    const p = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    expect(p.page).toHaveLength(2);
    expect(p.hasMore).toBe(true);
    expect(p.nextCursor).not.toBeNull();
  });

  it("feeding nextCursor yields the next disjoint page", async () => {
    await seedFive();
    const p1 = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    const p2 = await t.query<Page>("mod:page", { cursor: p1.nextCursor, num: 2 });
    expect(p2.page).toHaveLength(2);
    const ids1 = new Set(p1.page.map((d) => d._id));
    const ids2 = new Set(p2.page.map((d) => d._id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it("the final page has hasMore=false", async () => {
    await seedFive();
    const p1 = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    const p2 = await t.query<Page>("mod:page", { cursor: p1.nextCursor, num: 2 });
    const p3 = await t.query<Page>("mod:page", { cursor: p2.nextCursor, num: 2 });
    expect(p3.page).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
  });

  it("an empty table returns { page: [], hasMore: false, nextCursor: null }", async () => {
    const p = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    expect(p.page).toEqual([]);
    expect(p.hasMore).toBe(false);
    expect(p.nextCursor).toBeNull();
  });

  it("the union of all pages equals the full ordered set with no dupes or gaps", async () => {
    const ids = await seedFive();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: Page = await t.query<Page>("mod:page", { cursor, num: 2 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length); // no dupes
    expect(new Set(seen)).toEqual(new Set(ids)); // no gaps — same set as inserted
  });
});

// ---------------------------------------------------------------------------------------------
// scanCapped: `maxScan` bounds how many index entries a single `paginate` call will examine.
// When the scan stops early because it hit `maxScan` before filling `pageSize`, `scanCapped`
// must be `true` (query-runtime.ts:134-137). A normal, uncapped page must report `false`.
// ---------------------------------------------------------------------------------------------
describe("conformance — pagination scanCapped", () => {
  const capSchema = defineSchema({
    docs: defineTable({ n: v.number() }),
  });
  const capMod = {
    insert: mutation(async (ctx: A, a: { n: number }) => ctx.db.insert("docs", a)),
    page: query(async (ctx: A, a: { cursor: string | null; num: number; maxScan?: number }) =>
      ctx.db.query("docs", "by_creation").paginate({ cursor: a.cursor, pageSize: a.num, maxScan: a.maxScan })),
  };

  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": capMod, "schema.ts": { default: capSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  async function seedTen(): Promise<string[]> {
    const ids: string[] = [];
    for (let n = 1; n <= 10; n++) ids.push(await t.mutation("mod:insert", { n }));
    return ids;
  }

  it("a maxScan smaller than pageSize's worth of rows caps the scan: scanCapped=true, page shorter than pageSize", async () => {
    await seedTen();
    // pageSize asks for 5, but maxScan permits examining only 3 index entries.
    const p = await t.query<Page>("mod:page", { cursor: null, num: 5, maxScan: 3 });
    expect(p.scanCapped).toBe(true);
    expect(p.page.length).toBeLessThan(5);
    expect(p.hasMore).toBe(true);
  });

  it("a normal, uncapped page reports scanCapped=false", async () => {
    await seedTen();
    const p = await t.query<Page>("mod:page", { cursor: null, num: 5 });
    expect(p.scanCapped).toBe(false);
    expect(p.page).toHaveLength(5);
  });

  it("resuming past a capped scan via nextCursor still yields the complete remaining set with no dupes", async () => {
    const ids = await seedTen();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: Page = await t.query<Page>("mod:page", { cursor, num: 4, maxScan: 3 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no dupes
    expect(new Set(seen)).toEqual(new Set(ids)); // complete — nothing skipped despite capping
  });
});

// ---------------------------------------------------------------------------------------------
// Pagination over an index range (not just the default by_creation index): the cursor round
// trip must stay scoped to the filtered index group and return the complete, dup-free set.
// ---------------------------------------------------------------------------------------------
describe("conformance — pagination over an index", () => {
  const idxSchema = defineSchema({
    docs: defineTable({ owner: v.string(), n: v.number() }).index("by_owner_n", ["owner", "n"]),
  });
  const idxMod = {
    insert: mutation(async (ctx: A, a: { owner: string; n: number }) => ctx.db.insert("docs", a)),
    pageByOwner: query(async (ctx: A, a: { owner: string; cursor: string | null; num: number }) =>
      ctx.db.query("docs", "by_owner_n").eq("owner", a.owner).paginate({ cursor: a.cursor, pageSize: a.num })),
  };

  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": idxMod, "schema.ts": { default: idxSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("paginating an eq-filtered index returns the complete, dup-free set for that group only", async () => {
    const aIds: string[] = [];
    const bIds: string[] = [];
    // Interleave two owners so a naive scan that ignored the index range would leak rows.
    for (let n = 1; n <= 5; n++) {
      aIds.push(await t.mutation("mod:insert", { owner: "a", n }));
      bIds.push(await t.mutation("mod:insert", { owner: "b", n }));
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: Page = await t.query<Page>("mod:pageByOwner", { owner: "a", cursor, num: 2 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no dupes
    expect(new Set(seen)).toEqual(new Set(aIds)); // exactly owner "a"'s rows
    for (const id of bIds) expect(seen.includes(id)).toBe(false); // owner "b" never leaks in
  });
});

// ---------------------------------------------------------------------------------------------
// Desc-order pagination: the cursor's desc branch (query-runtime.ts:115, `{ start: base.start,
// end: k }`) must resume correctly across multiple pages.
// ---------------------------------------------------------------------------------------------
describe("conformance — desc-order pagination", () => {
  const descSchema = defineSchema({
    docs: defineTable({ n: v.number() }),
  });
  const descMod = {
    insert: mutation(async (ctx: A, a: { n: number }) => ctx.db.insert("docs", a)),
    pageDesc: query(async (ctx: A, a: { cursor: string | null; num: number }) =>
      ctx.db.query("docs", "by_creation").order("desc").paginate({ cursor: a.cursor, pageSize: a.num })),
  };

  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": descMod, "schema.ts": { default: descSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("multi-page desc pagination resumes via the cursor and its union equals the full set in descending order", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await t.mutation("mod:insert", { n }));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const p: Page = await t.query<Page>("mod:pageDesc", { cursor, num: 2 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length); // no dupes
    expect(seen).toEqual([...ids].reverse()); // full set, in descending (insertion-reverse) order
  });
});

// ---------------------------------------------------------------------------------------------
// Delete-between-pages: deleting a row that was already returned in page 1 must not corrupt
// resumption of subsequent pages via the cursor (no duplicated or skipped rows).
// ---------------------------------------------------------------------------------------------
describe("conformance — pagination with a delete between pages", () => {
  const delSchema = defineSchema({
    docs: defineTable({ n: v.number() }),
  });
  const delMod = {
    insert: mutation(async (ctx: A, a: { n: number }) => ctx.db.insert("docs", a)),
    del: mutation(async (ctx: A, a: { id: string }) => { await ctx.db.delete(a.id); return null; }),
    page: query(async (ctx: A, a: { cursor: string | null; num: number }) =>
      ctx.db.query("docs", "by_creation").paginate({ cursor: a.cursor, pageSize: a.num })),
  };

  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": delMod, "schema.ts": { default: delSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("deleting a row from an already-fetched page does not duplicate or skip rows on later pages", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await t.mutation("mod:insert", { n }));

    const p1 = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    expect(p1.page).toHaveLength(2);

    // Delete a row that was already returned in page 1.
    await t.mutation("mod:del", { id: p1.page[0]!._id });

    const seen: string[] = [];
    let cursor: string | null = p1.nextCursor;
    for (;;) {
      const p = await t.query<Page>("mod:page", { cursor, num: 2 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    // The remaining rows are everything not already returned in page 1 (the deleted row was
    // already consumed by page 1 and is correctly gone from the underlying table too).
    const remainingExpected = ids.filter((id) => !p1.page.some((d) => d._id === id));
    expect(new Set(seen).size).toBe(seen.length); // no dupes
    expect(new Set(seen)).toEqual(new Set(remainingExpected)); // no skips
  });
});

// ---------------------------------------------------------------------------------------------
// Concurrent head-insert stability: inserting a new row after fetching page 1 must not disturb
// resumption of the originally-enumerated rows (query-runtime.ts's doc comment: "Pagination is
// stable under concurrent head inserts because the cursor pins a key position").
// ---------------------------------------------------------------------------------------------
describe("conformance — pagination stability under a concurrent insert", () => {
  const insSchema = defineSchema({
    docs: defineTable({ n: v.number() }),
  });
  const insMod = {
    insert: mutation(async (ctx: A, a: { n: number }) => ctx.db.insert("docs", a)),
    page: query(async (ctx: A, a: { cursor: string | null; num: number }) =>
      ctx.db.query("docs", "by_creation").paginate({ cursor: a.cursor, pageSize: a.num })),
  };

  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": insMod, "schema.ts": { default: insSchema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("a new row inserted after page 1 does not dup/skip the originally-enumerated rows on later pages", async () => {
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await t.mutation("mod:insert", { n }));

    const p1 = await t.query<Page>("mod:page", { cursor: null, num: 2 });
    expect(p1.page).toHaveLength(2);

    // Concurrent insert of a brand-new (newest) row between page fetches.
    const newId = await t.mutation<string>("mod:insert", { n: 999 });

    const seen: string[] = [];
    let cursor: string | null = p1.nextCursor;
    for (;;) {
      const p = await t.query<Page>("mod:page", { cursor, num: 2 });
      seen.push(...p.page.map((d) => d._id));
      if (!p.hasMore) break;
      cursor = p.nextCursor;
    }
    const remainingOriginal = ids.filter((id) => !p1.page.some((d) => d._id === id));
    expect(new Set(seen).size).toBe(seen.length); // no dupes
    // Every originally-enumerated remaining row is present exactly once — cursor stability.
    for (const id of remainingOriginal) expect(seen.includes(id)).toBe(true);
    // The new row, appended at the tail, is also reachable — nothing lost, nothing duplicated.
    expect(seen.includes(newId)).toBe(true);
    expect(new Set(seen)).toEqual(new Set([...remainingOriginal, newId]));
  });
});
