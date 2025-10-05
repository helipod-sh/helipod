/**
 * Shards B2b Task 1 — per-shard write routing at the executor chokepoint. The keystone: the
 * `WriteRouter` check moved from the runtime (BEFORE shard resolution, so drivers bypassed it)
 * into `InlineUdfExecutor.run` (AFTER `shardBy`/privileged shard resolution). Proven here through
 * the REAL executor + `ShardedTransactor` at Tier-0 SQLite with a fake router.
 *
 * Channel ids (numShards = 8): chan-3 → default · chan-1 → s1 · chan-5 → s2.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { ShardedTransactor } from "@stackbase/transactor";
import { QueryRuntime, type IndexSpec } from "@stackbase/query-engine";
import { encodeStorageIndexId, type ShardId } from "@stackbase/id-codec";
import type { JSONValue } from "@stackbase/values";
import {
  InlineUdfExecutor,
  SimpleIndexCatalog,
  mutation,
  query,
  type RegisteredFunction,
  type WriteRouter,
  type UdfResult,
} from "../src/index";

const MESSAGES = 10001;
const N = 8;

const byChannel: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_channel",
  fields: ["channelId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_channel"),
};

function shardedCatalog(): SimpleIndexCatalog {
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("messages", MESSAGES, undefined, false, "channelId"); // sharded by channelId
  catalog.addIndex(byChannel);
  return catalog;
}

const sendSharded = mutation<{ channelId: string; body: string }, string>({
  shardBy: "channelId",
  handler: (ctx, { channelId, body }) => ctx.db.insert("messages", { channelId, body }),
});
const listByChannel = query<{ channelId: string }, unknown[]>({
  handler: (ctx, { channelId }) => ctx.db.query("messages", "by_channel").eq("channelId", channelId).collect(),
});
// Privileged whole-doc replace — models the admin `_system:patchDocument` path (routed purely by
// RunOptions.shardId).
const replacePriv = mutation<{ id: string; channelId: string; body: string }, void>({
  handler: (ctx, { id, channelId, body }) => ctx.db.replace(id, { channelId, body }),
});

/** A fake router that owns exactly `held` shards; `forward` records its calls and returns `response`. */
function fakeRouter(held: ShardId[], response: { value: JSONValue; commitTs?: number } = { value: "forwarded" }) {
  const heldSet = new Set<ShardId>(held);
  const forward = vi.fn(async () => response);
  const router: WriteRouter = { isLocalWriter: (s) => heldSet.has(s), forward };
  return { router, forward, heldSet };
}

let store: SqliteDocStore;
let catalog: SimpleIndexCatalog;
beforeEach(async () => {
  store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  catalog = shardedCatalog();
});

function makeExec(writeRouter?: WriteRouter): InlineUdfExecutor {
  const transactor = new ShardedTransactor(store);
  return new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog, writeRouter });
}

