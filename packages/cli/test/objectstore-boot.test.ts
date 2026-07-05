import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { FsObjectStore } from "@helipod/objectstore-fs";
import { loadFunctionsDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";

// Tier 3 Slice 6, Task 6.3 smoke test: `bootLoaded` with a `file://` object-store URL constructs an
// acquired, working writer node whose store is the object-storage substrate — proving the wiring
// (ee-gate → resolve → ensureGlobals → materialize → acquire → drivers) end-to-end at the boot-core
// level. The full E2E through the real `helipod serve` entrypoint (fs + MinIO, second-node takeover,
// reactive fan-out over a WebSocket) is Task 6.4's job — deliberately not duplicated here.

const ROOT = "./.tmp-objectstore-boot";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bootLoaded — Tier 3 Slice 6 object-store writer node", () => {
  it("boots over a file:// bucket, acquires the lease, and commits + reads back a mutation", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    const { runtime, store, objectStoreRelease } = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/node-a/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: `file://${ROOT}/bucket`,
      objectStoreWriterId: "node-a",
    });
    expect(objectStoreRelease).toBeDefined();

    const inserted = await runtime.run("notes:add", { box: "b1", text: "hello" });
    expect(inserted.value).toBeTruthy();

    const listed = await runtime.run("notes:list", {});
    expect(listed.value).toEqual([{ box: "b1", text: "hello" }]);

    await objectStoreRelease?.();
    await runtime.stopDrivers();
    await store.close();
  });

  it("multi-shard (--shards 3): boots+acquires all 3 lanes, the runtime commits+reads over the ShardedObjectStoreDocStore composite, and the bucket has every lane's manifest", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    const bucketDir = `${ROOT}/ms-bucket`;
    const { runtime, store, objectStoreRelease } = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/ms-node/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: `file://${bucketDir}`,
      objectStoreWriterId: "ms-node",
      objectStoreShards: 3,
    });
    expect(objectStoreRelease).toBeDefined();

    // The runtime works over the composite: mutations commit (this fixture is unsharded, so they
    // land on the "default" lane) and `notes:list` reads fan out + MERGE across all 3 lanes.
    expect((await runtime.run("notes:add", { box: "b3", text: "one" })).value).toBeTruthy();
    expect((await runtime.run("notes:add", { box: "b4", text: "two" })).value).toBeTruthy();
    const listed = await runtime.run("notes:list", {});
    expect((listed.value as Array<{ box: string; text: string }>).map((r) => r.text).sort()).toEqual(["one", "two"]);

    // Every lane in shardIdList(3) = ["default","s1","s2"] was opened + acquired: each has its own
    // manifest object under its own `s{shardId}/…` prefix (a distinct contention domain per §5).
    const inspector = new FsObjectStore({ dir: bucketDir });
    for (const shardId of ["default", "s1", "s2"]) {
      expect(await inspector.get(`s${shardId}/manifest`), `lane '${shardId}' manifest`).not.toBeNull();
    }

    await objectStoreRelease?.();
    await runtime.stopDrivers();
    await store.close();
  });

  it("a fresh boot against the SAME bucket (different local dir) ADOPTS the existing deploymentId and takes over immediately after relinquish (Task 6.5)", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    const bucket = `file://${ROOT}/bucket-adopt`;

    const nodeA = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/adopt-a/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      objectStoreWriterId: "node-a",
      // Short TTL/poll so node B's takeover-after-release doesn't wait a full production-sized lease.
      objectStoreLeaseTtlMs: 200,
      objectStoreHeartbeatMs: 60,
      objectStoreAcquireTimeoutMs: 5000,
      objectStoreAcquirePollIntervalMs: 50,
    });
    await nodeA.runtime.run("notes:add", { box: "b1", text: "from-a" });
    const deploymentIdA = await nodeA.store.getGlobal("fleet:deploymentId");
    expect(typeof deploymentIdA).toBe("string");

    // Task 6.5: objectStoreRelease() now calls store.relinquish(), which best-effort CAS-clears the
    // lease IN THE BUCKET — node B's acquire below should succeed immediately, not after waiting out
    // the short TTL above (which still exists purely as a fallback/no-regression margin).
    await nodeA.objectStoreRelease?.();
    await nodeA.runtime.stopDrivers();
    await nodeA.store.close();

    const nodeB = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/adopt-b/db.sqlite`, // fresh local dir — must materialize from the bucket
      adminKey: "k",
      objectStoreUrl: bucket,
      objectStoreWriterId: "node-b",
      objectStoreLeaseTtlMs: 200,
      objectStoreHeartbeatMs: 60,
      objectStoreAcquireTimeoutMs: 5000,
      objectStoreAcquirePollIntervalMs: 50,
    });
    try {
      // Adopts the SAME deploymentId node A's bucket globals established — never mints a fresh one.
      const deploymentIdB = await nodeB.store.getGlobal("fleet:deploymentId");
      expect(deploymentIdB).toBe(deploymentIdA);

      // Sees node A's committed data, materialized fresh from the bucket alone (a brand-new local dir).
      const listed = await nodeB.runtime.run("notes:list", {});
      expect(listed.value).toEqual([{ box: "b1", text: "from-a" }]);
    } finally {
      await nodeB.objectStoreRelease?.();
      await nodeB.runtime.stopDrivers();
      await nodeB.store.close();
    }
  });

  // Tier 3 Slice 7, Task 7.3a: the gc-driver registered on the object-store writer node's boot
  // reclaims storage automatically, on a running node, without breaking reads/bootstrap. Uses a
  // real (short) sweep cadence + a real sleep — `createEmbeddedRuntime`'s DriverContext.setTimer
  // is backed by real `setTimeout`, same pattern `storage-e2e.test.ts` uses for the storage reaper.
  it("the gc-driver reclaims superseded segments/snapshots automatically while the node stays live and queryable", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    const bucketDir = `${ROOT}/bucket-gc`;
    const boot = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/node-gc/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: `file://${bucketDir}`,
      objectStoreWriterId: "node-gc",
      // Effectively disable the timer-driven sweep (1h cadence) so it can NEVER fire during the
      // commit loop below — the `preSweepSegCount === 16` assertion asserts a mid-flight "nothing
      // reclaimed yet" state, which races a short-cadence background sweep under parallel load (the
      // driver would reclaim early segments before we measure). We instead trigger the sweep
      // DETERMINISTICALLY via `store.gc()` after the pre-measurement — same as `gc-driver.test.ts`
      // drives its fake `fireDueTimers()` rather than waiting on wall-clock.
      objectStoreGcMs: 3_600_000,
    });
    try {
      // SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrors gc-driver.test.ts's own note. Drive two
      // cadences' worth of commits so the bucket has a stale (first) snapshot + segments superseded
      // by the second snapshot for gc() to reclaim.
      const SNAPSHOT_EVERY = 8;
      for (let i = 0; i < 2 * SNAPSHOT_EVERY; i++) {
        await boot.runtime.run("notes:add", { box: "b1", text: `note-${i}` });
      }

      // Introspect the bucket directly (a fresh FsObjectStore rooted at the SAME dir the writer
      // node's `file://` URL resolved to — `parseFsObjectStorePath` is a pure string slice, so this
      // is exactly the writer's own bucket, not a separate copy).
      const inspector = new FsObjectStore({ dir: bucketDir });
      const segPrefix = "s0/seg/";
      const snapPrefix = "s0/snap/";
      const preSweepSegCount = (await inspector.list(segPrefix)).length;
      const preSweepSnapCount = (await inspector.list(snapPrefix)).length;
      expect(preSweepSegCount).toBe(2 * SNAPSHOT_EVERY); // nothing reclaimed yet
      expect(preSweepSnapCount).toBe(2); // both snapshots still present (stale + current)

      // Trigger the sweep DETERMINISTICALLY (the timer above is armed 1h out and will never fire in
      // the test) — `store.gc()` is the exact call the gc-driver makes on its cadence. No wall-clock.
      await (boot.store as unknown as { gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }> }).gc();

      const postSweepSegCount = (await inspector.list(segPrefix)).length;
      const postSweepSnapCount = (await inspector.list(snapPrefix)).length;
      expect(postSweepSegCount).toBeLessThan(preSweepSegCount); // superseded segments reclaimed
      expect(postSweepSnapCount).toBe(1); // only the current snapshot survives

      // The node stays live + queryable after reclamation — a read still returns the current state
      // (reclamation didn't break bootstrap/materialization).
      const listed = await boot.runtime.run("notes:list", {});
      expect((listed.value as unknown[]).length).toBe(2 * SNAPSHOT_EVERY);
    } finally {
      await boot.objectStoreRelease?.();
      await boot.runtime.stopDrivers();
      await boot.store.close();
    }
  });

  it("throws a clear error when combined with fleet wiring", async () => {
    const loaded = await loadFunctionsDir("test/fixtures/deploy-v2/helipod");
    await expect(
      bootLoaded({
        loaded,
        components: [],
        dataPath: `${ROOT}/combo/db.sqlite`,
        adminKey: "k",
        objectStoreUrl: `file://${ROOT}/combo-bucket`,
        fleet: { store: {} as never },
      }),
    ).rejects.toThrow(/cannot be combined with --fleet/);
  });
});
