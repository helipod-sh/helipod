import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";

// D2/D3: Stackbase's `paginate` takes `{ cursor?, pageSize, maxScan? }` (not Convex's
// `{ numItems }`) and returns `{ page, nextCursor, hasMore, scanCapped }` (not Convex's
// `{ isDone, continueCursor }`). `isDone` ≡ `!hasMore`; `continueCursor` ≡ `nextCursor`.

type Page = { page: Array<{ _id: string }>; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };

describe("conformance — pagination", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
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
