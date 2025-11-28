/**
 * Regression coverage for the client-supplied-ids review's CRITICAL: the supplied-`_id` existence
 * check (`ctx.txn.get(decoded)`) is a PER-RING snapshot read on the default `ShardedTransactor`
 * (`packages/transactor/src/shard-writer.ts` — per-shard mutex, per-shard `recentCommits`), so
 * without a guard, two concurrent inserts of the SAME minted `_id` on DIFFERENT rings could both
 * commit — a silent duplicate identity (forked `prev_ts` chain).
 *
 * The fix (kernel.ts `handleDbInsert`, BEFORE the existence read): a client-supplied `_id` is
 * accepted only when the target table is UNSHARDED and the executing mutation runs on the
 * DEFAULT ring. Both together make the existence check + OCC validated-read-set globally sound
 * for that table — every write of it lands on the one ring, so a genuine race loses at OCC there.
 *
 * Harness modeled on `shard-guards.test.ts`: the real `InlineUdfExecutor` + `ShardedTransactor`
 * over SQLite, numShards = 8 — the every-tier proof (laptop, `stackbase dev` virtual shards, fleet
 * all share this code path).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { ShardedTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, type RegisteredFunction } from "../src/index";
import { mintEncodedDocumentId } from "@stackbase/id-codec";
import type { DocumentValue } from "@stackbase/docstore";

const CONVOS = 10001; // unsharded
const MESSAGES = 10002; // sharded by channelId
const N = 8;

function shardedCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("convos", CONVOS, undefined, false, null); // unsharded / global
  catalog.addTable("messages", MESSAGES, undefined, false, "channelId"); // sharded by channelId
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
const createConvoWithId = mutation<{ _id: string; name: string }, string>({
  handler: (ctx, a) => ctx.db.insert("convos", a as unknown as DocumentValue),
});
const createMessageWithId = mutation<{ channelId: string; _id: string; body: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { channelId, _id, body }) =>
    ctx.db.insert("messages", { _id, channelId, body } as unknown as DocumentValue),
});
const createConvoWithIdFromSharded = mutation<{ channelId: string; _id: string; name: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { _id, name }) => ctx.db.insert("convos", { _id, name } as unknown as DocumentValue),
});
const getConvo = query<{ id: string }, unknown>({ handler: (ctx, { id }) => ctx.db.get(id) });

describe("client-supplied _id: v1 shard-safety gate", () => {
  it("(a) rejects a supplied _id on a SHARDED table — static rejection, no barrier needed", async () => {
    const minted = mintEncodedDocumentId(MESSAGES);
    await expect(
      run(createMessageWithId, { channelId: "chan-1", _id: minted, body: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_CLIENT_ID" });
    // and no row was written under it
    const doc = (await run(getConvo, { id: minted })).value;
    expect(doc).toBeNull();
  });

  it("(b) rejects a supplied _id on an UNSHARDED table from a shard-routed (non-default-ring) mutation", async () => {
    const minted = mintEncodedDocumentId(CONVOS);
    await expect(
      run(createConvoWithIdFromSharded, { channelId: "chan-1", _id: minted, name: "x" }),
    ).rejects.toMatchObject({ code: "INVALID_CLIENT_ID" });
    const doc = (await run(getConvo, { id: minted })).value;
    expect(doc).toBeNull();
  });

  it("(c) the original race, NOW SAFE: two barrier-synchronized default-ring inserts of the SAME _id — exactly one commits, the loser retries and gets ID_ALREADY_IN_USE", async () => {
    // Before this fix, this exact scenario run cross-ring (one mutation on the default ring, one
    // shardBy-routed) both committed silently — a forked prev_ts chain under one _id. With the
    // gate above, a shard-routed insert of a client id is rejected outright (test (b)), so the
    // only surviving concurrent-insert case is two DEFAULT-ring transactions — which the shard
    // mutex + per-shard OCC validated-read-set now makes genuinely safe: the loser's commit
    // conflicts (its existence read intersects the winner's write), the executor's transactor
    // retry loop deterministically replays the loser's handler, and the fresh read finds the row.
    const minted = mintEncodedDocumentId(CONVOS);

    let signalRead!: () => void;
    const readDone = new Promise<void>((r) => (signalRead = r));
    let releaseLoser!: () => void;
    const gate = new Promise<void>((r) => (releaseLoser = r));

    const raceInsert = mutation<{ _id: string; name: string }, string>({
      handler: async (ctx, a) => {
        // Reaches here only on an attempt where the existence check passed (not-found) — a
        // retried attempt that finds the row throws INSIDE ctx.db.insert, before this line.
        const id = await ctx.db.insert("convos", { _id: a._id, name: a.name } as unknown as DocumentValue);
        signalRead();
        await gate; // park the FIRST attempt here — its commit is delayed until we release
        return id;
      },
    });

    const loser = run(raceInsert, { _id: minted, name: "loser" }, "loser");
    await readDone; // the loser's first attempt has read "not found" and staged its insert

    const winnerResult = await run<string>(createConvoWithId, { _id: minted, name: "winner" }, "winner");
    expect(winnerResult.value).toBe(minted);
    expect(winnerResult.committed).toBe(true);

    releaseLoser(); // let the loser's parked first attempt return -> commit -> OCC conflict -> retry

    await expect(loser).rejects.toMatchObject({ code: "ID_ALREADY_IN_USE" });

    // Exactly one row exists under the shared id, and it's the winner's.
    const doc = (await run<{ name: string }>(getConvo, { id: minted })).value;
    expect(doc).toMatchObject({ _id: minted, name: "winner" });
  });
});
