/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet B3, Task 2 — HYBRID nodes (multi-writer writer-ish nodes that keep a local replica and serve
 * queries from it while committing to the primary). Driven through the REAL `startFleetNode` over a
 * real `EmbeddedRuntime` + `PostgresDocStore` (PGlite primary) + `SqliteDocStore` replica, wired the
 * way `prepareFleetNode`'s multi-writer branch does (store = primary, queryStore = the switchable
 * replica, beforeNotify = the forwarder's replica-catch-up wait). `prepareFleetNode` itself needs a
 * live `NodePgClient` connection string so it's proven end to end only in the `stackbase serve
 * --fleet` E2E (Task 5) — here we build the runtime the way it does and exercise `startFleetNode`'s
 * hybrid wiring directly (the same pattern `node-lifecycle.test.ts` uses).
 *
 * Invariants proven:
 *  - queries serve from the REPLICA (snapshot ≤ wm — a write on the primary is invisible to a hybrid
 *    query until the tailer applies it), mutations commit to the PRIMARY (immediately durable there);
 *  - own-commit RYOW: a local commit's subscription re-run is gated on the replica applying it
 *    (beforeNotify), so it never fires a stale intermediate;
 *  - promotion (sync → hybrid) ADDS the writer half WITHOUT stopping the tailer or swapping the store
 *    (queries keep serving from the replica; commits landing across the promotion ARE invalidated);
 *  - the superseded B2b invalidateOnly listener is NEVER started on a hybrid (exactly ONE
 *    ReplicaTailer per node lifecycle — the real one);
 *  - single-writer topology is byte-identical (a single-writer writer boot stands up NO replica
 *    tailer at all).
 */
import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import type { NodePgClient } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { newDocumentId, encodeStorageIndexId, shardIdList, shardIdForKeyValue, DEFAULT_SHARD, type ShardId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import { SimpleIndexCatalog, query, mutation, type RegisteredFunction } from "@stackbase/executor";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { PgliteClient } from "./pglite-client";
import { LeaseManager } from "../src/lease";
import { WriteForwarder, type ReplicaWaiter } from "../src/forwarder";
import { openSyncReplica, startFleetNode, relinquish, REPLICA_DB_FILENAME } from "../src/node";
import { ReplicaTailer } from "../src/replica-tailer";
import { SwitchableDocStore } from "../src/switchable-store";

// `@stackbase/query-engine`/`@stackbase/sync` are transitive-only deps of `@stackbase/fleet` (not
// declared), so their types aren't nameable here — the index spec is a plain literal (checked against
// executor's own param type) and server messages are read structurally (mirrors writer-invalidation.test.ts).
const MESSAGES = 30201;
const INDEX_ID = encodeStorageIndexId(MESSAGES, "by_conversation");
const byConversation = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: INDEX_ID,
};

const modules: Record<string, RegisteredFunction> = {
  "messages:send": mutation<{ conversationId: string; body: string }, string>({
    handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
  }),
  "messages:list": query<{ conversationId: string }, Array<{ body: string }>>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect() as never,
  }),
};

type ServerMsg = { type: string; modifications?: Array<{ type: string; queryId?: number; value?: unknown }> };

/** The latest `QueryUpdated` value the subscription received for `queryId`, or undefined if none. */
function latestQueryValue(msgs: ServerMsg[], queryId: number): unknown {
  let value: unknown;
  for (const m of msgs) {
    if (m.type !== "Transition") continue;
    for (const mod of m.modifications ?? []) {
      if (mod.type === "QueryUpdated" && mod.queryId === queryId) value = mod.value;
    }
  }
  return value;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 6000, stepMs = 15): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function freshCatalog(): SimpleIndexCatalog {
  return new SimpleIndexCatalog().addIndex(byConversation);
}

/** A raw primary write at an explicit ts (simulates a FOREIGN commit landing directly on the shared
 *  primary — a co-writer), plus the `by_conversation` index entry, matching the runtime's insert shape. */
async function rawPrimaryWrite(primary: PostgresDocStore, conversationId: string, body: string, ts: bigint): Promise<void> {
  const doc = newDocumentId(MESSAGES);
  await primary.write(
    [{ ts, id: doc, prev_ts: null, value: { id: doc, value: { conversationId, body } } }],
    [{ ts, update: { indexId: INDEX_ID, key: encodeIndexKey([conversationId]), value: { type: "NonClustered", docId: doc } } }],
    "Error",
  );
}

describe("Fleet B3 Task 2 — hybrid nodes", () => {
  let tmp: string;
  let startSpy: MockInstance<(seedWm?: bigint) => Promise<void>>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fleet-hybrid-"));
    process.env.STACKBASE_FLEET_MULTI_WRITER = "1";
    // Count how many ReplicaTailer instances actually START across a node's lifecycle — the direct
    // "the superseded invalidateOnly listener is never started" spy (a listener would be a 2nd start()).
    startSpy = vi.spyOn(ReplicaTailer.prototype, "start");
  });
  afterEach(() => {
    startSpy.mockRestore();
    delete process.env.STACKBASE_FLEET_MULTI_WRITER;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("hybrid WRITER boot: queries serve from the replica (snapshot ≤ wm), mutations commit to the primary; exactly one tailer (no invalidateOnly listener)", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://hybrid-writer:1", retryMs: 3_600_000 });
    await lease.setup();
    await lease.heartbeatPresence();
    expect(await lease.tryAcquire(DEFAULT_SHARD, 0)).toBeTruthy(); // wins → writer boot
    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://hybrid-writer:1" });
    forwarder.promote();

    const replicaPath = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(replicaPath);
    const runtime = await createEmbeddedRuntime({
      store: primary,
      queryStore: switchable, // hybrid: queries read the replica; mutations commit to the primary
      catalog: freshCatalog(),
      modules,
      numShards: 1,
      beforeNotify: (ts) => forwarder.waitForReplica(ts),
    });
    const onExit = vi.fn();
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      replica,
      switchable,
      replicaPath,
      numShards: 1,
      onExit,
    });
    try {
      expect(handles.role()).toBe("writer");

      // A local mutation commits to the PRIMARY immediately (durable there) ...
      const r = await runtime.run<string>("messages:send", { conversationId: "c1", body: "hello" });
      expect(r.commitTs).toBeGreaterThan(0n);
      expect(await primary.maxTimestamp()).toBeGreaterThanOrEqual(r.commitTs); // on the primary NOW

      // ... but a hybrid QUERY reads the REPLICA, which hasn't applied it yet — snapshot ≤ wm, so the
      // write is invisible until the tailer applies it (the poll-driven catch-up).
      const immediate = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
      expect(immediate.value).toEqual([]); // not on the replica yet

      // The tailer applies (wm rises), the query oracle rises with it — now the query sees the write.
      await waitUntil(async () => {
        const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
        return list.value.length === 1;
      });
      const seen = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
      expect(seen.value.map((d) => d.body)).toEqual(["hello"]);

      expect(startSpy).toHaveBeenCalledTimes(1); // ONE tailer — the real one; no invalidateOnly listener
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await handles.stop();
    }
  }, 30_000);

  // Trigger-wake gap fix (whole-branch review, Fix 1): `invalidationSink` (node.ts) used to call
  // ONLY `runtime.handler.notifyWrites` on a foreign co-writer's commit — that re-runs live QUERY
  // subscriptions but never touches `commitSubs`, the driver `onCommit` fan-out (which normally
  // fires only from a node's own LOCAL `adapter.subscribe`, in `packages/runtime-embedded`). A
  // driver here (e.g. `@stackbase/triggers`) would sleep on its wall-clock beat instead of waking
  // immediately on a foreign commit. This proves the wiring: driving a REAL foreign commit through
  // the REAL `startFleetNode` hybrid tailer reaches `runtime.notifyExternalCommit` — spied on the
  // real runtime instance, not a hand-rolled stand-in for `invalidationSink`.
  it("hybrid WRITER boot: a FOREIGN commit reaches runtime.notifyExternalCommit (the driver onCommit wake), not just notifyWrites", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://hybrid-writer-ext:1", retryMs: 3_600_000 });
    await lease.setup();
    await lease.heartbeatPresence();
    expect(await lease.tryAcquire(DEFAULT_SHARD, 0)).toBeTruthy();
    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://hybrid-writer-ext:1" });
    forwarder.promote();

    const replicaPath = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(replicaPath);
    const runtime = await createEmbeddedRuntime({
      store: primary,
      queryStore: switchable,
      catalog: freshCatalog(),
      modules,
      numShards: 1,
      beforeNotify: (ts) => forwarder.waitForReplica(ts),
    });
    const notifyExternalSpy = vi.spyOn(runtime, "notifyExternalCommit");
    const notifyWritesSpy = vi.spyOn(runtime.handler, "notifyWrites");
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      replica,
      switchable,
      replicaPath,
      numShards: 1,
    });
    try {
      expect(notifyExternalSpy).not.toHaveBeenCalled(); // nothing foreign has landed yet

      // A FOREIGN commit lands directly on the primary (simulating a co-writer) — never through
      // THIS node's `runtime.run`/`adapter.subscribe`, so the ONLY way it can wake a local driver
      // is via `invalidationSink`'s `notifyExternalCommit` call.
      const T = (await primary.maxTimestamp()) + 1n;
      await rawPrimaryWrite(primary, "cExt", "foreign", T);
      await client.query(`UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1) WHERE frontier_ts < $1`, [T]);

      await waitUntil(() => notifyExternalSpy.mock.calls.length > 0);

      // Same commitTs/tables/ranges shape `notifyWrites` was called with for this batch — the two
      // calls are meant to carry the SAME derived invalidation, just to two different fan-outs.
      expect(notifyWritesSpy).toHaveBeenCalled();
      const notifyWritesArg = notifyWritesSpy.mock.calls[notifyWritesSpy.mock.calls.length - 1]![0];
      const notifyExternalArg = notifyExternalSpy.mock.calls[notifyExternalSpy.mock.calls.length - 1]![0];
      expect(notifyExternalArg.commitTs).toBe(notifyWritesArg.commitTs);
      expect(notifyExternalArg.tables).toEqual(notifyWritesArg.tables);
    } finally {
      await handles.stop();
    }
  }, 30_000);

  it("hybrid WRITER boot: own-commit RYOW — a local commit's subscription re-run is gated until the replica applies it (never a stale intermediate)", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://hybrid-writer-2:1", retryMs: 3_600_000 });
    await lease.setup();
    await lease.heartbeatPresence();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://hybrid-writer-2:1" });
    forwarder.promote();

    const replicaPath = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(replicaPath);
    const runtime = await createEmbeddedRuntime({
      store: primary,
      queryStore: switchable,
      catalog: freshCatalog(),
      modules,
      numShards: 1,
      beforeNotify: (ts) => forwarder.waitForReplica(ts),
    });
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      replica,
      switchable,
      replicaPath,
      numShards: 1,
    });
    try {
      const conn = runtime.connect("s1");
      const msgs: ServerMsg[] = [];
      conn.onMessage((m) => msgs.push(m as ServerMsg));
      await conn.send({
        type: "ModifyQuerySet",
        add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }],
        remove: [],
      });
      await waitUntil(() => Array.isArray(latestQueryValue(msgs, 1)));
      expect(latestQueryValue(msgs, 1)).toEqual([]); // initial: empty

      // Commit a mutation. Its fan-out drain awaits beforeNotify (= waitForReplica) before firing the
      // subscription re-run — so the transition can ONLY appear once the replica has applied the row.
      await runtime.run("messages:send", { conversationId: "c1", body: "gated" });

      await waitUntil(() => (latestQueryValue(msgs, 1) as unknown[] | undefined)?.length === 1);
      expect((latestQueryValue(msgs, 1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["gated"]);

      // The gate's guarantee: NO post-initial transition ever showed a stale empty list (which is what
      // an ungated re-run reading the not-yet-applied replica would have produced). Collect every value
      // the subscription was pushed after its initial empty; each must be the non-stale [gated].
      const postInitial: unknown[][] = [];
      let sawInitialEmpty = false;
      for (const m of msgs) {
        if (m.type !== "Transition") continue;
        for (const mod of m.modifications ?? []) {
          if (mod.type !== "QueryUpdated" || mod.queryId !== 1) continue;
          const v = mod.value as unknown[];
          if (!sawInitialEmpty && v.length === 0) sawInitialEmpty = true;
          else postInitial.push(v);
        }
      }
      expect(sawInitialEmpty).toBe(true);
      for (const v of postInitial) expect(v.length).toBe(1); // no stale empty re-run slipped through
    } finally {
      await handles.stop();
    }
  }, 30_000);

  it("hybrid SYNC boot → promotion ADDS the writer half WITHOUT stopping the tailer or swapping the store; commits across the promotion ARE invalidated", async () => {
    const client = new PgliteClient();
    // Sync-boot hybrid: the runtime WRITE store is the read-only-until-promoted primary; the replica is
    // the queryStore. A promotion just makes the primary writable (no swapTo) and keeps the tailer.
    const primary = new PostgresDocStore(client, { readOnly: true });
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://hybrid-sync:1", retryMs: 50 });
    await lease.setup();
    await lease.heartbeatPresence();
    // NOTE: no tryAcquire — this node boots SYNC (forwarder.isLocalWriter() is false). PGlite's
    // tryAcquireWriterLock always succeeds, so the acquireLoop (retryMs=50) promotes it shortly.
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://hybrid-sync:1" });
    expect(forwarder.isLocalWriter()).toBe(false);

    const replicaPath = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(replicaPath);
    const runtime = await createEmbeddedRuntime({
      store: primary,
      queryStore: switchable,
      catalog: freshCatalog(),
      modules,
      numShards: 1,
      writeRouter: forwarder,
      deferDrivers: true,
      beforeNotify: (ts) => forwarder.waitForReplica(ts),
    });
    const onExit = vi.fn();
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      replica,
      switchable,
      replicaPath,
      numShards: 1,
      onExit,
    });
    try {
      // Open a subscription BEFORE the promotion completes (initially empty).
      const conn = runtime.connect("s1");
      const msgs: ServerMsg[] = [];
      conn.onMessage((m) => msgs.push(m as ServerMsg));
      await conn.send({
        type: "ModifyQuerySet",
        add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "cF" } }],
        remove: [],
      });

      // The acquireLoop promotes this node sync → hybrid-writer.
      await waitUntil(() => handles.role() === "writer");

      // HYBRID promotion invariant: the runtime store was NOT swapped to the primary — the switchable
      // still points at the replica, so queries keep serving from the replica (the read offload lives on).
      expect(switchable.current()).toBe(replica);

      // A FOREIGN commit lands directly on the primary after promotion, and the frontier is revealed —
      // the STILL-RUNNING tailer must apply it and invalidate the live subscription (the B2b-F1 scenario,
      // now trivially gap-free because the tailer never stopped across the promotion).
      const T = (await primary.maxTimestamp()) + 1n;
      await rawPrimaryWrite(primary, "cF", "post-promo", T);
      await client.query(`UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1) WHERE frontier_ts < $1`, [T]);

      await waitUntil(() => (latestQueryValue(msgs, 1) as unknown[] | undefined)?.length === 1);
      expect((latestQueryValue(msgs, 1) as Array<{ body: string }>).map((d) => d.body)).toEqual(["post-promo"]);

      // The tailer applied to the replica (proving it's alive post-promotion), and its post-apply sink
      // advanced the query oracle — a fresh hybrid query now sees the foreign row too.
      const afterList = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "cF" });
      expect(afterList.value.map((d) => d.body)).toEqual(["post-promo"]);

      // The tailer STARTED exactly once (at sync boot) — promotion did NOT create a second tailer or an
      // invalidateOnly listener (the superseded B2b machinery is gone from the hybrid path).
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await handles.stop();
    }
  });

  it("single-writer WRITER boot (multi-writer OFF) is byte-identical: NO replica tailer is stood up", async () => {
    delete process.env.STACKBASE_FLEET_MULTI_WRITER; // single-writer topology
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://single-writer:1", retryMs: 3_600_000 });
    await lease.setup();
    await lease.heartbeatPresence();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://single-writer:1" });
    forwarder.promote();
    const runtime = await createEmbeddedRuntime({ store: primary, catalog: freshCatalog(), modules, numShards: 1 });
    const onExit = vi.fn();
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      numShards: 1,
      onExit,
    });
    try {
      expect(handles.role()).toBe("writer");
      // A single-writer writer reads the PRIMARY directly — no replica, no tailer, no query-path split.
      expect(startSpy).not.toHaveBeenCalled();
      const r = await runtime.run<string>("messages:send", { conversationId: "c1", body: "direct" });
      const list = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
      expect(list.value.map((d) => d.body)).toEqual(["direct"]); // reads the primary immediately (no lag)
      expect(r.commitTs).toBeGreaterThan(0n);
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await handles.stop();
    }
  });
});

describe("Fleet B3 hazard — re-acquired shard re-floors the WRITE oracle (no stale RMW snapshot)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fleet-reacq-"));
    process.env.STACKBASE_FLEET_MULTI_WRITER = "1"; // hybrid regime — observeTimestamp feeds the QUERY oracle
  });
  afterEach(() => {
    delete process.env.STACKBASE_FLEET_MULTI_WRITER;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("a shard RELEASED then RE-ACQUIRED (an interim owner committed meanwhile) re-floors the write oracle: an RMW mutation on it sees the interim state, not a stale snapshot", async () => {
    const N = 4;
    const SHARDS = shardIdList(N);
    const targetShard: ShardId = "s3";
    // A conversationId that shards to `targetShard`, so this is a NON-default re-acquire (routed via
    // the mutations' `shardBy` and the runtime's own `shardIdForKeyValue`, N=4 — identical resolution).
    let convo = "";
    for (let i = 0; ; i++) {
      if (shardIdForKeyValue(`c${i}`, N) === targetShard) {
        convo = `c${i}`;
        break;
      }
    }

    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    // Short TTL → the balancer beats quickly (beatMs = fleetAcquireRetryMs(ttl) ≈ 200ms at 1500). A
    // single in-process PGlite node never contends, so every held lease renews well within the TTL.
    const lease = new LeaseManager(client, { advertiseUrl: "http://reacq:1", ttlMs: 1500, retryMs: 3_600_000 });
    await lease.setup();
    await lease.heartbeatPresence();
    // Writer boot: win the default-shard election, make the store writable, promote the forwarder.
    expect(await lease.tryAcquire(DEFAULT_SHARD, 0, true)).toBeTruthy();
    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://reacq:1" });
    forwarder.promote();

    // `messages` sharded by `conversationId`; both mutations DECLARE shardBy so they route by it.
    const catalog = new SimpleIndexCatalog()
      .addTable("messages", MESSAGES, undefined, false, "conversationId")
      .addIndex(byConversation);
    const shardedModules: Record<string, RegisteredFunction> = {
      "messages:send": mutation<{ conversationId: string; body: string }, string>({
        shardBy: "conversationId",
        handler: (ctx, { conversationId, body }) => ctx.db.insert("messages", { conversationId, body }),
      }),
      // A read-modify-write mutation: READ the conversation's rows at the WRITE oracle's snapshot and
      // return how many the handler saw — its view of state. Routed to `targetShard` by shardBy.
      "messages:rmw": mutation<{ conversationId: string }, number>({
        shardBy: "conversationId",
        handler: async (ctx, { conversationId }) =>
          (await ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect()).length,
      }),
    };

    const replicaPath = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(replicaPath);
    const runtime = await createEmbeddedRuntime({
      store: primary,
      queryStore: switchable, // hybrid: observeTimestamp feeds the QUERY oracle, NOT the write oracle
      catalog,
      modules: shardedModules,
      numShards: N,
      writeRouter: forwarder,
      beforeNotify: (ts) => forwarder.waitForReplica(ts),
    });
    const onExit = vi.fn();
    const handles = await startFleetNode({
      client: client as unknown as NodePgClient,
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      replica,
      switchable,
      replicaPath,
      numShards: N,
      onExit,
    });
    try {
      // 1. Commit an ORIGINAL row on the target shard through the runtime — this creates the shard's
      //    ShardWriter and advances ITS oracle to this commit.
      const orig = await runtime.run<string>("messages:send", { conversationId: convo, body: "original" });
      expect(orig.commitTs).toBeGreaterThan(0n);
      expect(handles.isLocalWriter(targetShard)).toBe(true);

      // 2. RELEASE the target shard WITHOUT tearing down its ShardWriter — the exact balancer/relinquish
      //    reduction: drop the fleet epoch (+ slot lock), leave the transactor's ShardWriter (and its
      //    now-FROZEN oracle) in the Map. `writer_url` stays ours (not orphaned yet), so the balancer
      //    won't re-acquire until we orphan it below — a deterministic window for the interim commit.
      relinquish({ lease, client: client as unknown as NodePgClient, shards: SHARDS }, targetShard, "test release");
      expect(lease.currentEpoch(targetShard)).toBeNull();

      // 3. INTERIM OWNER commits directly on the shared primary (a NEW row for the same conversation +
      //    its index entry) at a ts ABOVE our last commit, and advances the shard's fenced frontier to
      //    it — exactly the row state a co-writer's commit guard would leave.
      const interimTs = (await primary.maxTimestamp()) + 1n;
      await rawPrimaryWrite(primary, convo, "interim", interimTs);
      await client.query(`UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, $1) WHERE shard_id = $2`, [interimTs, targetShard]);

      // 4. Orphan the shard row so the RUNNING balancer RE-ACQUIRES it on its next beat via the REAL
      //    `tryAcquireShard` — the production path that now floors the write oracle to the row's frontier.
      //    Driving the real balancer (not a direct call) is what makes this guard the fix WIRING.
      await client.query(`UPDATE shard_leases SET writer_url = NULL WHERE shard_id = $1`, [targetShard]);
      await waitUntil(() => lease.currentEpoch(targetShard) !== null); // balancer re-acquired it

      // 5. The RMW reads at the re-acquired shard's write oracle snapshot. WITH the fix that oracle was
      //    floored to the frontier (≥ interimTs), so the handler sees BOTH rows. WITHOUT it, the shard's
      //    stale ShardWriter oracle sits at our own last commit and the handler sees only the original —
      //    the silent lost update the hazard describes.
      const rmw = await runtime.run<number>("messages:rmw", { conversationId: convo });
      expect(rmw.value).toBe(2);
      expect(onExit).not.toHaveBeenCalled();
    } finally {
      await handles.stop();
    }
  });
});

describe("Fleet B3 Task 2 — forwarder.waitForReplica (own-commit + forwarded RYOW gate)", () => {
  it("is a no-op before a tailer is attached, and delegates to the tailer's waitFor after attachTailer", async () => {
    const lease = { currentEpoch: () => null } as unknown as LeaseManager;
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://x:1" });

    // No tailer attached (a single-writer node, or before startFleetNode wires it): a no-op that
    // resolves immediately even for a high ts — reads are correct off the primary regardless.
    await expect(forwarder.waitForReplica(999n)).resolves.toBeUndefined();

    // After attachTailer, the gate delegates to the tailer's waitFor (the SAME primitive forwarded-write
    // RYOW uses). A stub records the ts it was asked to wait for.
    const waited: bigint[] = [];
    const stub: ReplicaWaiter = {
      waitFor: async (ts) => {
        waited.push(ts);
        return "reached";
      },
      release: () => {},
    };
    forwarder.attachTailer(stub);
    await forwarder.waitForReplica(42n);
    expect(waited).toEqual([42n]);

    // Nothing committed (0n) → no wait (the run was read-only / a no-op).
    await forwarder.waitForReplica(0n);
    expect(waited).toEqual([42n]);
  });
});

// A hybrid's own replica machinery reuses the sync-node construction verbatim — the SwitchableDocStore
// over a real on-disk SqliteDocStore. Sanity that the harness above builds what production does.
describe("Fleet B3 Task 2 — hybrid replica read path construction", () => {
  it("openSyncReplica yields a SwitchableDocStore over the file-backed replica (the hybrid queryStore)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "fleet-hybrid-ctor-"));
    try {
      const { replica, switchable } = await openSyncReplica(join(tmp, REPLICA_DB_FILENAME));
      try {
        expect(switchable).toBeInstanceOf(SwitchableDocStore);
        expect(switchable.current()).toBe(replica);
        expect(replica).toBeInstanceOf(SqliteDocStore);
        void NodeSqliteAdapter; // (imported for the adapter type used elsewhere in the suite)
      } finally {
        await replica.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
