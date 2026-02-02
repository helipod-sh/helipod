import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { ObjectStoreDocStore } from "../src/object-doc-store";

const TABLE = 30001;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-gc-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function readManifestRaw(os: FsObjectStore): Promise<{ segments: number[]; frontierTs: string; snapshotTs?: string; snapshotSegBase?: number }> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

function seqnoOf(prefix: string, key: string): number {
  return Number(key.slice(prefix.length));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here (not exported; see the same note in
// snapshot-cadence.test.ts) so the test loops are sized to actually trigger cadence snapshots.
const SNAPSHOT_EVERY = 8;

describe("ObjectStoreDocStore.gc", () => {
  it("3.3a: no snapshot yet — gc() is a no-op", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    await store.commitWrite([doc(newDocumentId(TABLE), "a")], []);
    const result = await store.gc();
    expect(result).toEqual({ deletedSegments: 0, deletedSnapshots: 0 });

    // Nothing was deleted — the segment is still there.
    expect(await objectStore.get("s0/seg/0")).not.toBeNull();

    await store.close();
  });

  it("3.3b: deletes segments <= snapshotSegBase, keeps segments > snapshotSegBase, keeps only the newest snapshot, returns correct counts, and a fresh open still materializes full state", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    // First batch: trigger the FIRST cadence snapshot (segBase = SNAPSHOT_EVERY - 1).
    const firstIds: InternalDocumentId[] = [];
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      const id = newDocumentId(TABLE);
      firstIds.push(id);
      await store.commitWrite([doc(id, `first-${i}`)], []);
    }
    const manifestAfterFirstSnap = await readManifestRaw(objectStore);
    expect(manifestAfterFirstSnap.snapshotTs).toBeDefined();
    const firstSnapTs = manifestAfterFirstSnap.snapshotTs!;

    // Second batch: enough MORE commits to trigger a SECOND cadence snapshot, superseding the first.
    const secondIds: InternalDocumentId[] = [];
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      const id = newDocumentId(TABLE);
      secondIds.push(id);
      await store.commitWrite([doc(id, `second-${i}`)], []);
    }
    const manifestAfterSecondSnap = await readManifestRaw(objectStore);
    expect(manifestAfterSecondSnap.snapshotTs).toBeDefined();
    expect(manifestAfterSecondSnap.snapshotTs).not.toBe(firstSnapTs);
    const secondSnapTs = manifestAfterSecondSnap.snapshotTs!;
    const segBase = manifestAfterSecondSnap.snapshotSegBase!;
    expect(segBase).toBe(2 * SNAPSHOT_EVERY - 1); // last committed seqno before the tail below

    // Third batch: a few MORE segments beyond the second snapshot (not enough to trigger a third).
    const tailIds: InternalDocumentId[] = [];
    for (let i = 0; i < 3; i++) {
      const id = newDocumentId(TABLE);
      tailIds.push(id);
      await store.commitWrite([doc(id, `tail-${i}`)], []);
    }

    // Sanity: both snapshots exist pre-GC, and every segment 0..(segBase+3) exists pre-GC.
    expect(await objectStore.get(`s0/snap/${firstSnapTs}`)).not.toBeNull();
    expect(await objectStore.get(`s0/snap/${secondSnapTs}`)).not.toBeNull();
    const segPrefix = "s0/seg/";
    const preGcSegKeys = await objectStore.list(segPrefix);
    const preGcSeqnos = preGcSegKeys.map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(preGcSeqnos).toEqual(Array.from({ length: segBase + 1 + 3 }, (_, i) => i));

    const originalScan = await store.scan(encodeStorageTableId(TABLE));
    expect(originalScan.length).toBe(2 * SNAPSHOT_EVERY + 3);

    // --- gc() ---
    const result = await store.gc();

    // Counts: segments 0..segBase inclusive were deleted (segBase + 1 of them); one stale snapshot
    // (the first) was deleted.
    expect(result.deletedSegments).toBe(segBase + 1);
    expect(result.deletedSnapshots).toBe(1);

    // Segments <= segBase are GONE.
    const postGcSegKeys = await objectStore.list(segPrefix);
    const postGcSeqnos = postGcSegKeys.map((k) => seqnoOf(segPrefix, k));
    for (const seqno of postGcSeqnos) {
      // THE data-loss trap: never delete a seqno > segBase, i.e. every SURVIVING seqno must be > segBase
      // (equivalently: no surviving key has seqno <= segBase).
      expect(seqno).toBeGreaterThan(segBase);
    }
    // And every seqno > segBase from before GC still survives (the tail segments).
    const expectedSurviving = preGcSeqnos.filter((s) => s > segBase).sort((a, b) => a - b);
    expect(postGcSeqnos.sort((a, b) => a - b)).toEqual(expectedSurviving);
    expect(postGcSeqnos.length).toBe(3);

    // Only the current (newest) snapshot remains.
    const snapPrefix = "s0/snap/";
    const postGcSnapKeys = await objectStore.list(snapPrefix);
    expect(postGcSnapKeys).toEqual([`${snapPrefix}${secondSnapTs}`]);
    expect(await objectStore.get(`s0/snap/${firstSnapTs}`)).toBeNull();
    expect(await objectStore.get(`s0/snap/${secondSnapTs}`)).not.toBeNull();

    // The manifest itself is untouched by GC.
    const manifestAfterGc = await readManifestRaw(objectStore);
    expect(manifestAfterGc.snapshotTs).toBe(secondSnapTs);
    expect(manifestAfterGc.snapshotSegBase).toBe(segBase);
    expect(manifestAfterGc.segments.length).toBe(manifestAfterSecondSnap.segments.length + 3);

    // Bootstrap-after-GC still works: a FRESH open over the GC'd bucket materializes the correct
    // full current state (restore newest snapshot + replay the surviving tail only).
    const fresh = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const freshScan = await fresh.scan(encodeStorageTableId(TABLE));
    expect(freshScan.length).toBe(originalScan.length);
    for (const id of [...firstIds, ...secondIds, ...tailIds]) {
      const orig = await store.get(id);
      const restored = await fresh.get(id);
      expect(restored).not.toBeNull();
      expect(restored!.value.value.body).toBe(orig!.value.value.body);
      expect(restored!.ts).toBe(orig!.ts);
    }
    expect(await fresh.maxTimestamp()).toBe(await store.maxTimestamp());

    // gc() is idempotent / safe to re-run: nothing left to reclaim of either kind.
    const secondResult = await fresh.gc();
    expect(secondResult).toEqual({ deletedSegments: 0, deletedSnapshots: 0 });

    await store.close();
    await fresh.close();
  });
});
