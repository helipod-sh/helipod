/**
 * Fleet B3 Task 1 — the hybrid-node split-read seam. `ExecutorDeps.queryPath` lets `run()` route
 * `fn.type === "query"` to a SEPARATE transactor + `QueryRuntime` pair (a replica, on a real
 * hybrid node), while every mutation stays on the primary pair regardless of `queryPath` being
 * set. The correctness stake spelled out in the design spec (D1): the transactor and the
 * `QueryRuntime` must be selected TOGETHER, as one unit — a half-switched wiring (e.g. a
 * mutation's scans routed to `queryPath.queryRuntime` while its point reads stay on the primary
 * transactor) would split a single mutation's reads across two stores and corrupt
 * read-your-own-writes. Proven here with two REAL, independently-seeded `SqliteDocStore`s so a
 * misrouted call surfaces as visibly wrong DATA, not just a call-count assertion on a stub.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime, type IndexSpec } from "@helipod/query-engine";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

const MESSAGES = 10001;
const byChannel: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_channel",
  fields: ["channelId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_channel"),
};

function catalog(): SimpleIndexCatalog {
  return new SimpleIndexCatalog().addIndex(byChannel);
}

const listByChannel = query<{ channelId: string }, Array<{ body: string }>>({
  handler: (ctx, { channelId }) =>
    ctx.db.query("messages", "by_channel").eq("channelId", channelId).collect() as Promise<Array<{ body: string }>>,
});

const send = mutation<{ channelId: string; body: string }, string>({
  handler: (ctx, { channelId, body }) => ctx.db.insert("messages", { channelId, body }),
});

// The split-brain regression probe: insert, THEN scan + point-read the SAME document within the
// SAME mutation. Both must see the just-staged write — which only holds if the scan (via
// `kctx.queryRuntime`) and the point read (via `ctx.txn.get`, the transactor's own
// `TransactionContext`) go through the SAME store. If a mutation's `queryRuntime` were ever
// wrongly swapped to `queryPath`'s (a store with none of this transaction's staged writes), the
// scan would come back empty while the point read still succeeds — a visible split.
const insertThenReadBack = mutation<{ channelId: string; body: string }, { scanCount: number; pointReadBody: unknown }>({
  handler: async (ctx, { channelId, body }) => {
    const id = await ctx.db.insert("messages", { channelId, body });
    const scanned = (await ctx.db.query("messages", "by_channel").eq("channelId", channelId).collect()) as Array<{
      body: string;
    }>;
    const pointRead = (await ctx.db.get(id)) as { body: string } | null;
    return { scanCount: scanned.length, pointReadBody: pointRead?.body ?? null };
  },
});

async function freshStore(): Promise<SqliteDocStore> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  return store;
}

function makeTransactor(store: SqliteDocStore): SingleWriterTransactor {
  return new SingleWriterTransactor(store, new MonotonicTimestampOracle(0n));
}

describe("executor queryPath split-read seam", () => {
  let primary: SqliteDocStore;
  let secondary: SqliteDocStore;

  beforeEach(async () => {
    primary = await freshStore();
    secondary = await freshStore();
  });

  it("(a) a query with queryPath configured reads the QUERY store, not the primary", async () => {
    // ONE transactor instance per store, reused for every executor pointed at that store in this
    // test — a fresh `SingleWriterTransactor` seeds its oracle at ts=0, so reusing the instance
    // that did the write is what lets a later read see it (the store itself is durable; the
    // oracle snapshot is the thing that must carry forward, exactly as `EmbeddedRuntime.create`
    // seeds its oracle from `store.maxTimestamp()` rather than always starting fresh at 0).
    const secondaryTransactor = makeTransactor(secondary);
    const seedExec = new InlineUdfExecutor({
      transactor: secondaryTransactor,
      queryRuntime: new QueryRuntime(secondary),
      catalog: catalog(),
    });
    // Seed a channel that exists ONLY on `secondary` — never written to `primary`.
    await seedExec.run(send, { channelId: "c1", body: "secondary-only" }, { path: "seed" });

    const exec = new InlineUdfExecutor({
      transactor: makeTransactor(primary),
      queryRuntime: new QueryRuntime(primary),
      catalog: catalog(),
      queryPath: { transactor: secondaryTransactor, queryRuntime: new QueryRuntime(secondary) },
    });

    const r = await exec.run<Array<{ body: string }>>(listByChannel, { channelId: "c1" }, { path: "list" });
    // Found on `secondary` (the query store), even though `primary` (the mutation/write store)
    // has nothing under this channel — proves the query used queryPath's pair, not the primary's.
    expect(r.value.map((d) => d.body)).toEqual(["secondary-only"]);
  });

  it("(a) a mutation in the SAME executor still uses the primary pair — no split-brain reads", async () => {
    const primaryTransactor = makeTransactor(primary);
    const exec = new InlineUdfExecutor({
      transactor: primaryTransactor,
      queryRuntime: new QueryRuntime(primary),
      catalog: catalog(),
      queryPath: { transactor: makeTransactor(secondary), queryRuntime: new QueryRuntime(secondary) },
    });

    const r = await exec.run<{ scanCount: number; pointReadBody: unknown }>(
      insertThenReadBack,
      { channelId: "c2", body: "primary-write" },
      { path: "insertThenReadBack" },
    );
    // Both the scan (queryRuntime) and the point read (transactor) saw the just-staged write —
    // they went through the SAME store (primary), not split across primary + queryPath.
    expect(r.value.scanCount).toBe(1);
    expect(r.value.pointReadBody).toBe("primary-write");

    // And the write actually landed on `primary` (not `secondary`, which the mutation never
    // touches) — reuse `primaryTransactor` (same oracle) so this read sees the commit above.
    const verifyPrimary = new InlineUdfExecutor({ transactor: primaryTransactor, queryRuntime: new QueryRuntime(primary), catalog: catalog() });
    const onPrimary = await verifyPrimary.run<Array<{ body: string }>>(listByChannel, { channelId: "c2" }, { path: "list" });
    expect(onPrimary.value.map((d) => d.body)).toEqual(["primary-write"]);

    const verifySecondary = new InlineUdfExecutor({ transactor: makeTransactor(secondary), queryRuntime: new QueryRuntime(secondary), catalog: catalog() });
    const onSecondary = await verifySecondary.run<Array<{ body: string }>>(listByChannel, { channelId: "c2" }, { path: "list" });
    expect(onSecondary.value).toEqual([]);
  });

  it("no queryPath configured → a query reads the primary store (byte-identical to before this seam)", async () => {
    const exec = new InlineUdfExecutor({
      transactor: makeTransactor(primary),
      queryRuntime: new QueryRuntime(primary),
      catalog: catalog(),
    });
    await exec.run(send, { channelId: "c3", body: "plain" }, { path: "seed" });
    const r = await exec.run<Array<{ body: string }>>(listByChannel, { channelId: "c3" }, { path: "list" });
    expect(r.value.map((d) => d.body)).toEqual(["plain"]);
  });
});
