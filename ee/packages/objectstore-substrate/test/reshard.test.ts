/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Unit tests for `reshardObjectStore` (offline object-storage reshard). Seeds a bucket the way
 * `boot.ts`'s multi-shard writer does — lane bucket prefix = the `shardIdList` id (`sdefault/`,
 * `ss1/`, …), or `s0/` for a born-single-shard deployment — then reshards N→M and asserts each doc
 * lands in `shardIdForKeyValue(doc[shardKey], M)`'s lane, index entries follow, and a live lease is
 * refused with no partial effect.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  newDocumentId,
  encodeStorageIndexId,
  shardIdForKeyValue,
  type InternalDocumentId,
} from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry, IndexWrite, DatabaseIndexUpdate } from "@helipod/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@helipod/docstore-sqlite";
import { FsObjectStore } from "@helipod/objectstore-fs";
import type { ObjectStore } from "@helipod/objectstore";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { readManifest } from "../src/manifest";
import { readGlobals, ensureGlobals } from "../src/globals";
import { reshardObjectStore, ReshardObjectStoreLiveError } from "../src/reshard";

const TABLE = 40001;
const INDEX_ID = encodeStorageIndexId(TABLE, "by_body");
const SHARD_KEY = "body";

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}
const shardKeyFor = (t: number): string | null => (t === TABLE ? SHARD_KEY : null);

function docWith(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}
function indexWith(id: InternalDocumentId, body: string): IndexWrite {
  const update: DatabaseIndexUpdate = { indexId: INDEX_ID, key: encodeIndexKey([body]), value: { type: "NonClustered", docId: id } };
  return { ts: 0n, update };
}

