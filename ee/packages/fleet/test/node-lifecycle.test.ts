/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Node lifecycle (Fleet slice 2, Task 4) — the pieces of `prepareFleetNode`/`startFleetNode` that
 * are unit-testable in isolation:
 *
 *   (a) `openSyncReplica` — a sync node's local file-backed replica behind a `SwitchableDocStore`,
 *       at `<dataDir>/fleet-replica.db`.
 *   (b) `promoteFleetNode` — the CRITICAL PROMOTION ORDER, asserted via instrumented spies (the
 *       real full lifecycle over a live runtime + real Postgres is the Task-5/`fleet-e2e` ship gate).
 *   (c) corrupted replica file → delete + retry once + warn → boots.
 *   (d) restart resume — a fresh replica on the same file seeds its watermark from the persisted
 *       max and does NOT re-deliver already-applied entries.
 *
 * `prepareFleetNode`/`startFleetNode` as a whole build a real `NodePgClient` from a connection
 * string and contend a Postgres advisory lock (writer-vs-sync election), so the integrated path is
 * proven only through the real `stackbase serve --fleet` E2E; here we exercise their extracted,
 * side-effect-free seams directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { newDocumentId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocStore, DocumentLogEntry, IndexWrite, InternalDocumentId } from "@stackbase/docstore";
import type { NodePgClient } from "@stackbase/docstore-postgres";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { PgliteClient } from "./pglite-client";
import { ReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";
import { SwitchableDocStore } from "../src/switchable-store";
import { LeaseManager } from "../src/lease";
import { WriteForwarder } from "../src/forwarder";
import {
  openSyncReplica,
  promoteFleetNode,
  reconcileReplicaIdentity,
  startFleetNode,
  FLEET_DEPLOYMENT_ID_KEY,
  REPLICA_DB_FILENAME,
} from "../src/node";

const T1 = 10001;
const INDEX_ID_T1 = encodeStorageIndexId(T1, "by_key");

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID_T1, key, value: { type: "NonClustered", docId: id } } };
}

