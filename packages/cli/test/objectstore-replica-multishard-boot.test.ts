/**
 * Multi-shard replica boot (multi-shard-replicas Task 1): a `--shards 3` writer over a channelId-
 * sharded fixture; a replica derives 3 lanes from the bucket's globals, materializes + reads every
 * lane through the composite, publishes a per-lane consumer watermark, and rejects writes. The full
 * E2E through two real `helipod serve` processes (fs + MinIO, cross-node reactive fan-out over a
 * non-default lane) is Task 2's job — deliberately not duplicated here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { FsObjectStore } from "@helipod/objectstore-fs";
import { shardIdForKeyValue } from "@helipod/id-codec";
import { loadFunctionsDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";

const ROOT = "./.tmp-objectstore-replica-ms-boot";
const FIXTURE = "test/fixtures/shard-dev/helipod";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe("bootLoaded — multi-shard object-store replica", () => {
  it("a 3-shard replica materializes + reads every lane, publishes a per-lane watermark, rejects writes", async () => {
    const loaded = await loadFunctionsDir(FIXTURE);
    const bucketDir = `${ROOT}/bucket`;
    const bucket = `file://${bucketDir}`;
    const channels = ["b3", "b4", "b1"];
    expect(new Set(channels.map((c) => shardIdForKeyValue(c, 3))).size).toBe(3); // three distinct lanes

    const writer = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/writer/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      objectStoreWriterId: "w",
      objectStoreShards: 3,
    });
    await writer.runtime.run("messages:send", { channelId: "b3", body: "m3" });
    await writer.runtime.run("messages:send", { channelId: "b4", body: "m4" });
    await writer.runtime.run("messages:send", { channelId: "b1", body: "m1" });

    const replica = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/replica/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      replica: true,
      objectStoreReplicaConsumerId: "rep-ms",
      objectStoreReplicaPollMs: 80,
    });
    try {
      // (a) reads every lane's channel through the composite (b4→s1, b1→s2 are the non-default lanes)
      for (const [ch, body] of [
        ["b3", "m3"],
        ["b4", "m4"],
        ["b1", "m1"],
      ] as const) {
        const rows = (await replica.runtime.run("messages:list", { channelId: ch })).value as Array<{ body: string }>;
        expect(rows.map((r) => r.body), `channel '${ch}'`).toEqual([body]);
      }
      // (b) each lane published its own watermark (wait out a couple poll cadences)
      await new Promise<void>((r) => setTimeout(r, 300));
      const inspector = new FsObjectStore({ dir: bucketDir });
      for (const shardId of ["default", "s1", "s2"]) {
        const wm = await inspector.list(`s${shardId}/consumers/`);
        expect(wm.length, `lane '${shardId}' watermark`).toBeGreaterThan(0);
      }
      // (c) writes rejected with the read-replica message
      await expect(replica.runtime.run("messages:send", { channelId: "b3", body: "x" })).rejects.toThrow(
        /read replica.*holds no write lease/,
      );
    } finally {
      await replica.objectStoreRelease?.();
      await replica.runtime.stopDrivers();
      await replica.store.close();
      await writer.objectStoreRelease?.();
      await writer.runtime.stopDrivers();
      await writer.store.close();
    }
  });

  it("rejects --writer-url (write-forwarding) on a multi-shard bucket — fails fast, not a latent RYOW bug", async () => {
    const loaded = await loadFunctionsDir(FIXTURE);
    const bucket = `file://${ROOT}/fwd-bucket`;

    // Establish a 3-shard bucket (globals.numShards = 3), then relinquish so the replica can materialize.
    const writer = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/fwd-writer/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucket,
      objectStoreWriterId: "w",
      objectStoreShards: 3,
    });
    await writer.objectStoreRelease?.();
    await writer.runtime.stopDrivers();
    await writer.store.close();

    // A replica over the multi-shard bucket WITH --writer-url must fail fast (forwarding + multi-shard
    // is unsupported — see the guard's comment in boot.ts).
    await expect(
      bootLoaded({
        loaded,
        components: [],
        dataPath: `${ROOT}/fwd-replica/db.sqlite`,
        adminKey: "k",
        objectStoreUrl: bucket,
        replica: true,
        writerUrl: "http://127.0.0.1:9999",
      }),
    ).rejects.toThrow(/write-forwarding.*not yet supported on a multi-shard bucket/);
  });
});
