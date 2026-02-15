import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { loadConvexDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";

// Tier 3 Slice 6, Task 6.3 smoke test: `bootLoaded` with a `file://` object-store URL constructs an
// acquired, working writer node whose store is the object-storage substrate — proving the wiring
// (ee-gate → resolve → ensureGlobals → materialize → acquire → drivers) end-to-end at the boot-core
// level. The full E2E through the real `stackbase serve` entrypoint (fs + MinIO, second-node takeover,
// reactive fan-out over a WebSocket) is Task 6.4's job — deliberately not duplicated here.

const ROOT = "./.tmp-objectstore-boot";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bootLoaded — Tier 3 Slice 6 object-store writer node", () => {
  it("boots over a file:// bucket, acquires the lease, and commits + reads back a mutation", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex");
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

    objectStoreRelease?.();
    await runtime.stopDrivers();
    await store.close();
  });

  it("a fresh boot against the SAME bucket (different local dir) ADOPTS the existing deploymentId and takes over after release", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex");
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

    // Release node A's in-process hold and stop its heartbeat — its lease still needs to EXPIRE
    // (release() doesn't touch the bucket) before node B's acquire can succeed; the short TTL above
    // plus acquireWithRetry's bounded retry loop covers that wait.
    nodeA.objectStoreRelease?.();
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
      nodeB.objectStoreRelease?.();
      await nodeB.runtime.stopDrivers();
      await nodeB.store.close();
    }
  });

  it("throws a clear error when combined with fleet wiring", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex");
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
