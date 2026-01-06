import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  COLLECT_BRAND,
  query,
  mutation,
  type UdfResult,
  type RegisteredFunction,
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
