/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Shards B2b, Task 5 — Part (c): the WRITER INVALIDATION LISTENER (the T4 multi-writer discovery).
 *
 * A promoted/booted writer node stops (or never starts) a `ReplicaTailer`, so on its own it has NO
 * mechanism to learn about ANOTHER writer's commits: its live subscriptions would silently go stale
 * and its oracle would never observe a foreign commit's ts. B2b fixes this with a DERIVE-ONLY
 * listener — a `ReplicaTailer` in `mode:"invalidateOnly"`: same `(watermark, F]` pull + derivation as
 * the sync tailer, same wake sources, but NO replica apply (the writer reads the PRIMARY directly, so
 * the data is already there). It only needs the WAKE + invalidation ranges + `observeTimestamp(F)`.
 *
 * This proves it end to end against a real `EmbeddedRuntime` A over a real `PostgresDocStore` (PGlite):
 * a commit made DIRECTLY to the primary on a shard A does not run (simulating writer B) reaches A's
 * live loopback subscription AND advances A's oracle (a fresh read on A now sees B's row — the cross-
 * node RYOW the listener restores). Multi-writer stays OFF by default in production; T6's E2E turns it
 * on — this is the mechanism proof.
 */
import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "@helipod/docstore-postgres";
import { newDocumentId, encodeStorageIndexId, DEFAULT_SHARD } from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import { SimpleIndexCatalog, query, type RegisteredFunction } from "@helipod/executor";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { PgliteClient } from "./pglite-client";
import { LeaseManager } from "../src/lease";
import { acquireShardAsWriter, keyToPointRange, docKeyToPointRange } from "../src/node";
import { ReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";

// `@helipod/query-engine`/`@helipod/sync` are transitive-only deps of `@helipod/fleet` (not
// declared), so their types aren't nameable here under tsc — the index spec is passed as a plain
// literal to `addIndex` (checked against executor's own param type) and server messages are read
// structurally.
const MESSAGES = 20101;
const INDEX_ID = encodeStorageIndexId(MESSAGES, "by_conversation");
const byConversation = {
  table: "messages",
  tableNumber: MESSAGES,
  index: "by_conversation",
  fields: ["conversationId"],
  indexId: INDEX_ID,
};

/** Structural read-only view of the server messages the loopback pushes (avoids importing `@helipod/sync`). */
type ServerMsg = { type: string; modifications?: Array<{ type: string; queryId?: number; value?: unknown }> };

const modules: Record<string, RegisteredFunction> = {
  "messages:list": query<{ conversationId: string }, Array<{ body: string }>>({
    handler: (ctx, { conversationId }) =>
      ctx.db.query("messages", "by_conversation").eq("conversationId", conversationId).collect() as never,
  }),
};

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

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

describe("Shards B2b, Task 5(c) — writer invalidation listener (derive-only, multi-writer)", () => {
  it("a FOREIGN commit on a shard A doesn't run reaches A's live subscription AND advances A's oracle (cross-node RYOW)", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();

    // Seed a real 2-shard lease table (F = min(frontier_ts) over both rows, count-gate = 2), frontier 0.
    const lease = new LeaseManager(client, { advertiseUrl: "http://writer-a:4000" });
    await lease.setup();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    await acquireShardAsWriter(lease, "s1", 1, 10);

    // Writer node A: a real runtime reading/writing the primary directly (numShards=2). Its oracle is
    // seeded from the primary's max AT CREATE (0, empty) — so it will NOT see a later foreign commit
    // until something advances it. No writeRouter/fanout needed: the listener is the sole wake source.
    const catalog = new SimpleIndexCatalog().addIndex(byConversation);
    const runtime = await createEmbeddedRuntime({ store: primary, catalog, modules, numShards: 2 });

    // A opens a live subscription to messages:list {c1} — initially empty.
    const conn = runtime.connect("s1");
    const serverMsgs: ServerMsg[] = [];
    conn.onMessage((m) => serverMsgs.push(m));
    await conn.send({
      type: "ModifyQuerySet",
      add: [{ queryId: 1, udfPath: "messages:list", args: { conversationId: "c1" } }],
      remove: [],
    });
    expect(latestQueryValue(serverMsgs, 1)).toEqual([]); // initial: no rows

    // ── Writer B commits directly to the shared primary (on shard "s1", which A does not run) ──
    // Land the row + its by_conversation index entry at a foreign ts, BEFORE bumping the frontier (so
    // the listener, started next, seeds its watermark below this commit and actually pulls it).
    const T = 5n;
    const bDoc = newDocumentId(MESSAGES);
    const bKey = encodeIndexKey(["c1"]);
    await primary.write(
      [{ ts: T, id: bDoc, prev_ts: null, value: { id: bDoc, value: { conversationId: "c1", body: "from-B" } } }],
      [{ ts: T, update: { indexId: INDEX_ID, key: bKey, value: { type: "NonClustered", docId: bDoc } } }],
      "Error",
    );

    // CONTROL: before the listener runs, A's oracle is still at 0 — a direct read does NOT see B's row,
    // even though it's physically on the primary A reads from. This is exactly the staleness the
    // listener exists to cure (and proves the post-listener read below is observeTimestamp doing work).
    const controlList = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
    expect(controlList.value).toEqual([]);

    // Start the DERIVE-ONLY listener wired to A's runtime — the SAME sink node.ts uses (observe the ts,
    // then fan invalidation ranges into A's sync handler). `pgStore` is passed as the replica arg but
    // is never dereferenced in invalidateOnly mode.
    const listener = new ReplicaTailer(client, primary, primary, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async (inv: AppliedInvalidation) => {
        runtime.observeTimestamp(inv.newMaxTs);
        const ranges = [
          ...inv.writtenKeys.map((k) => keyToPointRange(k.indexId, k.key)),
          ...inv.writtenDocs.map((d) => docKeyToPointRange(d.tableId, d.internalId)),
        ];
        await runtime.handler.notifyWrites({ tables: inv.writtenTables, ranges, commitTs: Number(inv.newMaxTs) });
      },
    });
    await listener.start(); // seeds watermark at boot F = 0 (frontiers still 0)

    // Now reveal B's commit to the whole fleet: F = min(frontier_ts) advances to T (an idle-close on A
    // would do this for its held shards; here both rows move together).
    await client.query(`UPDATE shard_leases SET frontier_ts = $1 WHERE frontier_ts < $1`, [T]);

    try {
      // (1) A's live subscription gets NOTIFIED and re-runs, now seeing B's row.
      await waitUntil(() => Array.isArray(latestQueryValue(serverMsgs, 1)) && (latestQueryValue(serverMsgs, 1) as unknown[]).length > 0);
      const subValue = latestQueryValue(serverMsgs, 1) as Array<{ body: string }>;
      expect(subValue.map((d) => d.body)).toEqual(["from-B"]);

      // (2) A's ORACLE observed B's ts — a fresh direct read on A now sees the foreign row (RYOW-ish).
      const afterList = await runtime.run<Array<{ body: string }>>("messages:list", { conversationId: "c1" });
      expect(afterList.value.map((d) => d.body)).toEqual(["from-B"]);
    } finally {
      await listener.stop();
      conn.close();
      await primary.close();
    }
  }, 30_000);

  it("invalidateOnly mode never writes to the replica arg (derive-only)", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://writer-b:4000" });
    await lease.setup();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    await acquireShardAsWriter(lease, "s1", 1, 10);

    // A guard-tripwire "replica": any apply-path call (write/get/maxTimestamp seed) throws. In
    // invalidateOnly mode none of them must ever be reached — the listener is derive-only.
    const tripwire = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return undefined; // not a thenable
          return () => {
            throw new Error(`invalidateOnly listener dereferenced replica.${String(prop)} — it must not`);
          };
        },
      },
    ) as never;

    const invs: AppliedInvalidation[] = [];
    const listener = new ReplicaTailer(client, primary, tripwire, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async (inv) => void invs.push(inv),
    });
    await listener.start(); // must not touch replica.maxTimestamp()

    const doc = newDocumentId(MESSAGES);
    await primary.write(
      [{ ts: 3n, id: doc, prev_ts: null, value: { id: doc, value: { conversationId: "c9", body: "x" } } }],
      [{ ts: 3n, update: { indexId: INDEX_ID, key: encodeIndexKey(["c9"]), value: { type: "NonClustered", docId: doc } } }],
      "Error",
    );
    await client.query(`UPDATE shard_leases SET frontier_ts = 3 WHERE frontier_ts < 3`);

    try {
      await waitUntil(() => invs.length > 0); // derived without any replica.write / density read
      expect(invs[0]!.newMaxTs).toBe(3n);
      expect(invs[0]!.writtenTables.length).toBeGreaterThan(0);
    } finally {
      await listener.stop();
      await primary.close();
    }
  });

  // B2b whole-branch review, Fix 1 (Medium — promotion-handoff invalidation gap): `promoteFleetNode`
  // stops the outgoing sync `ReplicaTailer` (say at watermark W), then starts THIS derive-only
  // listener. A foreign co-writer's commit landing in between — after the tailer stopped, before the
  // listener starts — used to be invalidated by NEITHER: the pre-fix listener seeded from a FRESH
  // `readFrontier()` (i.e. whatever F had already become), so it silently treated the whole (W, F]
  // range as already-known. The fix: `start(seedWm)` seeds from the outgoing tailer's own final
  // watermark instead, so the two hand off contiguously. These two tests prove (a) the fix closes the
  // gap and (b) the gap is real absent the fix — i.e. the fix is load-bearing, not a no-op.
  it("promotion handoff: seedWm keeps invalidation contiguous across the tailer-stop -> listener-start gap", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://writer-c:4000" });
    await lease.setup();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    await acquireShardAsWriter(lease, "s1", 1, 10);

    // Simulate the outgoing sync tailer: start it (seeds W=0, F still 0), then stop it immediately —
    // exactly the `tailer.stop()` step `promoteFleetNode` runs before this listener is ever started.
    // Capture its own final watermark, mirroring the `tailer.watermark()` call node.ts's promotion path
    // makes right after `promoteFleetNode` returns.
    const outgoing = new ReplicaTailer(client, primary, primary, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async () => {},
    });
    await outgoing.start();
    await outgoing.stop();
    const seedWm = outgoing.watermark();
    expect(seedWm).toBe(0n);

    // While NOTHING is listening (the "promoting" node hasn't started its listener yet), two foreign
    // commits land directly on the primary — a live co-writer — advancing the frontier past W.
    const doc1 = newDocumentId(MESSAGES);
    const doc2 = newDocumentId(MESSAGES);
    await primary.write(
      [{ ts: 1n, id: doc1, prev_ts: null, value: { id: doc1, value: { conversationId: "c1", body: "one" } } }],
      [{ ts: 1n, update: { indexId: INDEX_ID, key: encodeIndexKey(["c1"]), value: { type: "NonClustered", docId: doc1 } } }],
      "Error",
    );
    await primary.write(
      [{ ts: 2n, id: doc2, prev_ts: null, value: { id: doc2, value: { conversationId: "c1", body: "two" } } }],
      [{ ts: 2n, update: { indexId: INDEX_ID, key: encodeIndexKey(["c1"]), value: { type: "NonClustered", docId: doc2 } } }],
      "Error",
    );
    await client.query(`UPDATE shard_leases SET frontier_ts = 2 WHERE frontier_ts < 2`);

    // The new writer-ish listener seeds from the OUTGOING tailer's own final watermark (0), NOT a
    // fresh readFrontier() (which would already read F=2 by the time this starts).
    const invs: AppliedInvalidation[] = [];
    const listener = new ReplicaTailer(client, primary, primary, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async (inv) => void invs.push(inv),
    });
    await listener.start(seedWm);

    try {
      await waitUntil(() => listener.watermark() >= 2n);
      // Both commits from the handoff gap (ts 1 and 2) were derived and invalidated — neither was
      // silently skipped, and the listener's own watermark (a stand-in for the oracle's observed ts,
      // same `runtime.observeTimestamp(inv.newMaxTs)` the real sink calls) reached the new F.
      const allDocs = invs.flatMap((inv) => inv.writtenDocs);
      expect(allDocs.length).toBe(2);
      expect(invs.some((inv) => inv.newMaxTs === 2n)).toBe(true);
    } finally {
      await listener.stop();
      await primary.close();
    }
  });

  it("REGRESSION shape: without seedWm, a listener seeded at the fresh frontier misses the handoff-gap commits (proves the fix is load-bearing)", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    const lease = new LeaseManager(client, { advertiseUrl: "http://writer-d:4000" });
    await lease.setup();
    await lease.tryAcquire(DEFAULT_SHARD, 0);
    await acquireShardAsWriter(lease, "s1", 1, 10);

    // Same gap-inducing setup as above: the outgoing tailer stops at W=0...
    const outgoing = new ReplicaTailer(client, primary, primary, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async () => {},
    });
    await outgoing.start();
    await outgoing.stop();

    // ...and two foreign commits land + the frontier advances to F=2 WHILE NOTHING IS LISTENING —
    // identical gap window to the test above.
    const doc1 = newDocumentId(MESSAGES);
    const doc2 = newDocumentId(MESSAGES);
    await primary.write(
      [{ ts: 1n, id: doc1, prev_ts: null, value: { id: doc1, value: { conversationId: "c1", body: "one" } } }],
      [{ ts: 1n, update: { indexId: INDEX_ID, key: encodeIndexKey(["c1"]), value: { type: "NonClustered", docId: doc1 } } }],
      "Error",
    );
    await primary.write(
      [{ ts: 2n, id: doc2, prev_ts: null, value: { id: doc2, value: { conversationId: "c1", body: "two" } } }],
      [{ ts: 2n, update: { indexId: INDEX_ID, key: encodeIndexKey(["c1"]), value: { type: "NonClustered", docId: doc2 } } }],
      "Error",
    );
    await client.query(`UPDATE shard_leases SET frontier_ts = 2 WHERE frontier_ts < 2`);

    // WITHOUT seedWm (the pre-fix call shape): the listener seeds from a FRESH readFrontier(), which is
    // already F=2 by now — it treats the (0, 2] range as already-known and never derives it.
    const invs: AppliedInvalidation[] = [];
    const listener = new ReplicaTailer(client, primary, primary, {
      mode: "invalidateOnly",
      numShards: 2,
      pollMs: 20,
      onInvalidation: async (inv) => void invs.push(inv),
    });
    await listener.start(); // no seedWm

    try {
      expect(listener.watermark()).toBe(2n); // seeded straight at the fresh frontier, skipping ts 1/2
      // Give the poll loop several beats to prove this isn't just a timing fluke — nothing more will
      // EVER be derived for ts 1/2: they're already "behind" the seeded watermark, permanently.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(invs.length).toBe(0); // the gap this fix closes: both commits' invalidations were missed
    } finally {
      await listener.stop();
      await primary.close();
    }
  });
});
