/**
 * Shards B2a Task 3 — shardBy resolution + always-on kernel ownership guards, exercised at
 * Tier-0 SQLite through the REAL `InlineUdfExecutor` + `ShardedTransactor` (the every-tier proof:
 * these same guards run on the laptop, in `stackbase dev`'s virtual shards, and on the fleet).
 *
 * Representative channel ids (numShards = 8), found by scanning shardIdForKeyValue:
 *   chan-3 → default   chan-1 → s1   chan-5 → s2   chan-13 → s3   chan-0 → s4
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { ShardedTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId, encodeStorageTableId, shardIdForKeyValue } from "@stackbase/id-codec";
import { indexKeyspaceId } from "@stackbase/index-key-codec";
import * as idCodec from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, type RegisteredFunction, type UdfResult } from "../src/index";

const MESSAGES = 10001;
const SETTINGS = 10002;
const N = 8;

const byChannel: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_channel",
  fields: ["channelId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_channel"),
};
const messagesByCreation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_creation",
  fields: [],
  indexId: encodeStorageIndexId(MESSAGES, "by_creation"),
};
const settingsByCreation: IndexSpec = {
  table: "settings",
  tableNumber: SETTINGS,
  index: "by_creation",
  fields: [],
  indexId: encodeStorageIndexId(SETTINGS, "by_creation"),
};

function shardedCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("messages", MESSAGES, undefined, false, "channelId"); // sharded by channelId
  catalog.addIndex(byChannel).addIndex(messagesByCreation);
  catalog.addTable("settings", SETTINGS, undefined, false, null); // unsharded / global
  catalog.addIndex(settingsByCreation);
  return catalog;
}

function makeExec(store: SqliteDocStore, catalog: SimpleIndexCatalog): InlineUdfExecutor {
  const transactor = new ShardedTransactor(store);
  return new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog });
}

let store: SqliteDocStore;
let exec: InlineUdfExecutor;
let catalog: SimpleIndexCatalog;
beforeEach(async () => {
  store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  catalog = shardedCatalog();
  exec = makeExec(store, catalog);
});

const run = <T = unknown>(fn: RegisteredFunction, args: unknown, path = "test") =>
  exec.run<T>(fn, args, { numShards: N, path });

// --- functions a user would author -------------------------------------------------------------
const sendSharded = mutation<{ channelId: string; body: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { channelId, body }) => ctx.db.insert("messages", { channelId, body }),
});
const sendMismatched = mutation<{ channelId: string; docChannel: string; body: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { docChannel, body }) => ctx.db.insert("messages", { channelId: docChannel, body }),
});
const sendDefault = mutation<{ channelId: string; body: string }, string>({
  handler: (ctx, { channelId, body }) => ctx.db.insert("messages", { channelId, body }),
});
const writeSetting = mutation<{ key: string }, string>({
  handler: (ctx, { key }) => ctx.db.insert("settings", { key }),
});
const writeSettingFromSharded = mutation<{ channelId: string; key: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { key }) => ctx.db.insert("settings", { key }),
});
const getDocSharded = mutation<{ channelId: string; id: string }, unknown>({
  shardBy: "channelId",
  handler: (ctx, { id }) => ctx.db.get(id),
});
const getDocQuery = query<{ id: string }, unknown>({ handler: (ctx, { id }) => ctx.db.get(id) });
const replaceKeepShard = mutation<{ channelId: string; id: string; body: string }, void>({
  shardBy: "channelId",
  handler: (ctx, { channelId, id, body }) => ctx.db.replace(id, { channelId, body }),
});
const replaceChangeShard = mutation<{ channelId: string; id: string; newChannel: string; body: string }, void>({
  shardBy: "channelId",
  handler: (ctx, { id, newChannel, body }) => ctx.db.replace(id, { channelId: newChannel, body }),
});
const deleteSharded = mutation<{ channelId: string; id: string }, void>({
  shardBy: "channelId",
  handler: (ctx, { id }) => ctx.db.delete(id),
});
const scanPinned = mutation<{ channelId: string }, unknown[]>({
  shardBy: "channelId",
  handler: (ctx, { channelId }) => ctx.db.query("messages", "by_channel").eq("channelId", channelId).collect(),
});
const scanForeignPinned = mutation<{ channelId: string; other: string }, unknown[]>({
  shardBy: "channelId",
  handler: (ctx, { other }) => ctx.db.query("messages", "by_channel").eq("channelId", other).collect(),
});
const scanUnpinned = mutation<{ channelId: string }, unknown[]>({
  shardBy: "channelId",
  handler: (ctx) => ctx.db.query("messages", "by_creation").collect(),
});
const scanSettingsFromSharded = mutation<{ channelId: string }, unknown[]>({
  shardBy: "channelId",
  handler: (ctx) => ctx.db.query("settings", "by_creation").collect(),
});

describe("shardBy resolution (executor)", () => {
  it("routes a mutation by its shardBy arg — a document routing to its shard commits", async () => {
    const r = await run<string>(sendSharded, { channelId: "chan-1", body: "hi" }); // s1
    expect(typeof r.value).toBe("string");
    expect(r.committed).toBe(true);
  });

  it("accepts a resolver function form of shardBy", async () => {
    const fn = mutation<{ channelId: string; body: string }, string>({
      shardBy: (a: { channelId: string }) => a.channelId,
      handler: (ctx, { channelId, body }) => ctx.db.insert("messages", { channelId, body }),
    });
    const r = await run<string>(fn, { channelId: "chan-2", body: "hi" });
    expect(r.committed).toBe(true);
  });

  it("surfaces a clean error when a shardBy resolver throws", async () => {
    const fn = mutation<{ channelId: string }, string>({
      shardBy: () => {
        throw new Error("boom");
      },
      handler: (ctx, { channelId }) => ctx.db.insert("messages", { channelId, body: "x" }),
    });
    await expect(run(fn, { channelId: "chan-1" }, "resolverThrows")).rejects.toThrow(
      /shardBy resolver for "resolverThrows" threw: boom/,
    );
  });

  it("a no-shardBy mutation runs on 'default' and freely writes an unsharded table", async () => {
    const r = await run<string>(writeSetting, { key: "theme" });
    expect(r.committed).toBe(true);
  });
});

describe("write ownership guards", () => {
  it("rejects writing a sharded table from an undeclared (default) mutation, naming the fix", async () => {
    await expect(run(sendDefault, { channelId: "chan-1", body: "x" })).rejects.toThrow(
      /table 'messages' is sharded by 'channelId'.*does not declare a shard.*Add shardBy: 'channelId'/s,
    );
  });

  it("rejects an insert whose shard-key value routes to a different shard, naming both shards", async () => {
    // mutation runs on s1 (chan-1), but the document's channelId chan-5 routes to s2.
    await expect(run(sendMismatched, { channelId: "chan-1", docChannel: "chan-5", body: "x" })).rejects.toThrow(
      /runs on shard s1 but the document \(channelId="chan-5"\) routes to shard s2/,
    );
  });

  it("allows a sharded mutation to write an unsharded (global) table", async () => {
    const r = await run<string>(writeSettingFromSharded, { channelId: "chan-1", key: "k" });
    expect(r.committed).toBe(true);
  });

  it("rejects a replace that changes the shard-key field (immutable after insert)", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-1", body: "a" });
    await expect(
      run(replaceChangeShard, { channelId: "chan-1", id: created.value, newChannel: "chan-5", body: "b" }),
    ).rejects.toThrow(/cannot change the shard-key field 'channelId'.*immutable after insert/s);
  });

  it("allows a replace that keeps the shard-key field", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-1", body: "a" });
    const r = await run(replaceKeepShard, { channelId: "chan-1", id: created.value, body: "b" });
    expect(r.committed).toBe(true);
  });

  it("rejects deleting a foreign-shard row (delete routes by the stored document's key)", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-5", body: "a" }); // lives on s2
    // Delete from a mutation on s1 (chan-1): the stored doc routes to s2 → wrong shard.
    await expect(run(deleteSharded, { channelId: "chan-1", id: created.value })).rejects.toThrow(
      /runs on shard s1 but the document \(channelId="chan-5"\) routes to shard s2/,
    );
  });
});

describe("read ownership guards", () => {
  it("read-then-reject: a sharded mutation get()ing a foreign-shard row errors, naming both shards", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-5", body: "a" }); // s2
    await expect(run(getDocSharded, { channelId: "chan-1", id: created.value })).rejects.toThrow(
      /only read rows of its own shard/,
    );
  });

  it("a sharded mutation get()ing its OWN-shard row succeeds", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-1", body: "a" }); // s1
    const r = await run(getDocSharded, { channelId: "chan-1", id: created.value });
    expect((r.value as { body: string }).body).toBe("a");
  });

  it("a read-only QUERY reads every shard untouched (no guard)", async () => {
    const created = await run<string>(sendSharded, { channelId: "chan-5", body: "a" }); // s2
    const r = await run(getDocQuery, { id: created.value }); // query, no shardBy
    expect((r.value as { body: string }).body).toBe("a");
  });

  it("accepts a pinned scan on the shard-key index eq()'d to the mutation's own shard", async () => {
    await run(sendSharded, { channelId: "chan-1", body: "a" });
    const r = await run<unknown[]>(scanPinned, { channelId: "chan-1" });
    expect(r.value.length).toBe(1);
  });

  it("rejects a pinned scan eq()'d to a value routing to a DIFFERENT shard", async () => {
    await expect(run(scanForeignPinned, { channelId: "chan-1", other: "chan-5" })).rejects.toThrow(
      /pinned to 'channelId'="chan-5", which routes to shard s2/,
    );
  });

  it("rejects an unpinned scan of a sharded table (index whose first field is not the shard key)", async () => {
    await expect(run(scanUnpinned, { channelId: "chan-1" })).rejects.toThrow(
      /may only scan it via an index whose first field is 'channelId'/,
    );
  });

  it("allows a sharded mutation to scan an unsharded (global) table", async () => {
    await run(writeSetting, { key: "k" });
    const r = await run<unknown[]>(scanSettingsFromSharded, { channelId: "chan-1" });
    expect(r.value.length).toBe(1);
  });
});

describe("split-snapshot OCC classification (D4)", () => {
  // A sharded mutation reads a GLOBAL table (recorded invalidation-only) AND its home-shard sharded
  // table (OCC-validated). A concurrent same-shard commit touching the global range must NOT abort
  // it; a concurrent commit touching its home-shard range MUST. Both ranges appear in the reported
  // read set (invalidation precision). Interleave: park the mutation on a barrier after its reads,
  // commit the concurrent writer, release, then let it commit.
  async function runInterleaved(concurrent: RegisteredFunction, concurrentArgs: unknown) {
    let attempts = 0;
    let signalReached!: () => void;
    const reached = new Promise<void>((r) => (signalReached = r));
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));

    const reader = mutation<{ channelId: string }, { settings: number; msgs: number }>({
      shardBy: "channelId",
      handler: async (ctx, { channelId }) => {
        attempts++;
        const s = (await ctx.db.query("settings", "by_creation").collect()) as unknown[]; // global → unvalidated
        const m = (await ctx.db.query("messages", "by_channel").eq("channelId", channelId).collect()) as unknown[]; // validated
        if (attempts === 1) {
          signalReached();
          await barrier;
        }
        await ctx.db.insert("messages", { channelId, body: "reader" });
        return { settings: s.length, msgs: m.length };
      },
    });

    const pReader = run(reader, { channelId: "chan-1" }, "reader"); // s1
    await reached;
    await run(concurrent, concurrentArgs, "concurrent"); // commits on s1
    release();
    const res = await pReader;
    return { res, attempts: () => attempts };
  }

  it("a concurrent GLOBAL-table write does NOT abort the sharded mutation", async () => {
    const { res, attempts } = await runInterleaved(writeSettingFromSharded, { channelId: "chan-1", key: "flag" });
    expect(res.committed).toBe(true);
    expect(attempts()).toBe(1); // no retry: the global read is invalidation-only, not OCC-validated
  });

  it("a concurrent HOME-SHARD write DOES abort (and it retries to success)", async () => {
    const { res, attempts } = await runInterleaved(sendSharded, { channelId: "chan-1", body: "rival" });
    expect(res.committed).toBe(true);
    expect(attempts()).toBe(2); // validated home-shard read conflicted → one retry
  });

  it("the reported read set contains BOTH the global and the home-shard ranges", async () => {
    const { res } = await runInterleaved(writeSettingFromSharded, { channelId: "chan-1", key: "flag" });
    const keyspaces = new Set((res as UdfResult).readRanges.map((r) => r.keyspace));
    const settingsKs = indexKeyspaceId(encodeStorageTableId(SETTINGS), "by_creation");
    const messagesKs = indexKeyspaceId(encodeStorageTableId(MESSAGES), "by_channel");
    expect(keyspaces.has(settingsKs)).toBe(true);
    expect(keyspaces.has(messagesKs)).toBe(true);
  });
});

describe("zero overhead for unsharded apps", () => {
  it("never routes a shard-key value when no table declares a shardKey (guards short-circuit)", async () => {
    const spy = vi.spyOn(idCodec, "shardIdForKeyValue");
    try {
      const plainCatalog = new SimpleIndexCatalog();
      plainCatalog.addTable("settings", SETTINGS, undefined, false, null);
      plainCatalog.addIndex(settingsByCreation);
      const plainStore = new SqliteDocStore(new NodeSqliteAdapter());
      await plainStore.setupSchema();
      const plainExec = makeExec(plainStore, plainCatalog);

      await plainExec.run(writeSetting, { key: "a" }, { numShards: N, path: "w" });
      await plainExec.run(getDocQuery, { id: "x" }, { numShards: N, path: "q" }).catch(() => {});
      expect(spy).not.toHaveBeenCalled(); // no shardKey anywhere → routing never runs

      // Positive control: a genuinely sharded mutation DOES route (proving the spy is wired).
      spy.mockClear();
      await exec.run(sendSharded, { channelId: "chan-1", body: "x" }, { numShards: N, path: "s" });
      expect(spy.mock.calls.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});