describe("fleet node lifecycle", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fleet-node-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("(a) openSyncReplica returns a SwitchableDocStore over a file at <dataDir>/fleet-replica.db", async () => {
    const path = join(tmp, REPLICA_DB_FILENAME);
    const { replica, switchable } = await openSyncReplica(path);
    try {
      expect(switchable).toBeInstanceOf(SwitchableDocStore);
      expect(switchable.current()).toBe(replica); // switchable forwards to the replica initially
      expect(existsSync(path)).toBe(true); // real on-disk SQLite file
      expect(await replica.maxTimestamp()).toBe(0n); // schema set up, fresh (nothing applied yet)
    } finally {
      await replica.close();
    }
  });

  it("(b) promoteFleetNode runs the critical order: observeTimestamp→setWritable→swapTo→promote→tailer.stop→startDrivers", async () => {
    const order: string[] = [];
    let observed: bigint | undefined;
    let swappedTo: unknown;
    const pgStore = {
      maxTimestamp: async () => 42n, // the oracle must be advanced past ALL primary history
      setWritable: () => void order.push("setWritable"),
    };
    const runtime = {
      observeTimestamp: (ts: bigint) => {
        observed = ts;
        order.push("observeTimestamp");
      },
      startDrivers: async () => void order.push("startDrivers"),
    };
    const switchable = {
      swapTo: (next: DocStore) => {
        swappedTo = next;
        order.push("swapTo");
      },
    };
    const forwarder = { promote: () => void order.push("promote") };
    const tailer = { stop: async () => void order.push("tailer.stop") };
    const replica = { close: async () => void order.push("replica.close") };

    await promoteFleetNode({ runtime, pgStore, switchable, forwarder, tailer, replica });

    // The documented critical order (replica.close falls between tailer.stop and startDrivers —
    // the tailer must have stopped writing to the replica before it's closed).
    expect(order).toEqual([
      "observeTimestamp",
      "setWritable",
      "swapTo",
      "promote",
      "tailer.stop",
      "replica.close",
      "startDrivers",
    ]);
    expect(observed).toBe(42n); // observeTimestamp got the primary's maxTimestamp()
    expect(swappedTo).toBe(pgStore); // the runtime store repoints at the (now writable) pg store
  });

  it("(c) a corrupted replica file is deleted, rebuilt on one retry, and boots (with a warning)", async () => {
    const path = join(tmp, REPLICA_DB_FILENAME);
    // Garbage bytes → not a valid SQLite database → open/setupSchema throws on the first attempt.
    writeFileSync(path, Buffer.from("this is definitely not a sqlite database header"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { replica, switchable } = await openSyncReplica(path);
      try {
        expect(switchable.current()).toBe(replica);
        expect(await replica.maxTimestamp()).toBe(0n); // fresh, usable replica after the rebuild
        expect(warn).toHaveBeenCalledTimes(1); // the delete+retry was reported
        expect(String(warn.mock.calls[0]![0])).toContain("failed to open");
      } finally {
        await replica.close();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("(d) restart resume: a fresh replica on the same file seeds the watermark and skips old entries", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();
    // Fenced Frontier B1 (D5): the tailer's pull target is `shard_leases.frontier_ts`, not
    // `primary.maxTimestamp()` — a real lease row is required, and since this test drives the
    // primary via raw `write()` (exact ts control, matching `replica-tailer.test.ts`'s pattern)
    // rather than the guarded `commitWrite`, the frontier is advanced by hand below.
    const lease = new LeaseManager(client, { advertiseUrl: "http://node-lifecycle-restart-test:0" });
    await lease.setup();
    await lease.tryAcquire();
    const path = join(tmp, REPLICA_DB_FILENAME);

    const a = newDocumentId(T1);
    const b = newDocumentId(T1);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(a, encodeIndexKey(["a"]), 1n)], "Error");
    await primary.write([rev(b, 2n, null, "B1")], [idxPut(b, encodeIndexKey(["b"]), 2n)], "Error");
    await client.query(
      `UPDATE shard_leases SET prev_ts = frontier_ts, frontier_ts = $1 WHERE shard_id = 'default'`,
      [2n],
    );

    // First run: tail the two entries onto a file-backed replica, then dispose.
    const r1 = new SqliteDocStore(new NodeSqliteAdapter({ path }));
    await r1.setupSchema();
    const t1 = new ReplicaTailer(client, primary, r1, { pollMs: 20, onInvalidation: async () => {} });
    await t1.start();
    expect(await r1.maxTimestamp()).toBe(2n); // caught up
    await t1.stop();
    await r1.close();

    // Second run: re-open the SAME file. The persisted watermark (2) must be seeded so the already
    // -applied (0, 2] range is NOT re-delivered — onInvalidation stays silent, watermark starts at 2.
    const r2 = new SqliteDocStore(new NodeSqliteAdapter({ path }));
    await r2.setupSchema();
    expect(await r2.maxTimestamp()).toBe(2n); // watermark survived the restart on disk
    const invs: AppliedInvalidation[] = [];
    const t2 = new ReplicaTailer(client, primary, r2, {
      pollMs: 20,
      onInvalidation: async (inv) => void invs.push(inv),
    });
    await t2.start();
    expect(t2.watermark()).toBe(2n); // seeded from the replica, not 0
    // Give the poll loop a couple of ticks with nothing new — the old range must not re-fire.
    await new Promise((r) => setTimeout(r, 80));
    expect(invs).toEqual([]);

    await t2.stop();
    await r2.close();
    await primary.close();
  }, 30_000);

  describe("(e) reconcileReplicaIdentity — C7 foreign-replica deployment-id stamp", () => {
    let client: PgliteClient;
    let primary: PostgresDocStore;
    const PRIMARY_ID = "id-A";

    beforeEach(async () => {
      client = new PgliteClient();
      primary = new PostgresDocStore(client);
      await primary.setupSchema();
      // Stamp the primary directly — mirrors the writer boot path's `writeGlobalIfAbsent` mint.
      expect(await primary.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, PRIMARY_ID)).toBe(true);
    });
    afterEach(async () => {
      await primary.close();
    });

    it("fresh replica (no data, no stamp) is adopted silently — no warn, no rebuild", async () => {
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { replica } = await reconcileReplicaIdentity({
          pgStore: primary,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        expect(replica).toBe(opened.replica); // same object — no rebuild
        expect(await replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBe(PRIMARY_ID); // adopted
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        await opened.replica.close();
      }
    });

    it("matching stamp proceeds as-is — no rebuild, data preserved", async () => {
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path);
      const a = newDocumentId(T1);
      await opened.replica.write(
        [rev(a, 1n, null, "A1")],
        [idxPut(a, encodeIndexKey(["a"]), 1n)],
        "Error",
      );
      await opened.replica.writeGlobal(FLEET_DEPLOYMENT_ID_KEY, PRIMARY_ID); // already stamped for A
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { replica } = await reconcileReplicaIdentity({
          pgStore: primary,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        expect(replica).toBe(opened.replica); // same object — no rebuild
        expect(await replica.maxTimestamp()).toBe(1n); // pre-existing data preserved
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        await opened.replica.close();
      }
    });

    it("replica stamped for a DIFFERENT primary is warned about, rebuilt, and adopts the primary's id", async () => {
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path);
      const a = newDocumentId(T1);
      // Simulate a replica file that previously tailed a DIFFERENT primary (id-B): foreign data +
      // a foreign stamp.
      await opened.replica.write(
        [rev(a, 1n, null, "FOREIGN")],
        [idxPut(a, encodeIndexKey(["a"]), 1n)],
        "Error",
      );
      await opened.replica.writeGlobal(FLEET_DEPLOYMENT_ID_KEY, "id-B");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { replica } = await reconcileReplicaIdentity({
          pgStore: primary,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain("does not match");
        expect(replica).not.toBe(opened.replica); // rebuilt — a fresh SqliteDocStore instance
        expect(await replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBe(PRIMARY_ID); // now id-A
        expect(await replica.maxTimestamp()).toBe(0n); // foreign rows are gone
        await replica.close();
      } finally {
        warn.mockRestore();
      }
    });

    it("data present but no stamp (pre-C7 replica) is rebuilt and adopts the primary's id", async () => {
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path);
      const a = newDocumentId(T1);
      // No FLEET_DEPLOYMENT_ID_KEY written at all — mirrors a replica file created before C7.
      await opened.replica.write(
        [rev(a, 1n, null, "PRE_C7")],
        [idxPut(a, encodeIndexKey(["a"]), 1n)],
        "Error",
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const { replica } = await reconcileReplicaIdentity({
          pgStore: primary,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(replica).not.toBe(opened.replica); // rebuilt
        expect(await replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBe(PRIMARY_ID);
        expect(await replica.maxTimestamp()).toBe(0n); // old, unstamped rows are gone
        await replica.close();
      } finally {
        warn.mockRestore();
      }
    });

    it("REGRESSION (C7 concurrent-boot crash): reconcile must not run before persistence_globals exists", async () => {
      // Reproduces the reviewer's finding: on a fresh multi-node CONCURRENT first boot, the OLD code
      // called `reconcileReplicaIdentity` from `prepareFleetNode` — which runs BEFORE `bootProject`
      // (and thus before ANY node's `store.setupSchema()` has created `persistence_globals`). Simulate
      // exactly that: a PG store with NO setupSchema run yet.
      const freshClient = new PgliteClient();
      const pgStore = new PostgresDocStore(freshClient, { readOnly: true });
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path); // mirrors prepareFleetNode's sync branch (post-fix:
      // it no longer calls reconcileReplicaIdentity itself — see src/node.ts).
      try {
        // The old call site's exact crash: querying persistence_globals before its DDL has run.
        await expect(
          reconcileReplicaIdentity({
            pgStore,
            replica: opened.replica,
            switchable: opened.switchable,
            replicaPath: path,
          }),
        ).rejects.toThrow();

        // Now simulate the REST of the real `serve` sequence for this node: prepare (done above) ->
        // this node's own `bootProject` runs `store.setupSchema()` -> `startFleetNode`. For a writer
        // that's `pgStore.setupSchema()` directly; the fix's guarantee is that by the time
        // `startFleetNode`'s sync path calls reconcile (right before `tailer.start()`), the shared
        // Postgres schema already exists — model that here by running the DDL now, between "prepare"
        // and "start".
        await pgStore.setupSchema();

        // The NEW call site (startFleetNode, post-DDL) succeeds.
        const { replica } = await reconcileReplicaIdentity({
          pgStore,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        expect(await replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).not.toBeNull(); // stamped, no crash
      } finally {
        await opened.replica.close();
        await pgStore.close();
      }
    });

    it("the old prepareFleetNode call site is gone: sync boot's prep step never touches pgStore at all", async () => {
      // `prepareFleetNode` itself requires a live `NodePgClient` (a real Postgres connection string),
      // so it can't be exercised directly in this unit suite (see the file's module doc comment) —
      // the full integration is the `stackbase serve --fleet` E2E. What IS unit-testable here is the
      // structural claim: `openSyncReplica` — what `prepareFleetNode`'s sync branch now calls, with
      // `reconcileReplicaIdentity` no longer inline after it — touches ONLY the local replica file and
      // never queries Postgres. Proven against a PG store whose `persistence_globals` table does NOT
      // exist yet (no `setupSchema()` has run): if `prepareFleetNode`'s sync prep still reached into
      // `pgStore` (the old bug), a fresh un-migrated store would make that crash; `openSyncReplica`
      // completing cleanly demonstrates it doesn't.
      const freshClient = new PgliteClient();
      const pgStore = new PostgresDocStore(freshClient, { readOnly: true }); // NOT set up — would 404
      const path = join(tmp, REPLICA_DB_FILENAME);
      const { replica, switchable } = await openSyncReplica(path);
      try {
        expect(switchable.current()).toBe(replica); // succeeded without ever touching Postgres
        // Confirm the un-migrated store really would have thrown, had anything queried it — grounding
        // the "never touches pgStore" claim above rather than asserting it vacuously.
        await expect(pgStore.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).rejects.toThrow();
      } finally {
        await replica.close();
        await pgStore.close();
      }
    });

    it("REGRESSION (sync self-sufficiency): startFleetNode's sync path succeeds on a database whose setupSchema was NEVER externally run", async () => {
      // The narrower window left after the call-site move: a sync node's own bootProject runs
      // setupSchema on its LOCAL replica (its runtime store is the SwitchableDocStore over the
      // replica), so on a fresh database with the writer's bootProject still mid-flight, NOTHING has
      // created persistence_globals/documents/indexes on Postgres when startFleetNode's stamp check
      // and tailer.start() read them. The fix: startFleetNode's sync path runs the idempotent
      // (read-only, no writer lock) pgStore.setupSchema() itself, first. Exercise the REAL
      // startFleetNode sync path — not extracted seams — against a PG store nobody migrated.
      const freshClient = new PgliteClient();
      const pgStore = new PostgresDocStore(freshClient, { readOnly: true }); // NO setupSchema, anywhere
      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path); // = prepareFleetNode's sync prep (local file only)
      const lease = new LeaseManager(freshClient, {
        advertiseUrl: "http://127.0.0.1:9999",
        // PgliteClient.tryAcquireWriterLock always returns true, so a fast retry would spuriously
        // promote this "sync" node mid-test; the first acquireLoop attempt only fires after retryMs,
        // and handles.stop() cancels it long before an hour elapses.
        retryMs: 3_600_000,
      });
      // Fenced Frontier B1 (D5): the tailer now reads `shard_leases.frontier_ts` as its pull
      // target, so the table must exist — in production this is ALWAYS true by the time
      // `startFleetNode` runs (`prepareFleetNode` calls `lease.setup()` before deciding
      // sync-vs-writer); this test bypasses `prepareFleetNode` and drives `startFleetNode`
      // directly, so it must do that setup step itself.
      await lease.setup();
      const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://127.0.0.1:9999" });
      expect(forwarder.isLocalWriter()).toBe(false); // sync role — takes startFleetNode's sync path
      const runtime = {
        observeTimestamp: () => {},
        startDrivers: async () => {},
        handler: { notifyWrites: async () => {} },
      } as unknown as EmbeddedRuntime;

      const handles = await startFleetNode({
        client: freshClient as unknown as NodePgClient, // structural: query/listen used; onConnectionLost is optional-chained
        pgStore,
        runtime,
        lease,
        forwarder,
        replica: opened.replica,
        switchable: opened.switchable,
        replicaPath: path,
      });
      try {
        // startFleetNode resolving at all IS the regression assertion: it ran its own setupSchema,
        // then the stamp check (mint-adopt: fresh primary had no stamp), then tailer.start() gated
        // on catch-up against the empty-but-migrated log. Confirm each observable effect:
        expect(handles.role()).toBe("sync");
        const minted = await pgStore.getGlobal(FLEET_DEPLOYMENT_ID_KEY); // schema exists + stamp minted
        expect(minted).not.toBeNull();
        expect(await opened.replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBe(minted); // replica adopted it
      } finally {
        await handles.stop(); // stops lease loop + tailer, closes pgStore (and with it freshClient)
        await opened.replica.close();
      }
    });

    it("primary has no stamp yet (sync node won the boot race): mint-adopts race-safely, then proceeds", async () => {
      // A separate primary with NO stamp — the sync node hits reconcileReplicaIdentity before the
      // writer has minted one.
      const freshClient = new PgliteClient();
      const freshPrimary = new PostgresDocStore(freshClient);
      await freshPrimary.setupSchema();
      expect(await freshPrimary.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBeNull();

      const path = join(tmp, REPLICA_DB_FILENAME);
      const opened = await openSyncReplica(path);
      try {
        const { replica } = await reconcileReplicaIdentity({
          pgStore: freshPrimary,
          replica: opened.replica,
          switchable: opened.switchable,
          replicaPath: path,
        });
        const mintedId = await freshPrimary.getGlobal(FLEET_DEPLOYMENT_ID_KEY);
        expect(typeof mintedId).toBe("string");
        expect(mintedId).not.toBeNull();
        expect(await replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY)).toBe(mintedId); // adopted the mint
      } finally {
        await opened.replica.close();
        await freshPrimary.close();
      }
    });
  });
});

describe("F1 fix (Fenced Frontier B1 whole-branch review, BLOCKER): writer-boot frontier seed closes the pre-loaded-database bootstrap hole", () => {
  // Reproduces the bug end to end: a single-node Postgres store accumulates real documents via the
  // RAW write() path with NO lease/fleet machinery involved at all (no `shard_leases` row exists) —
  // exactly what a pre-fleet `stackbase serve` looks like. The operator then enables `--fleet` for
  // the first time. Before the fix, the first `tryAcquire()` seeds `frontier_ts=0` even though the
  // store already holds history, so a fresh sync node's ready gate (`wm=0 < target=0`) is a silent
  // no-op and it reports ready with an EMPTY replica. Drives the REAL `startFleetNode` writer path
  // (not just the extracted `seedFrontier` seam) so the fix is proven where it actually runs: after
  // `pgStore.setupSchema()`, before this node is reported ready.
  it("a pre-loaded store gets frontier_ts seeded at writer boot, and a fresh sync tailer then catches up on the FULL history", async () => {
    const client = new PgliteClient();
    const primary = new PostgresDocStore(client);
    await primary.setupSchema();

    const a = newDocumentId(T1);
    const b = newDocumentId(T1);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(a, encodeIndexKey(["a"]), 1n)], "Error");
    await primary.write([rev(b, 2n, null, "B1")], [idxPut(b, encodeIndexKey(["b"]), 2n)], "Error");
    expect(await primary.maxTimestamp()).toBe(2n);

    // Operator enables --fleet: prepareFleetNode's writer decision (PgliteClient's single connection
    // always wins tryAcquireWriterLock()). Lease row is freshly created at frontier_ts=0 — the bug's
    // starting condition, unchanged by this fix (tryAcquire() itself is untouched).
    const lease = new LeaseManager(client, { advertiseUrl: "http://writer:9001" });
    await lease.setup();
    const acquired = await lease.tryAcquire();
    expect(acquired).toEqual({ epoch: 1n, writerUrl: "http://writer:9001", frontierTs: 0n });
    expect((await lease.read())?.frontierTs).toBe(0n);

    primary.setWritable();
    const forwarder = new WriteForwarder(lease, { adminKey: "k", selfUrl: "http://writer:9001" });
    forwarder.promote();
    expect(forwarder.isLocalWriter()).toBe(true); // takes startFleetNode's WRITER branch

    const runtime = {
      observeTimestamp: () => {},
      startDrivers: async () => {},
      handler: { notifyWrites: async () => {} },
    } as unknown as EmbeddedRuntime;
    const onExit = vi.fn();

    const handles = await startFleetNode({
      client: client as unknown as NodePgClient, // structural: query/listen used; onConnectionLost optional
      pgStore: primary,
      runtime,
      lease,
      forwarder,
      onExit,
    });
    try {
      expect(handles.role()).toBe("writer");
      expect(onExit).not.toHaveBeenCalled();
      // THE FIX: frontier_ts is now seeded up to the pre-existing max ts instead of staying at 0.
      expect((await lease.read())?.frontierTs).toBe(2n);

      // The actual observable failure mode, closed end to end: a fresh sync node joining NOW must
      // catch up on the FULL pre-loaded history, not bootstrap empty.
      const replica = new SqliteDocStore(new NodeSqliteAdapter());
      await replica.setupSchema();
      const invalidations: AppliedInvalidation[] = [];
      const tailer = new ReplicaTailer(client, primary, replica, {
        pollMs: 20,
        onInvalidation: async (inv) => {
          invalidations.push(inv);
        },
      });
      try {
        await tailer.start(); // must catch up to ts=2, not resolve immediately empty
        expect(await replica.maxTimestamp()).toBe(2n);
        expect(await replica.get(a)).not.toBeNull();
        expect(await replica.get(b)).not.toBeNull();
        expect(invalidations.length).toBeGreaterThan(0);
      } finally {
        await tailer.stop();
        await replica.close();
      }
    } finally {
      await handles.stop();
    }
  });
});