describe("executor per-shard write routing", () => {
  it("(a) forwards a mutation whose resolved shard is not owned — with the resolved shardId + JSON args", async () => {
    const { router, forward } = fakeRouter([], { value: "forwarded-id", commitTs: 77 });
    const exec = makeExec(router);

    const r = await exec.run<string>(sendSharded, { channelId: "chan-1", body: "hi" }, {
      numShards: N,
      path: "messages:send",
      identity: "user-1",
    });

    // chan-1 routes to s1; s1 not owned → forwarded, response adapted to a UdfResult.
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(
      "mutation",
      "messages:send",
      { channelId: "chan-1", body: "hi" },
      "user-1",
      "s1",
    );
    expect(r.value).toBe("forwarded-id");
    expect(r.committed).toBe(true);
    expect(r.commitTs).toBe(77n);
    expect(r.readRanges).toEqual([]);
    expect(r.oplog).toBeNull();
    // Nothing committed locally.
    const local = await exec.run<unknown[]>(listByChannel, { channelId: "chan-1" }, { numShards: N, path: "list" });
    expect(local.value).toEqual([]);
  });

  it("(b) runs locally (never forwards) when the resolved shard IS owned", async () => {
    const { router, forward } = fakeRouter(["s1"]);
    const exec = makeExec(router);

    const r = await exec.run<string>(sendSharded, { channelId: "chan-1", body: "local" }, {
      numShards: N,
      path: "messages:send",
    });

    expect(forward).not.toHaveBeenCalled();
    expect(typeof r.value).toBe("string");
    expect(r.committed).toBe(true);
    expect(r.oplog).not.toBeNull();
    const local = await exec.run<Array<{ body: string }>>(listByChannel, { channelId: "chan-1" }, { numShards: N, path: "list" });
    expect(local.value.map((d) => d.body)).toEqual(["local"]);
  });

  it("(c) localOnly:true runs locally even when the shard is NOT owned", async () => {
    const { router, forward } = fakeRouter([]); // owns nothing
    const exec = makeExec(router);

    const r = await exec.run<string>(sendSharded, { channelId: "chan-1", body: "seed" }, {
      numShards: N,
      path: "_boot:seed",
      localOnly: true,
    });

    expect(forward).not.toHaveBeenCalled();
    expect(r.committed).toBe(true);
    const local = await exec.run<Array<{ body: string }>>(listByChannel, { channelId: "chan-1" }, { numShards: N, path: "list" });
    expect(local.value.map((d) => d.body)).toEqual(["seed"]);
  });

  it("(d) no router configured → runs locally (byte-identical), forward never consulted", async () => {
    const exec = makeExec(undefined);
    const r = await exec.run<string>(sendSharded, { channelId: "chan-1", body: "plain" }, { numShards: N, path: "s" });
    expect(r.committed).toBe(true);
    expect(r.oplog).not.toBeNull();
  });

  it("(d') a query is NEVER routed, even when nothing is owned", async () => {
    const { router, forward } = fakeRouter([]);
    // Seed a row via a localOnly write so the query has something to read.
    const seedExec = makeExec(router);
    await seedExec.run(sendSharded, { channelId: "chan-1", body: "x" }, { numShards: N, path: "seed", localOnly: true });

    const r = await seedExec.run<unknown[]>(listByChannel, { channelId: "chan-1" }, { numShards: N, path: "list" });
    expect(forward).not.toHaveBeenCalled();
    expect(r.value.length).toBe(1);
  });

  it("(e) an action's inner ctx.runMutation forwards per-shard (through the `invoke` seam)", async () => {
    const { router, forward } = fakeRouter([], { value: "inner-forwarded" });
    // `invoke` is the trusted re-entrancy the runtime wires; here it just re-enters THIS executor,
    // so an inner mutation hits the same per-shard router check.
    let execRef!: InlineUdfExecutor;
    const registry: Record<string, RegisteredFunction> = { "messages:send": sendSharded };
    const invoke = async (path: string, args: JSONValue): Promise<UdfResult> =>
      execRef.run(registry[path]!, args, { numShards: N, path });
    const transactor = new ShardedTransactor(store);
    const exec = new InlineUdfExecutor({ transactor, queryRuntime: new QueryRuntime(store), catalog, writeRouter: router, invoke });
    execRef = exec;

    const driverAction: RegisteredFunction = {
      type: "action",
      handler: async (ctx: { runMutation: (p: string, a: unknown) => Promise<unknown> }) =>
        ctx.runMutation("messages:send", { channelId: "chan-1", body: "from-action" }),
    } as unknown as RegisteredFunction;

    const r = await exec.run(driverAction, {}, { numShards: N, path: "jobs:tick" });
    expect(r.value).toBe("inner-forwarded");
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(
      "mutation",
      "messages:send",
      { channelId: "chan-1", body: "from-action" },
      null,
      "s1",
    );
  });

  it("(f) a privileged run with options.shardId on a non-owned shard forwards", async () => {
    // First create a doc on s2 locally (owns s2 for the seed only).
    const seed = makeExec({ isLocalWriter: () => true, forward: vi.fn() });
    const created = await seed.run<string>(sendSharded, { channelId: "chan-5", body: "a" }, { numShards: N, path: "seed" }); // s2

    // Now a router owning ONLY default: a privileged replace routed to s2 must forward.
    const { router, forward } = fakeRouter(["default"], { value: null });
    const exec = makeExec(router);
    const r = await exec.run(replacePriv, { id: created.value, channelId: "chan-5", body: "b" }, {
      numShards: N,
      path: "_system:patchDocument",
      privileged: true,
      shardId: "s2",
    });
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(
      "mutation",
      "_system:patchDocument",
      { id: created.value, channelId: "chan-5", body: "b" },
      null,
      "s2",
    );
    expect(r.oplog).toBeNull();
  });
});
