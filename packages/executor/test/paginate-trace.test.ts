import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime, extractIndexKey, type IndexSpec, type Query } from "@helipod/query-engine";
import { encodeStorageIndexId, DEFAULT_SHARD } from "@helipod/id-codec";
import { deserializeKeyRange, keyInRange } from "@helipod/index-key-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  COLLECT_BRAND,
  createKernelRouter,
  createSeededRandom,
  QUERY_PROFILE,
  query,
  mutation,
  type UdfResult,
  type RegisteredFunction,
  type KernelContext,
  type PaginateTrace,
} from "../src/index";
import type { RunOptions } from "../src/index";

const ITEMS = 20002;

const byChannel: IndexSpec = {
  table: "items",
  tableNumber: ITEMS,
  index: "by_channel",
  fields: ["channelId"],
  indexId: encodeStorageIndexId(ITEMS, "by_channel"),
};

// --- functions under test ---
const addItem = mutation<{ channelId: string; n: number }, string>({
  handler: (ctx, { channelId, n }) => ctx.db.insert("items", { channelId, n }),
});

type PageResult = { page: unknown[]; nextCursor: string | null; hasMore: boolean; scanCapped: boolean };

const page3 = query<{ channelId: string; cursor?: string | null }, PageResult>({
  handler: (ctx, { channelId, cursor }) =>
    ctx.db.query("items", "by_channel").eq("channelId", channelId).paginate({ cursor: cursor ?? null, pageSize: 3 }),
});

const pageAll = query<{ channelId: string }, PageResult>({
  handler: (ctx, { channelId }) => ctx.db.query("items", "by_channel").eq("channelId", channelId).paginate({ pageSize: 10 }),
});

const registry: Record<string, RegisteredFunction> = {
  "items:add": addItem,
  "items:page3": page3,
  "items:pageAll": pageAll,
};

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog().addIndex(byChannel);
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

async function runQuery(path: string, args: unknown, options: Partial<RunOptions> = {}): Promise<UdfResult<unknown>> {
  return exec.run(registry[path]!, args, { path, ...options });
}

describe("db.query(...).paginate() trace + brand (DLR 2c Task 1)", () => {
  let channelId: string;

  beforeEach(async () => {
    channelId = "c";
    for (let i = 0; i < 5; i++) {
      await exec.run(addItem, { channelId, n: i }, { path: "items:add" });
    }
  });

  it("a first page returns the expected shape (3 of 5 rows, hasMore, a cursor)", async () => {
    const r = await runQuery("items:page3", { channelId });
    const value = r.value as PageResult;
    expect(value.page).toHaveLength(3);
    expect(value.hasMore).toBe(true);
    expect(value.nextCursor).not.toBeNull();
    expect(typeof value.nextCursor).toBe("string");
    expect(value.scanCapped).toBe(false);
  });

  it("brands the returned PaginationResult object with COLLECT_BRAND carrying a string token", async () => {
    const r = await runQuery("items:page3", { channelId });
    const value = r.value as PageResult;
    const token = (value as unknown as Record<PropertyKey, unknown>)[COLLECT_BRAND];
    expect(typeof token).toBe("string");
    expect((token as string).length).toBeGreaterThan(0);
  });

  it("a last page (pageSize larger than remaining rows) has hasMore: false, nextCursor: null", async () => {
    const r = await runQuery("items:pageAll", { channelId });
    const value = r.value as PageResult;
    expect(value.page).toHaveLength(5);
    expect(value.hasMore).toBe(false);
    expect(value.nextCursor).toBeNull();
    // Still branded, even on the last page.
    const token = (value as unknown as Record<PropertyKey, unknown>)[COLLECT_BRAND];
    expect(typeof token).toBe("string");
  });
});

/**
 * `PaginateTrace.bounds` (DLR 2c Task 1 review fix): the page-ownership interval a downstream
 * page differ will byte-membership-test against. The kernel records it, but `InlineUdfExecutor`'s
 * public `UdfResult` doesn't surface the raw trace yet — that wiring is Task 2's job (mirroring how
 * `CollectTrace` is only exposed indirectly, via `diffableRange`). So these tests drive
 * `handleDbPaginate` directly through the kernel router (`createKernelRouter().dispatch`, the exact
 * mechanism `InlineSyscallChannel` uses internally) to inspect the trace entry it records.
 *
 * The desc non-final case is the one the review flagged as CRITICAL: the pre-fix derivation
 * (`startBound` = this page's OCC read-set start, `endBound` = `nextCursor`) produced, for a desc
 * page, an interval covering NONE of the page's own rows — proven below by literally recreating
 * that old formula and showing it fails where the fixed `bounds` passes.
 */
