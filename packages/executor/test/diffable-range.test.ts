import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { serializeKeyRange } from "@stackbase/index-key-codec";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  query,
  mutation,
  type UdfResult,
  type RegisteredFunction,
} from "../src/index";
import type { RunOptions } from "../src/index";
import type { PolicyRegistry, PolicyContextProvider } from "../src/policy";

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

// Finding 1 (identity brand): a `.slice(0, 10)` that is VACUOUS on the current data (≤10 rows) —
// content-identical to a real passthrough, so a content-equality guard would misclassify it
// DIFFABLE. A later 11th in-range insert would have the differ emit an `add` this slice excludes:
// permanent silent wrong data. Must be declined (the array `slice` returns is a fresh, unbranded copy).
const listSlice10 = query<{ channelId: string }, unknown[]>({
  handler: async (ctx, { channelId }) => {
    const docs = await ctx.db.query("items", "by_channel").eq("channelId", channelId).collect();
    return docs.slice(0, 10);
  },
});

// Finding 1: a spread copy `[...docs]` — always content-identical to the collect, always a NEW,
// unbranded array. Must be declined.
const listSpread = query<{ channelId: string }, unknown[]>({
  handler: async (ctx, { channelId }) => {
    const docs = await ctx.db.query("items", "by_channel").eq("channelId", channelId).collect();
    return [...docs];
  },
});

// Finding 1: a `.take(n)` limited collect — passed through unmodified, so (pre-fix) it would have
// slipped past the value≡collect deep-equal check and been misclassified DIFFABLE_RANGE.
const listLimited = query<{ channelId: string }, unknown[]>({
  handler: (ctx, { channelId }) => ctx.db.query("items", "by_channel").eq("channelId", channelId).take(1).collect(),
});

// Finding 2(b): a second read syscall (`db.get`) alongside the collect — readRanges.length >= 2.
const getAndList = query<{ channelId: string; id: string }, unknown[]>({
  handler: async (ctx, { channelId, id }) => {
    await ctx.db.get(id);
    return ctx.db.query("items", "by_channel").eq("channelId", channelId).collect();
  },
});

const registry: Record<string, RegisteredFunction> = {
  "items:add": addItem,
  "items:list": list,
  "items:listFiltered": listFiltered,
  "items:listMapped": listMapped,
  "items:listSliced": listSliced,
  "items:listLimited": listLimited,
  "items:getOne": getOne,
  "items:getAndList": getAndList,
  "items:listSlice10": listSlice10,
  "items:listSpread": listSpread,
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

// Finding 2(a): a read policy on the table (dynamic authz) — `hadReadPolicy`. `read: () => true` is
// an always-allow predicate: it adds no row restriction, so the ONLY thing under test is that a
// read policy's mere presence declines diffability, independent of what it filters.
const readPolicyRegistry: PolicyRegistry = new Map([["items", { read: () => true }]]);
const asUser = (userId: string | null): PolicyContextProvider[] => [
  {
    namespace: "authz",
    build: () => ({ auth: { userId, identity: null, can: async () => false, roles: async () => [], scopesWith: async () => [] } }),
  },
];

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

    // Finding 3: `diffableRange.bounds`/`keyspace` must be byte-identical to the single `index:`
    // entry this same run's own `readRanges` recorded — a later task's differ re-scans this exact
    // interval, so any divergence here would silently corrupt that re-scan.
    const indexReads = r.readRanges.filter((rr) => rr.keyspace.startsWith("index:"));
    expect(indexReads).toHaveLength(1);
    expect(r.diffableRange!.keyspace).toBe(indexReads[0]!.keyspace);
    expect(r.diffableRange!.bounds).toEqual(serializeKeyRange(indexReads[0]!));
  });

  it("a .take(n).collect() handler is NOT diffable (hadLimit — truncated top-N window)", async () => {
    const r = await runQuery("items:listLimited", { channelId });
    expect(r.value).toHaveLength(1); // sanity: the limit was actually applied by the query engine
    expect(r.diffableRange).toBeUndefined();
  });

  it("a handler that does db.get() AND collect() in the same run is NOT diffable (two reads)", async () => {
    const r = await runQuery("items:getAndList", { channelId, id });
    expect(r.diffableRange).toBeUndefined();
  });

  it("a collect under an active read policy is NOT diffable (hadReadPolicy)", async () => {
    const r = await runQuery(
      "items:list",
      { channelId },
      { policyRegistry: readPolicyRegistry, policyProviders: asUser("u1") },
    );
    expect(r.diffableRange).toBeUndefined();
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

  it("a VACUOUS slice(0,10) on ≤10 rows is NOT diffable (identity brand, not content — Finding 1)", async () => {
    // channel `c` has 2 rows, so slice(0,10) returns an array CONTENT-identical to the collect — a
    // content-equality guard would wrongly tag this DIFFABLE. The fresh array `slice` returns is
    // unbranded, so it must decline.
    const r = await runQuery("items:listSlice10", { channelId });
    expect(r.value).toHaveLength(2); // sanity: slice was vacuous on the current data
    expect(r.diffableRange).toBeUndefined();
  });

  it("a spread copy [...docs] is NOT diffable (fresh unbranded array — Finding 1)", async () => {
    const r = await runQuery("items:listSpread", { channelId });
    expect(r.value).toHaveLength(2); // sanity: content-identical to the collect
    expect(r.diffableRange).toBeUndefined();
  });

  it("a by-id get is NOT a range (diffableRange undefined)", async () => {
    expect((await runQuery("items:getOne", { id })).diffableRange).toBeUndefined();
  });
});
