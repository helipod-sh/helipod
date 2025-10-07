import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId, newDocumentId, shardIdForKeyValue } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import type { Driver, DriverContext } from "@stackbase/component";
import type { IndexSpec } from "@stackbase/query-engine";
import { createEmbeddedRuntime, type WriteRouter } from "../src/index";

const MESSAGES = 10001;
const byConversation: IndexSpec = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: encodeStorageIndexId(MESSAGES, "by_conversation"),
};

const modules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  "messages:list": query<{ conversationId: string }, unknown[]>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect(),
  }),
};

async function makeRuntime(extra?: { writeRouter?: WriteRouter; deferDrivers?: boolean; drivers?: any[] }) {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  const catalog = new SimpleIndexCatalog().addIndex(byConversation);
  return { runtime: await createEmbeddedRuntime({ store, catalog, modules, ...extra }), store };
}

describe("write-router seam", () => {
  it("routes a mutation through forward() when not the local writer (per-shard chokepoint)", async () => {
    // `messages:send` has no shardBy and this runtime is 1-shard, so its resolved shard is "default".
    const forward = vi.fn(async () => ({ value: 42 }));
    let localWriter = false;
    const router: WriteRouter = { isLocalWriter: () => localWriter, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const result = await runtime.run("messages:send", { conversationId: "c1", body: "hi" });
    expect(result.value).toBe(42);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("mutation", "messages:send", { conversationId: "c1", body: "hi" }, null, "default");
  });

  it("never routes a query, even when not the local writer", async () => {
    const forward = vi.fn(async () => ({ value: 42 }));
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const list = await runtime.run("messages:list", { conversationId: "c1" });
    expect(list.value).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it("flipping isLocalWriter back to true makes the mutation execute locally again", async () => {
    const forward = vi.fn(async () => ({ value: 42 }));
    let localWriter = false;
    const router: WriteRouter = { isLocalWriter: () => localWriter, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    await runtime.run("messages:send", { conversationId: "c1", body: "routed" });
    expect(forward).toHaveBeenCalledTimes(1);

    localWriter = true;
    const id = (await runtime.run<string>("messages:send", { conversationId: "c1", body: "local" })).value;
    expect(typeof id).toBe("string");
    expect(forward).toHaveBeenCalledTimes(1); // still just the one call from before — this one ran locally

    const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(list.value.map((d) => d.body)).toEqual(["local"]);
  });

  it("routes an action through forward() with kind 'action' (default shard) when not the local writer", async () => {
    const forward = vi.fn(async () => ({ value: "action-result" }));
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const actionModules: Record<string, RegisteredFunction> = {
      ...modules,
      "mod:doThing": {
        type: "action",
        handler: async () => "should-not-run-locally",
      } as unknown as RegisteredFunction,
    };
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog().addIndex(byConversation);
    const runtime = await createEmbeddedRuntime({ store, catalog, modules: actionModules, writeRouter: router });

    const result = await runtime.runAction("mod:doThing", { x: 1 });
    expect(result.value).toBe("action-result");
    expect(forward).toHaveBeenCalledWith("action", "mod:doThing", { x: 1 }, null, "default");
  });
});

describe("driver-path per-shard routing (the B2b driver hazard fix)", () => {
  // A sharded mutation scheduled by a driver used to bypass the runtime-level WriteRouter check
  // entirely (that check ran before shard resolution, and drivers call `runFunction` directly),
  // so it would execute locally on a non-held shard, fence, and kill the node. With routing at the
  // executor chokepoint, the driver's `runFunction` forwards it to the shard's owner instead.
  const N = 8;
  const shardedModules: Record<string, RegisteredFunction> = {
    "messages:send": mutation<{ conversationId: string; body: string }, string>({
      shardBy: "conversationId",
      handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
    }),
  };

  it("a driver runFunction on a non-held sharded mutation forwards to the shard's owner", async () => {
    const forward = vi.fn(async () => ({ value: "forwarded-by-driver" }));
    const router: WriteRouter = { isLocalWriter: () => false, forward }; // owns nothing
    let captured!: DriverContext;
    const driver: Driver = { name: "probe", start: async (ctx) => void (captured = ctx) };

    const store = new SqliteDocStore(new NodeSqliteAdapter());
    const catalog = new SimpleIndexCatalog();
    catalog.addTable("messages", MESSAGES, undefined, false, "conversationId");
    catalog.addIndex(byConversation);
    await createEmbeddedRuntime({ store, catalog, modules: shardedModules, writeRouter: router, drivers: [driver], numShards: N });

    const result = await captured.runFunction("messages:send", { conversationId: "c1", body: "tick" });
    expect(result).toBe("forwarded-by-driver");
    const expectedShard = shardIdForKeyValue("c1", N);
    expect(forward).toHaveBeenCalledWith("mutation", "messages:send", { conversationId: "c1", body: "tick" }, null, expectedShard);
  });
});

describe("deferred driver start", () => {
  it("skips starting drivers at create() when deferDrivers is true; startDrivers() starts them exactly once", async () => {
    let started = 0;
    const stubDriver = {
      name: "stub",
      start: vi.fn(async () => {
        started += 1;
      }),
    };
    const { runtime } = await makeRuntime({ deferDrivers: true, drivers: [stubDriver] });

    expect(stubDriver.start).not.toHaveBeenCalled();
    expect(started).toBe(0);

    await runtime.startDrivers();
    expect(stubDriver.start).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);

    // Idempotent: a second call is a no-op.
    await runtime.startDrivers();
    expect(stubDriver.start).toHaveBeenCalledTimes(1);
    expect(started).toBe(1);
  });
});

describe("observeTimestamp", () => {
  it("a local commit lands strictly above all existing log history (incl. replica-applied rows); observeTimestamp still advances the snapshot clock", async () => {
    // SUPERSESSION NOTE: ts allocation moved into the store (`DocStore.commitWrite` computes the
    // commit ts inside its own atomicity domain — SQLite MAX(ts)+1, Postgres
    // GREATEST(nextval, MAX(ts)+1)); `observeTimestamp` remains for snapshot bookkeeping; the
    // allocate-above-history guarantee this test previously pinned to the in-memory oracle bump
    // is now STRUCTURAL — see the fenced-frontier-b1 spec, D1. This test asserts the purpose
    // (a commit always lands above everything already in the log, however it got there), not the
    // old mechanism (oracle bump → allocation jumps).
    //
    // Why the API stays: `observeTimestamp` advances the oracle's `lastCommitted` clock
    // (packages/docstore/src/timestamp-oracle.ts:34-37), which `runInTransaction` uses as the
    // snapshot ts for every new transaction — a promoted/tailing fleet node calls it so local
    // reads immediately see all replica-applied history. That snapshot role is load-bearing and
    // untouched; only the allocation role moved into the store.
    const { runtime, store } = await makeRuntime();

    // Seed a high-ts row via the verbatim write() path — exactly what a replica tailer applying
    // a foreign primary's log would have done (caller-supplied timestamps, no allocation).
    const foreignId = newDocumentId(MESSAGES);
    await store.write(
      [
        {
          ts: 100n,
          id: foreignId,
          prev_ts: null,
          value: { id: foreignId, value: { conversationId: "c0", body: "replica-applied" } },
        },
      ],
      [],
      "Error",
    );

    // Promotion still calls this (ee/packages/fleet/src/node.ts promoteFleetNode step 1) — it
    // must not throw, and it advances the snapshot clock past the applied history.
    runtime.observeTimestamp(100n);

    await runtime.run("messages:send", { conversationId: "c1", body: "after-observe" });

    // The purpose: the local commit's landed ts is STRICTLY above the seeded foreign row's ts.
    const max = await store.maxTimestamp();
    expect(max).toBeGreaterThan(100n);
  });
});

describe("forwarded mutation commitTs threading (Shards B2b, Task 2 — RYOW wire-through)", () => {
  it("a forwarded WS mutation's commitTs threads from the executor's forward() result, not a hardcoded 0", async () => {
    // The executor's forward branch (`InlineUdfExecutor.run`) already threads a forwarded write's
    // real commitTs onto its `UdfResult.commitTs` (T1). The WS sync path's `syncExecutor.runMutation`
    // closure used to ignore that and report a hardcoded `commitTs: 0` for any forwarded write (its
    // own `r.oplog` is always null — there's no LOCAL commit to have written one) — this pins the
    // fix: it now falls back to `r.commitTs` instead.
    const forward = vi.fn(async () => ({ value: "id-from-owner", commitTs: 777, shardId: "default" }));
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    // `EmbeddedRuntime` constructs its `SyncProtocolHandler` with `autoNotifyOnMutation: false` —
    // production reactivity is driven by the commit fan-out queue/drain instead (see runtime.ts's
    // doc comment), so `handleMutation`'s OWN `notifyWrites` call is normally skipped entirely. Flip
    // it on here, isolated to this test, purely so `syncExecutor.runMutation`'s return value (what
    // this test is pinning) becomes observable through the handler's public `notifyWrites` seam,
    // without needing a live fleet tailer.
    (runtime.handler as unknown as { options: { autoNotifyOnMutation?: boolean } }).options.autoNotifyOnMutation = true;
    const notifySpy = vi.spyOn(runtime.handler, "notifyWrites");

    const conn = runtime.connect("s1");
    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "hi" } });

    await waitFor(() => notifySpy.mock.calls.length > 0);
    expect(forward).toHaveBeenCalledTimes(1);
    const [invalidation] = notifySpy.mock.calls[0]!;
    expect(invalidation.commitTs).toBe(777); // NOT 0 — threaded from the forwarded UdfResult.commitTs
    // A forwarded write has no LOCAL oplog, so tables/ranges are still empty either way — only
    // commitTs threading is what this fix changes.
    expect(invalidation.tables).toEqual([]);
    expect(invalidation.ranges).toEqual([]);
  });

  it("a LOCAL (non-forwarded) mutation's commitTs is unaffected — still sourced from its own oplog", async () => {
    const { runtime } = await makeRuntime();
    const notifySpy = vi.spyOn(runtime.handler, "notifyWrites");
    (runtime.handler as unknown as { options: { autoNotifyOnMutation?: boolean } }).options.autoNotifyOnMutation = true;

    const conn = runtime.connect("s1");
    await conn.send({ type: "Mutation", requestId: "r1", udfPath: "messages:send", args: { conversationId: "c1", body: "hi" } });

    await waitFor(() => notifySpy.mock.calls.length > 0);
    const [invalidation] = notifySpy.mock.calls[0]!;
    expect(invalidation.commitTs).toBeGreaterThan(0); // a real local commit ts, from r.oplog.commitTs
    expect(invalidation.tables).toHaveLength(1); // a real oplog's writtenTables — not the empty [] a forward reports
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
