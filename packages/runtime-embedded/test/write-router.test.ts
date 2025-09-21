import { describe, it, expect, vi } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { encodeStorageIndexId, newDocumentId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
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
  it("routes a mutation through forward() when not the local writer", async () => {
    const forward = vi.fn(async () => 42);
    let localWriter = false;
    const router: WriteRouter = { isLocalWriter: () => localWriter, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const result = await runtime.run("messages:send", { conversationId: "c1", body: "hi" });
    expect(result.value).toBe(42);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith("mutation", "messages:send", { conversationId: "c1", body: "hi" }, null);
  });

  it("never routes a query, even when not the local writer", async () => {
    const forward = vi.fn(async () => 42);
    const router: WriteRouter = { isLocalWriter: () => false, forward };
    const { runtime } = await makeRuntime({ writeRouter: router });

    const list = await runtime.run("messages:list", { conversationId: "c1" });
    expect(list.value).toEqual([]);
    expect(forward).not.toHaveBeenCalled();
  });

  it("flipping isLocalWriter back to true makes the mutation execute locally again", async () => {
    const forward = vi.fn(async () => 42);
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

  it("routes an action through forward() with kind 'action' when not the local writer", async () => {
    const forward = vi.fn(async () => "action-result");
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
    expect(forward).toHaveBeenCalledWith("action", "mod:doThing", { x: 1 }, null);
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
