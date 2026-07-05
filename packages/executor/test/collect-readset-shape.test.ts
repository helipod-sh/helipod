/**
 * DLR Stage 2b — Task 1: characterization spike (spec §7 open item).
 *
 * QUESTION: what `readRanges` shape does a single-index `collect()` actually record — one
 * `index:<...>` range only, or that index range PLUS a per-row `table:<...>` primary point for
 * each fetched document?
 *
 * OBSERVED (from a real run — `bun run --filter @helipod/executor test collect-readset-shape` —
 * see the `console.log`s below for the raw JSON): a single-index `collect()`, filtered or
 * unfiltered, records EXACTLY ONE `index:<tableNumber>:<indexName>` range and NOTHING ELSE. No
 * per-row `table:<...>` primary-key points are recorded. Note the keyspace is keyed by the
 * table's STORAGE NUMBER (e.g. `index:9001:by_channel`), not its name — `QueryRuntime`'s private
 * `keyspace()` builds it via `indexKeyspaceId(encodeStorageTableId(index.tableNumber), index.index)`
 * so read ranges and the transactor's write ranges share one table identity, immune to renames.
 *
 * This traces directly to `packages/query-engine/src/query-runtime.ts`'s `QueryRuntime.collect()`
 * (the non-overlay / pure query path exercised here — no pending writes to overlay): it scans the
 * index via `docStore.index_scan`, evaluates `.where()` filters against the document values
 * already yielded by that scan (no extra store reads), and adds exactly one range — the full
 * scanned interval (`{ keyspace: this.keyspace(query.index), start: interval.start, end:
 * interval.end }`) unless the scan was capped by a `limit`, in which case it trims to
 * `consumedRange(...)` — still one range. The `.where()` filter changes which documents are
 * RETURNED, not what is RECORDED: the read range is the full `channelId`-scoped interval
 * regardless of the `n` filter, because a future write anywhere in that interval (including one
 * that would newly satisfy the filter) must still invalidate the subscription.
 *
 * THE FACT this pins for Task 4's classifier: "exactly one index-keyspace range, no table-keyspace
 * range" is a correct — not merely assumed — DIFFABLE-candidate signal for a single-index,
 * non-overlay `collect()`. There is no companion primary-key point read to also account for.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { MonotonicTimestampOracle } from "@helipod/docstore";
import { SingleWriterTransactor } from "@helipod/transactor";
import { QueryRuntime, type IndexSpec } from "@helipod/query-engine";
import { encodeStorageIndexId } from "@helipod/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

const ITEMS = 9001;
const byChannel: IndexSpec = {
  table: "items",
  tableNumber: ITEMS,
  index: "by_channel",
  fields: ["channelId"],
  indexId: encodeStorageIndexId(ITEMS, "by_channel"),
};

async function harness(): Promise<InlineUdfExecutor> {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog().addIndex(byChannel);
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

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

async function seedThreeRows(ex: InlineUdfExecutor): Promise<void> {
  await ex.run(addItem, { channelId: "c", n: 1 });
  await ex.run(addItem, { channelId: "c", n: 2 });
  await ex.run(addItem, { channelId: "c", n: 3 });
}

describe("collect() recorded read-set shape (DLR 2b Task 1)", () => {
  it("an unfiltered single-index collect records exactly one index range and nothing else", async () => {
    const ex = await harness();
    await seedThreeRows(ex);

    const res = await ex.run<unknown[]>(list, { channelId: "c" });
    expect(res.value).toHaveLength(3);

    // eslint-disable-next-line no-console
    console.log("unfiltered collect readRanges:", JSON.stringify(res.readRanges));

    // Exactly one range, and it's the index range — no per-row table:<...> primary points.
    // Keyspace is keyed by the table's STORAGE NUMBER, not its name (see top-of-file note).
    expect(res.readRanges).toHaveLength(1);
    expect(res.readRanges[0]!.keyspace).toBe(`index:${ITEMS}:by_channel`);
  });

  it("a .where()-filtered collect records the SAME single index-range shape (no extra points)", async () => {
    const ex = await harness();
    await seedThreeRows(ex);

    const res = await ex.run<unknown[]>(listFiltered, { channelId: "c" });
    expect(res.value).toHaveLength(2); // n=2, n=3 (n=1 filtered out by the >1 predicate)

    // eslint-disable-next-line no-console
    console.log("filtered collect readRanges:", JSON.stringify(res.readRanges));

    // The filter narrows what's RETURNED, not what's RECORDED — still exactly one range, covering
    // the full channelId-scoped interval (including the n=1 row that didn't match the filter).
    expect(res.readRanges).toHaveLength(1);
    expect(res.readRanges[0]!.keyspace).toBe(`index:${ITEMS}:by_channel`);
  });
});
