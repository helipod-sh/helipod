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

const ITEMS = 20001;

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

const listFiltered = query<{ channelId: string }, unknown[]>({
  handler: (ctx, { channelId }) =>
    ctx.db.query("items", "by_channel").eq("channelId", channelId).where("gt", "n", 1).collect(),
});

const listMapped = query<{ channelId: string }, unknown[]>({
  handler: async (ctx, { channelId }) => {
    const docs = await ctx.db.query("items", "by_channel").eq("channelId", channelId).collect();
    return docs.map((d) => ({ ...d, x: 1 }));
  },
});

const listSliced = query<{ channelId: string }, unknown[]>({
  handler: async (ctx, { channelId }) => {
    const docs = await ctx.db.query("items", "by_channel").eq("channelId", channelId).collect();
    return docs.slice(0, 1);
  },
});

const getOne = query<{ id: string }, unknown>({
  handler: (ctx, { id }) => ctx.db.get(id),
});

const registry: Record<string, RegisteredFunction> = {
  "items:add": addItem,
  "items:list": list,
  "items:listFiltered": listFiltered,
  "items:listMapped": listMapped,
  "items:listSliced": listSliced,
  "items:getOne": getOne,
};

let exec: InlineUdfExecutor;
beforeEach(async () => {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const catalog = new SimpleIndexCatalog().addIndex(byChannel);
  exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
});

async function runQuery(path: string, args: unknown): Promise<UdfResult<unknown>> {
  return exec.run(registry[path]!, args, { path });
}

describe("runQuery diffableRange classification (DLR 2b Task 3)", () => {
  let channelId: string;
  let id: string;

  beforeEach(async () => {
    channelId = "c";
    await exec.run(addItem, { channelId, n: 1 }, { path: "items:add" });
    const res = await exec.run(addItem, { channelId, n: 2 }, { path: "items:add" });
    id = res.value as string;
  });

  it("a pure index-range collect returned unmodified is DIFFABLE_RANGE", async () => {
    const r = await runQuery("items:list", { channelId });
    expect(r.diffableRange).toBeDefined();
    expect(r.diffableRange!.keyspace.startsWith("index:")).toBe(true);
    expect(r.diffableRange!.fields).toEqual(["channelId"]);
    expect(r.diffableRange!.order).toBe("asc");
    expect(r.diffableRange!.filters).toEqual([]); // no .where()
  });

  it("a .where()-filtered collect is DIFFABLE_RANGE carrying the filters", async () => {
    const r = await runQuery("items:listFiltered", { channelId });
    expect(r.diffableRange).toBeDefined();
    expect(r.diffableRange!.filters.length).toBe(1);
  });

  it("a handler that maps/slices the collect result is NOT diffable (passthrough fails)", async () => {
    expect((await runQuery("items:listMapped", { channelId })).diffableRange).toBeUndefined();
    expect((await runQuery("items:listSliced", { channelId })).diffableRange).toBeUndefined();
  });

  it("a by-id get is NOT a range (diffableRange undefined)", async () => {
    expect((await runQuery("items:getOne", { id })).diffableRange).toBeUndefined();
  });
});
