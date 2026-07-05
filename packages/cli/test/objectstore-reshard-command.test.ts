/**
 * `helipod objectstore reshard` (object-storage reshard, Task R2/R3): arg parsing/gate (R2a, no
 * bucket needed) + the full E2E through the real CLI command and the real boot core (R3): boot a
 * single-shard object-store writer at a channel-sharded fixture, commit messages, stop, reshard the
 * STOPPED bucket 1→3 via the CLI, then fresh-boot WITHOUT `--shards` and prove (a) the node derives
 * 3 lanes from the bucket's persisted `numShards` alone, and (b) every message is still readable,
 * physically relocated to `shardIdForKeyValue(channelId, 3)`'s lane.
 */
import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { FsObjectStore } from "@helipod/objectstore-fs";
import { shardIdForKeyValue } from "@helipod/id-codec";
import { loadFunctionsDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";
import { objectstoreCommand } from "../src/objectstore";

const ROOT = "./.tmp-objectstore-reshard-cmd";
const FIXTURE = "test/fixtures/shard-dev/helipod";
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

/** Capture everything the command writes to stdout/stderr while it runs. */
async function captureRun(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout.write as unknown) = (chunk: string | Uint8Array) => ((out += chunk.toString()), true);
  (process.stderr.write as unknown) = (chunk: string | Uint8Array) => ((err += chunk.toString()), true);
  try {
    const code = await fn();
    return { code, out, err };
  } finally {
    (process.stdout.write as unknown) = origOut;
    (process.stderr.write as unknown) = origErr;
  }
}

describe("objectstoreCommand — R2a arg parsing / gate (no bucket needed)", () => {
  const savedEnv = process.env.HELIPOD_OBJECT_STORE;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HELIPOD_OBJECT_STORE;
    else process.env.HELIPOD_OBJECT_STORE = savedEnv;
  });

  it("unknown subcommand → usage error + exit 1", async () => {
    const { code, err } = await captureRun(() => objectstoreCommand(["bogus"]));
    expect(code).toBe(1);
    expect(err).toMatch(/unknown `objectstore` subcommand/);
  });

  it("absent subcommand → usage error + exit 1", async () => {
    const { code } = await captureRun(() => objectstoreCommand([]));
    expect(code).toBe(1);
  });

  it("reshard without --object-store (and no env fallback) → exit 1", async () => {
    delete process.env.HELIPOD_OBJECT_STORE;
    const { code, err } = await captureRun(() => objectstoreCommand(["reshard", "--shards", "3", "--dir", FIXTURE]));
    expect(code).toBe(1);
    expect(err).toMatch(/--object-store/);
  });

  it("reshard without --shards → exit 1", async () => {
    const { code, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${ROOT}/x`, "--dir", FIXTURE]),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/--shards/);
  });

  it("reshard with --shards 0 → exit 1", async () => {
    const { code, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${ROOT}/x`, "--dir", FIXTURE, "--shards", "0"]),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/positive integer/);
  });

  it("reshard with a non-integer --shards → exit 1", async () => {
    const { code, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${ROOT}/x`, "--dir", FIXTURE, "--shards", "abc"]),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/positive integer/);
  });

  it("a recognized flag with no trailing value → clean ✗ + exit 1 (never a silent fall-through)", async () => {
    const { code, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${ROOT}/x`, "--shards", "3", "--dir"]),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/--dir requires a value/);
  });

  it("reshard against a non-existent bucket → clean ✗ + exit 1 (no `globals` object)", async () => {
    const { code, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", `file://${ROOT}/empty-bucket`, "--dir", FIXTURE, "--shards", "3"]),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/^✗ /);
    expect(err).toMatch(/not an object-storage deployment/);
  });
});