const dirs: string[] = [];
async function freshBucket(): Promise<ObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-reshard-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Seed a lane (bucket prefix = `shard`) with docs (each `{body}` its shard key) + their index rows. */
async function seedLane(os: ObjectStore, shard: string, bodies: string[]): Promise<void> {
  const store = await ObjectStoreDocStore.open({ objectStore: os, shard, local: freshLocal() });
  const acq = await store.acquire({ writerId: `seed-${shard}`, leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!acq.acquired) throw new Error(`seed: acquire refused for lane '${shard}'`);
  const docs: DocumentLogEntry[] = [];
  const index: IndexWrite[] = [];
  for (const body of bodies) {
    const id = newDocumentId(TABLE);
    docs.push(docWith(id, body));
    index.push(indexWith(id, body));
  }
  await store.commitWriteBatch([{ documents: docs, indexUpdates: index }], shard);
  await store.relinquish();
  await store.close();
}

/** Materialize a lane's current state (its live docs' bodies + index entries). */
async function materializeLane(os: ObjectStore, shard: string): Promise<{ bodies: string[]; indexCount: number }> {
  const local = freshLocal();
  await ObjectStoreDocStore.open({ objectStore: os, shard, local });
  const state = await local.dumpCurrentState();
  const bodies = state.documents.map((d) => (d.value?.value as { body: string }).body).sort();
  await local.close();
  return { bodies, indexCount: state.indexUpdates.filter((iw) => iw.update.value.type === "NonClustered").length };
}

describe("reshardObjectStore — offline object-storage reshard", () => {
  it("R1a grow 1→3: docs re-partition to shardIdList(3) lanes by shard key; the '0' lane is gone; globals=3", async () => {
    const os = await freshBucket();
    await ensureGlobals(os, { deploymentId: "dep-1", numShards: 1 });
    // At M=3: shardIdForKeyValue routes "b3"→default, "b4"→s1, "b1"→s2 (verified below, not assumed).
    expect(shardIdForKeyValue("b3", 3)).toBe("default");
    expect(shardIdForKeyValue("b4", 3)).toBe("s1");
    expect(shardIdForKeyValue("b1", 3)).toBe("s2");
    await seedLane(os, "0", ["b3", "b4", "b1"]);

    const result = await reshardObjectStore({ objectStore: os, toShards: 3, now: 1000, shardKeyFor, makeLocal: freshLocal });
    expect(result.fromShards).toBe(1);
    expect(result.toShards).toBe(3);
    expect((await readGlobals(os))!.numShards).toBe(3);

    // Each new lane holds exactly the doc that routes to it at M=3.
    expect((await materializeLane(os, "default")).bodies).toEqual(["b3"]);
    expect((await materializeLane(os, "s1")).bodies).toEqual(["b4"]);
    expect((await materializeLane(os, "s2")).bodies).toEqual(["b1"]);
    // The born-single-shard "0" lane's objects are gone.
    expect(await os.get("s0/manifest")).toBeNull();
  });

  it("R1b shrink 3→1: all docs collapse to the single 'default' lane; s1/s2 gone; globals=1", async () => {
    const os = await freshBucket();
    await ensureGlobals(os, { deploymentId: "dep-1", numShards: 3 });
    // Seed the 3 lanes (shardIdList(3) bucket prefixes) — spread arbitrary docs across them.
    await seedLane(os, "default", ["a", "b"]);
    await seedLane(os, "s1", ["c"]);
    await seedLane(os, "s2", ["d", "e"]);

    const result = await reshardObjectStore({ objectStore: os, toShards: 1, now: 1000, shardKeyFor, makeLocal: freshLocal });
    expect(result.fromShards).toBe(3);
    expect(result.toShards).toBe(1);
    expect((await readGlobals(os))!.numShards).toBe(1);

    // numShards=1 ALWAYS means the single "0" lane (the born-single-shard convention) — everything
    // collapses there; the multi-shard lanes are gone.
    expect((await materializeLane(os, "0")).bodies).toEqual(["a", "b", "c", "d", "e"]);
    expect(await os.get("sdefault/manifest")).toBeNull();
    expect(await os.get("ss1/manifest")).toBeNull();
    expect(await os.get("ss2/manifest")).toBeNull();
  });

  it("R1c refuses a live deployment (a lane holds a live lease) and leaves the bucket UNCHANGED", async () => {
    const os = await freshBucket();
    await ensureGlobals(os, { deploymentId: "dep-1", numShards: 1 });
    // Open + acquire (but DON'T relinquish) → the "0" lane has a live lease.
    const live = await ObjectStoreDocStore.open({ objectStore: os, shard: "0", local: freshLocal() });
    await live.acquire({ writerId: "live-writer", leaseTtlMs: 60_000, now: 500 });
    const before = await readManifest(os, "0");

    await expect(
      reshardObjectStore({ objectStore: os, toShards: 3, now: 1000, shardKeyFor, makeLocal: freshLocal }),
    ).rejects.toBeInstanceOf(ReshardObjectStoreLiveError);

    // No partial reshard: globals still 1, the "0" lane's manifest untouched, no shardIdList lanes created.
    expect((await readGlobals(os))!.numShards).toBe(1);
    expect((await readManifest(os, "0"))!.manifest.epoch).toBe(before!.manifest.epoch);
    expect(await os.get("sdefault/manifest")).toBeNull();
    await live.relinquish();
    await live.close();
  });

  it("R1d index entries follow their docs + values are byte-preserved across the move", async () => {
    const os = await freshBucket();
    await ensureGlobals(os, { deploymentId: "dep-1", numShards: 1 });
    await seedLane(os, "0", ["b3", "b4", "b1"]); // → default, s1, s2 at M=3

    await reshardObjectStore({ objectStore: os, toShards: 3, now: 1000, shardKeyFor, makeLocal: freshLocal });

    // Each lane's single doc carries its live index entry (indexCount === docCount) + its exact value.
    for (const [lane, body] of [["default", "b3"], ["s1", "b4"], ["s2", "b1"]] as const) {
      const mat = await materializeLane(os, lane);
      expect(mat.bodies).toEqual([body]);
      expect(mat.indexCount).toBe(1); // the doc's NonClustered index entry moved with it
    }
  });

  it("R1e no-op when already at the target shard count", async () => {
    const os = await freshBucket();
    await ensureGlobals(os, { deploymentId: "dep-1", numShards: 3 });
    await seedLane(os, "default", ["x"]);
    const result = await reshardObjectStore({ objectStore: os, toShards: 3, now: 1000, shardKeyFor, makeLocal: freshLocal });
    expect(result).toEqual({ fromShards: 3, toShards: 3, movedDocs: 0, perLaneCounts: {} });
    expect((await materializeLane(os, "default")).bodies).toEqual(["x"]); // untouched
  });
});
