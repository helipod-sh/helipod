/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 7.1 — gc-fencing (design record §6c, Tier 3 Slice 7): `gc()` must abort (delete NOTHING)
 * unless it re-verifies it still owns the CURRENT lease epoch, and must only ever delete snapshots
 * strictly older than the current `keepSnap` — closing the Slice-4/5/6 deferred data-availability
 * hazard where a stale/fenced writer's `gc()` could delete the live owner's snapshot.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@stackbase/id-codec";
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

async function openAndAcquire(
  objectStore: FsObjectStore,
  shard: string,
  local: SqliteDocStore,
  opts: { writerId: string; leaseTtlMs: number; now: number },
): Promise<ObjectStoreDocStore> {
  const store = await ObjectStoreDocStore.open({ objectStore, shard, local });
  const result = await store.acquire(opts);
  if (!result.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${result.heldBy})`);
  return store;
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-gc-fencing-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function readManifestRaw(os: FsObjectStore): Promise<{ segments: number[]; frontierTs: string; snapshotTs?: string; snapshotSegBase?: number; epoch: number }> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here, same note as gc.test.ts.
const SNAPSHOT_EVERY = 8;

describe("ObjectStoreDocStore.gc — fencing (Tier 3 Slice 7, Task 7.1)", () => {
  it("7.1a: THE fence — a stale writer's gc() re-reads, sees it was fenced, deletes NOTHING (the new owner's live snapshot survives) and poisons itself", async () => {
    const objectStore = await freshBucket();

    // A acquires and commits enough to trigger its own cadence snapshot (T1).
    const storeA = await openAndAcquire(objectStore, "0", freshLocal(), { writerId: "A", leaseTtlMs: 1000, now: 0 });
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await storeA.commitWrite([doc(newDocumentId(TABLE), `a-${i}`)], []);
    }
    const manifestAfterA = await readManifestRaw(objectStore);
    expect(manifestAfterA.snapshotTs).toBeDefined();
    const snapT1 = manifestAfterA.snapshotTs!;

    // B fences A (acquires past A's lease expiry, bumping epoch) and commits enough to trigger a
    // SECOND cadence snapshot (T2) — the bucket now holds snap/T1 AND snap/T2, with T2 current.
    const storeB = await openAndAcquire(objectStore, "0", freshLocal(), { writerId: "B", leaseTtlMs: 1000, now: 2000 });
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await storeB.commitWrite([doc(newDocumentId(TABLE), `b-${i}`)], []);
    }
    const manifestAfterB = await readManifestRaw(objectStore);
    expect(manifestAfterB.snapshotTs).toBeDefined();
    expect(manifestAfterB.snapshotTs).not.toBe(snapT1);
    const snapT2 = manifestAfterB.snapshotTs!;
    expect(manifestAfterB.epoch).toBeGreaterThan(0);

    // Sanity: both snapshots exist pre-gc.
    expect(await objectStore.get(`s0/snap/${snapT1}`)).not.toBeNull();
    expect(await objectStore.get(`s0/snap/${snapT2}`)).not.toBeNull();

    // A, stale (still thinks it owns the OLD epoch, cached snapshotTs=T1), calls gc().
    const result = await storeA.gc();
    expect(result).toEqual({ deletedSegments: 0, deletedSnapshots: 0 });

    // Nothing was deleted — THE data-availability bug this fix closes: snap/T2 (the live owner's
    // snapshot) still exists, and so does snap/T1 (A never got to delete anything).
    expect(await objectStore.get(`s0/snap/${snapT1}`)).not.toBeNull();
    expect(await objectStore.get(`s0/snap/${snapT2}`)).not.toBeNull();

    // A's next commit attempt confirms it is now poisoned/demoted (the epoch mismatch fenced it).
    await expect(storeA.commitWrite([doc(newDocumentId(TABLE), "zombie")], [])).rejects.toThrow();

    // B (the live owner) can still gc() normally and reclaim the superseded snapshot/segments.
    const bResult = await storeB.gc();
    expect(bResult.deletedSnapshots).toBe(1);
    expect(await objectStore.get(`s0/snap/${snapT1}`)).toBeNull();
    expect(await objectStore.get(`s0/snap/${snapT2}`)).not.toBeNull();

    await storeA.close();
    await storeB.close();
  });

  it("7.1b: strictly-older snapshot deletion — gc() deletes only snap < keepSnap, keeps keepSnap, and never deletes a snapshot >= keepSnap even if one is artificially present", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal(), { writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });

    // Trigger a first cadence snapshot (T1).
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `first-${i}`)], []);
    }
    const afterFirst = await readManifestRaw(objectStore);
    const snapT1 = afterFirst.snapshotTs!;

    // Trigger a second cadence snapshot (T2, current/keepSnap).
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `second-${i}`)], []);
    }
    const afterSecond = await readManifestRaw(objectStore);
    const keepSnap = afterSecond.snapshotTs!;
    expect(keepSnap).not.toBe(snapT1);

    // Artificially plant a snapshot object with a ts NUMERICALLY GREATER than keepSnap (simulating a
    // new owner's snapshot that raced ahead in a TOCTOU gap) — gc() must NEVER delete it, even though
    // it isn't the manifest's OWN `keepSnap`. `writeSnapshot` isn't used directly here; we just need
    // an object under the snap/ prefix whose key parses as ts >= keepSnap.
    const futureTs = (BigInt(keepSnap) + 1000n).toString();
    await objectStore.putImmutable(`s0/snap/${futureTs}`, new TextEncoder().encode(JSON.stringify({ frontierTs: futureTs, segBase: 0, documents: [], indexUpdates: [] })));

    const result = await store.gc();

    // Only snapT1 (strictly older) was deleted.
    expect(result.deletedSnapshots).toBe(1);
    expect(await objectStore.get(`s0/snap/${snapT1}`)).toBeNull();
    // keepSnap itself survives (never deleted, even though it's not "< keepSnap").
    expect(await objectStore.get(`s0/snap/${keepSnap}`)).not.toBeNull();
    // The artificially-future snapshot (>= keepSnap) survives too — never deleted.
    expect(await objectStore.get(`s0/snap/${futureTs}`)).not.toBeNull();

    // gc() again is a no-op: nothing left strictly older than keepSnap.
    const second = await store.gc();
    expect(second.deletedSnapshots).toBe(0);

    await store.close();
  });

  it("7.1c: a non-owner (open() without acquire()) — gc() returns zeros and deletes nothing", async () => {
    const objectStore = await freshBucket();

    // A real owner commits + snapshots so there IS something a mis-fenced gc() could otherwise reclaim.
    const owner = await openAndAcquire(objectStore, "0", freshLocal(), { writerId: "owner", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
    for (let i = 0; i < SNAPSHOT_EVERY + 2; i++) {
      await owner.commitWrite([doc(newDocumentId(TABLE), `v${i}`)], []);
    }
    const manifestBefore = await readManifestRaw(objectStore);
    expect(manifestBefore.snapshotTs).toBeDefined();

    // A replica-style instance: open() WITHOUT acquire() — held stays null.
    const replica = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    const result = await replica.gc();
    expect(result).toEqual({ deletedSegments: 0, deletedSnapshots: 0 });

    // Nothing changed in the bucket.
    const manifestAfter = await readManifestRaw(objectStore);
    expect(manifestAfter).toEqual(manifestBefore);
    expect(await objectStore.get(`s0/snap/${manifestBefore.snapshotTs}`)).not.toBeNull();

    await owner.close();
    await replica.close();
  });
});
