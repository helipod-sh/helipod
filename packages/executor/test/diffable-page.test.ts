import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
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

const list = query<{ channelId: string }, unknown[]>({
  handler: (ctx, { channelId }) => ctx.db.query("items", "by_channel").eq("channelId", channelId).collect(),
});

// Pure passthrough paginate — the executor should classify this DIFFABLE_PAGE.
const page = query<{ channelId: string }, unknown>({
  handler: (ctx, { channelId }) => ctx.db.query("items", "by_channel").eq("channelId", channelId).paginate({ pageSize: 3 }),
});

const pageFiltered = query<{ channelId: string }, unknown>({
  handler: (ctx, { channelId }) =>
    ctx.db.query("items", "by_channel").eq("channelId", channelId).where("gt", "n", 1).paginate({ pageSize: 3 }),
});

// Post-processed: pulls just `.page` back out — an array, not the branded PaginationResult object.
const pageMapped = query<{ channelId: string }, unknown>({
  handler: async (ctx, { channelId }) => {
    const result = await ctx.db.query("items", "by_channel").eq("channelId", channelId).paginate({ pageSize: 3 });
    return result.page;
  },
});

// Post-processed: a spread copy — content-identical but a fresh, unbranded object.
const pageSpread = query<{ channelId: string }, unknown>({
  handler: async (ctx, { channelId }) => {
    const result = await ctx.db.query("items", "by_channel").eq("channelId", channelId).paginate({ pageSize: 3 });
    return { ...result };
  },
});

const registry: Record<string, RegisteredFunction> = {
  "items:add": addItem,
  "items:list": list,
  "items:page": page,
  "items:pageFiltered": pageFiltered,
  "items:pageMapped": pageMapped,
  "items:pageSpread": pageSpread,
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

describe("runQuery diffablePage classification (DLR 2c Task 2)", () => {
  let channelId: string;

  beforeEach(async () => {
    channelId = "c";
    // 5 rows so a pageSize:3 paginate has a genuine next page (hasMore, pinned end bound).
    for (let n = 1; n <= 5; n++) {
      await exec.run(addItem, { channelId, n }, { path: "items:add" });
    }
  });

  it("a pure passthrough paginate is DIFFABLE_PAGE with two-sided bounds + fixed metadata", async () => {
    const r = await runQuery("items:page", { channelId });
    expect(r.diffablePage).toBeDefined();
    expect(r.diffablePage!.bounds.end).not.toBeNull(); // pinned end (there's a next page)
    expect(r.diffablePage!.pageMeta.hasMore).toBe(true);
    expect(typeof r.diffablePage!.pageMeta.nextCursor).toBe("string");
    expect(r.diffablePage!.keyspace.startsWith("index:")).toBe(true);
    expect(r.diffablePage!.fields).toEqual(["channelId"]);
    expect(r.diffablePage!.order).toBe("asc");
    expect(r.diffablePage!.filters).toEqual([]);
    expect(r.diffablePage!.pageMeta.scanCapped).toBe(false);
  });

  it("a filtered passthrough paginate carries the filters", async () => {
    const r = await runQuery("items:pageFiltered", { channelId });
    expect(r.diffablePage).toBeDefined();
    expect(r.diffablePage!.filters.length).toBe(1);
  });

  it("a post-processed paginate (.page / spread) is NOT diffable", async () => {
    expect((await runQuery("items:pageMapped", { channelId })).diffablePage).toBeUndefined();
    expect((await runQuery("items:pageSpread", { channelId })).diffablePage).toBeUndefined();
  });

  it("a collect (2b range) is NOT a page (diffablePage undefined, diffableRange defined)", async () => {
    const r = await runQuery("items:list", { channelId });
    expect(r.diffablePage).toBeUndefined();
    expect(r.diffableRange).toBeDefined();
  });
});