describe("objectstoreCommand reshard — R3 full E2E (boot → commit → reshard → fresh boot reads)", () => {
  it("reshards a stopped single-shard bucket 1→3 by the fixture's channelId shard key; a fresh node derives 3 lanes and reads everything", async () => {
    const loaded = await loadFunctionsDir(FIXTURE);
    const bucketDir = `${ROOT}/bucket`;
    const bucketUrl = `file://${bucketDir}`;

    // Three channels that route to three DISTINCT lanes at M=3 (asserted, not assumed) so the reshard
    // genuinely spreads docs — plus a second message in one channel to prove multi-doc-per-channel.
    const channels = ["b3", "b4", "b1"];
    const lanes = channels.map((c) => shardIdForKeyValue(c, 3));
    expect(new Set(lanes).size).toBe(3); // b3→default, b4→s1, b1→s2 — all different

    // 1. Boot a single-shard writer and commit the messages (all land on the born-single "0" lane).
    const nodeA = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/node-a/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucketUrl,
      objectStoreWriterId: "node-a",
    });
    await nodeA.runtime.run("messages:send", { channelId: "b3", body: "hello3-a" });
    await nodeA.runtime.run("messages:send", { channelId: "b3", body: "hello3-b" });
    await nodeA.runtime.run("messages:send", { channelId: "b4", body: "hello4" });
    await nodeA.runtime.run("messages:send", { channelId: "b1", body: "hello1" });
    // Single-node reads work (sanity) before the reshard.
    expect(((await nodeA.runtime.run("messages:list", { channelId: "b3" })).value as unknown[]).length).toBe(2);
    await nodeA.objectStoreRelease?.();
    await nodeA.runtime.stopDrivers();
    await nodeA.store.close();

    // 2. Reshard the STOPPED bucket 1→3 through the real CLI command.
    const { code, out, err } = await captureRun(() =>
      objectstoreCommand(["reshard", "--object-store", bucketUrl, "--dir", FIXTURE, "--shards", "3"]),
    );
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(/✓ resharded 1 → 3 shard\(s\)/);
    expect(out).toMatch(/moved 4 doc\(s\)/); // all 4 leave the "0" lane

    // The bucket now advertises 3 shards; the born-single "0" lane is gone, the 3 canonical lanes exist.
    const inspector = new FsObjectStore({ dir: bucketDir });
    expect(await inspector.get("s0/manifest")).toBeNull();
    for (const shardId of ["default", "s1", "s2"]) {
      expect(await inspector.get(`s${shardId}/manifest`), `lane '${shardId}'`).not.toBeNull();
    }

    // 3. Fresh boot WITH NO `--shards`: the node must derive 3 lanes from the bucket's persisted
    //    numShards alone (the reconciliation contract). Fresh local dir → materialize from the bucket.
    const nodeB = await bootLoaded({
      loaded,
      components: [],
      dataPath: `${ROOT}/node-b/db.sqlite`,
      adminKey: "k",
      objectStoreUrl: bucketUrl,
      objectStoreWriterId: "node-b",
      // deliberately NO objectStoreShards — proves the bucket's count is authoritative
    });
    try {
      // Every channel's messages are readable at the 3-shard node (each query routes to the channel's
      // M=3 lane — proving the docs physically moved to the correct lane AND remain queryable).
      expect(((await nodeB.runtime.run("messages:list", { channelId: "b3" })).value as unknown[]).length).toBe(2);
      expect(((await nodeB.runtime.run("messages:list", { channelId: "b4" })).value as unknown[]).length).toBe(1);
      expect(((await nodeB.runtime.run("messages:list", { channelId: "b1" })).value as unknown[]).length).toBe(1);
      const b3 = (await nodeB.runtime.run("messages:list", { channelId: "b3" })).value as Array<{ body: string }>;
      expect(b3.map((r) => r.body).sort()).toEqual(["hello3-a", "hello3-b"]);
    } finally {
      await nodeB.objectStoreRelease?.();
      await nodeB.runtime.stopDrivers();
      await nodeB.store.close();
    }
  });
});