describe("PaginateTrace.bounds — order-correct page-ownership interval (DLR 2c Task 1 review fix)", () => {
  const ITEMS2 = 20101;
  const byChannel2: IndexSpec = {
    table: "items2",
    tableNumber: ITEMS2,
    index: "by_channel",
    fields: ["channelId"],
    indexId: encodeStorageIndexId(ITEMS2, "by_channel"),
  };
  const addItem2 = mutation<{ channelId: string; n: number }, string>({
    handler: (ctx, { channelId, n }) => ctx.db.insert("items2", { channelId, n }),
  });

  type ItemDoc = { _id: string; _creationTime: number; channelId: string; n: number };

  let store: SqliteDocStore;
  let transactor: SingleWriterTransactor;
  let queryRuntime: QueryRuntime;
  let catalog: SimpleIndexCatalog;
  let ex: InlineUdfExecutor;

  beforeEach(async () => {
    store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
    queryRuntime = new QueryRuntime(store);
    catalog = new SimpleIndexCatalog().addIndex(byChannel2);
    ex = new InlineUdfExecutor({ transactor, queryRuntime, catalog });

    for (let i = 0; i < 5; i++) {
      await ex.run(addItem2, { channelId: "c", n: i }, { path: "items2:add" });
    }
  });

  /** Drives `db.paginate` directly through the kernel router so the recorded `PaginateTrace` (not
   *  yet surfaced by `InlineUdfExecutor.run`'s public `UdfResult`) is inspectable. */
  async function runPaginateTraced(spec: {
    order?: "asc" | "desc";
    cursor?: string | null;
    pageSize: number;
  }): Promise<{ page: ItemDoc[]; nextCursor: string | null; hasMore: boolean; trace: PaginateTrace }> {
    const router = createKernelRouter();
    const commit = await transactor.runInTransaction(async (txn) => {
      const paginateTrace: PaginateTrace[] = [];
      const kctx: KernelContext = {
        profile: QUERY_PROFILE,
        txn,
        queryRuntime,
        catalog,
        snapshotTs: txn.snapshotTs,
        random: createSeededRandom(1),
        logs: [],
        namespace: "",
        privileged: true,
        identity: null,
        now: Date.now(),
        policyRegistry: new Map(),
        getRuleContext: null,
        relationRegistry: { toMany: new Map(), toOne: new Map() },
        shardId: DEFAULT_SHARD,
        numShards: 1,
        shardDeclared: false,
        paginateTrace,
      };
      const argJson = JSON.stringify({
        table: "items2",
        index: "by_channel",
        order: spec.order,
        cursor: spec.cursor ?? null,
        pageSize: spec.pageSize,
      });
      const res = await router.dispatch(kctx, "db.paginate", argJson);
      const parsed = JSON.parse(res) as { page: ItemDoc[]; nextCursor: string | null; hasMore: boolean };
      return { page: parsed.page, nextCursor: parsed.nextCursor, hasMore: parsed.hasMore, trace: paginateTrace[0]! };
    });
    return commit.value;
  }

  const keyOf = (doc: ItemDoc): Uint8Array => extractIndexKey(doc as unknown as Parameters<typeof extractIndexKey>[0], byChannel2.fields);

  it("asc non-final page: bounds contain this page's rows, exclude the next page's first row", async () => {
    const page1 = await runPaginateTraced({ order: "asc", pageSize: 3 });
    expect(page1.page.map((d) => d.n)).toEqual([0, 1, 2]);
    expect(page1.hasMore).toBe(true);

    const page2 = await runPaginateTraced({ order: "asc", cursor: page1.nextCursor, pageSize: 3 });
    expect(page2.page.map((d) => d.n)).toEqual([3, 4]);

    const bounds = deserializeKeyRange(page1.trace.bounds);
    for (const d of page1.page) expect(keyInRange(keyOf(d), bounds)).toBe(true);
    expect(keyInRange(keyOf(page2.page[0]!), bounds)).toBe(false); // n=3 belongs to the NEXT page
  });

  it("desc non-final page: bounds contain this page's rows, exclude the next page's row (the reported bug)", async () => {
    const page1 = await runPaginateTraced({ order: "desc", pageSize: 3 });
    expect(page1.page.map((d) => d.n)).toEqual([4, 3, 2]);
    expect(page1.hasMore).toBe(true);

    const page2 = await runPaginateTraced({ order: "desc", cursor: page1.nextCursor, pageSize: 3 });
    expect(page2.page.map((d) => d.n)).toEqual([1, 0]);

    // The FIXED bounds: every page-1 row is inside, the page-2 row is outside.
    const bounds = deserializeKeyRange(page1.trace.bounds);
    for (const d of page1.page) expect(keyInRange(keyOf(d), bounds)).toBe(true);
    expect(keyInRange(keyOf(page2.page[0]!), bounds)).toBe(false); // n=1 belongs to the NEXT page

    // Recreate the OLD (pre-fix) formula this trace used to carry — `startBound` = this page's own
    // OCC read-set start (`consumedRange`, which for desc trims to `[lastScanned, interval.end)`,
    // i.e. `lastScanned`'s key — the overflow row one step past the page, here n=1's key) and
    // `endBound` = `nextCursor` (`lastIncluded`'s key — this page's own lowest row, n=2's key) — and
    // show it fails: for a desc page that old `[lastScanned, nextCursor)` interval covered NONE of
    // the page's own rows (n=4/n=3 sort above it, n=2 itself is excluded — half-open end).
    const oldRange = { keyspace: page1.trace.keyspace, start: keyOf(page2.page[0]!), end: keyOf(page1.page[2]!) };
    for (const d of page1.page) {
      expect(keyInRange(keyOf(d), oldRange)).toBe(false); // the bug: NONE of this page's rows are "in bounds"
    }
  });

  it("asc last page: bounds equal the full (resolved) interval it scanned", async () => {
    const onlyPage = await runPaginateTraced({ order: "asc", pageSize: 10 });
    expect(onlyPage.page.map((d) => d.n)).toEqual([0, 1, 2, 3, 4]);
    expect(onlyPage.hasMore).toBe(false);

    const bounds = deserializeKeyRange(onlyPage.trace.bounds);
    for (const d of onlyPage.page) expect(keyInRange(keyOf(d), bounds)).toBe(true);
  });

  it("desc last page: bounds equal the full (resolved) interval it scanned", async () => {
    const onlyPage = await runPaginateTraced({ order: "desc", pageSize: 10 });
    expect(onlyPage.page.map((d) => d.n)).toEqual([4, 3, 2, 1, 0]);
    expect(onlyPage.hasMore).toBe(false);

    const bounds = deserializeKeyRange(onlyPage.trace.bounds);
    for (const d of onlyPage.page) expect(keyInRange(keyOf(d), bounds)).toBe(true);
  });
});
