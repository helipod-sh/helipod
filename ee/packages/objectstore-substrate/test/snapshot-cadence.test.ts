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

/** `ObjectStoreDocStore.open` + `acquire()` with a huge TTL (Tier 3 Slice 4, Task 4.2) — commits now
 *  require a held lease. */
async function openAndAcquire(objectStore: FsObjectStore, shard: string, local: SqliteDocStore): Promise<ObjectStoreDocStore> {
  const store = await ObjectStoreDocStore.open({ objectStore, shard, local });
  const result = await store.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!result.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${result.heldBy})`);
  return store;
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-snap-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function readManifestRaw(os: FsObjectStore): Promise<{ segments: number[]; frontierTs: string; snapshotTs?: string; snapshotSegBase?: number }> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here so the test stays self-documenting if
// the constant ever moves; NOT imported (it's not exported — cadence is an implementation detail
// the caller shouldn't depend on beyond "it happens periodically").
const SNAPSHOT_EVERY = 8;

describe("ObjectStoreDocStore snapshot cadence + fast bootstrap", () => {
  it("3.2a: cadence writes a snapshot object and records it on the manifest, state unchanged", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    const ids: InternalDocumentId[] = [];
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      const id = newDocumentId(TABLE);
      ids.push(id);
      await store.commitWrite([doc(id, `doc-${i}`)], []);
    }

    // Best-effort cadence snapshot fires inside commitWriteBatch after the exclusive block — give
    // it a moment (it's async but already awaited by commitWrite; no extra wait should be needed).
    const manifest = await readManifestRaw(objectStore);
    expect(manifest.snapshotTs).toBeDefined();
    expect(manifest.snapshotSegBase).toBe(SNAPSHOT_EVERY - 1); // last committed seqno

    const snapEntry = await objectStore.get(`s0/snap/${manifest.snapshotTs}`);
    expect(snapEntry).not.toBeNull();

    // State is unchanged by the snapshot — every committed doc is still readable, scan matches count.
    for (const id of ids) {
      expect(await store.get(id)).not.toBeNull();
    }
    expect((await store.scan(encodeStorageTableId(TABLE))).length).toBe(SNAPSHOT_EVERY);

    await store.close();
  });

  it("3.2b: fast-bootstrap proof — a fresh open materializes full state from snapshot + tail alone, pre-snapshot segments deleted", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    // Commit enough to trigger a snapshot.
    const preIds: InternalDocumentId[] = [];
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      const id = newDocumentId(TABLE);
      preIds.push(id);
      await store.commitWrite([doc(id, `pre-${i}`)], []);
    }
    const manifestAfterSnap = await readManifestRaw(objectStore);
    expect(manifestAfterSnap.snapshotTs).toBeDefined();
    const snapshotSegBase = manifestAfterSnap.snapshotSegBase!;

    // Commit more — a tail beyond the snapshot (not enough to trigger a second snapshot).
    const tailIds: InternalDocumentId[] = [];
    for (let i = 0; i < 3; i++) {
      const id = newDocumentId(TABLE);
      tailIds.push(id);
      await store.commitWrite([doc(id, `tail-${i}`)], []);
    }

    const originalScan = await store.scan(encodeStorageTableId(TABLE));
    expect(originalScan.length).toBe(SNAPSHOT_EVERY + 3);

    // Delete every pre-snapshot segment object — bootstrap must not need them.
    const segKeys = await objectStore.list("s0/seg/");
    for (const key of segKeys) {
      const seqno = Number(key.slice("s0/seg/".length));
      if (seqno <= snapshotSegBase) {
        await objectStore.delete(key);
      }
    }
    // Sanity: at least one pre-snapshot segment existed and is now gone, and the tail segment(s) remain.
    expect(await objectStore.get("s0/seg/0")).toBeNull();
    const remainingSegKeys = await objectStore.list("s0/seg/");
    expect(remainingSegKeys.every((k) => Number(k.slice("s0/seg/".length)) > snapshotSegBase)).toBe(true);
    expect(remainingSegKeys.length).toBeGreaterThan(0);

    // A FRESH store, bootstrapped from the bucket with pre-snapshot segments gone, still
    // materializes the full current state (snapshot restore + tail replay only).
    const fresh = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const freshScan = await fresh.scan(encodeStorageTableId(TABLE));
    expect(freshScan.length).toBe(originalScan.length);

    for (const id of [...preIds, ...tailIds]) {
      const orig = await store.get(id);
      const restored = await fresh.get(id);
      expect(restored).not.toBeNull();
      expect(restored!.value.value.body).toBe(orig!.value.value.body);
      expect(restored!.ts).toBe(orig!.ts);
    }
    expect(await fresh.maxTimestamp()).toBe(await store.maxTimestamp());

    await store.close();
    await fresh.close();
  });
});

describe("ObjectStoreDocStore manifest.segments stays bounded (whole-branch review, Task 3.3 fix)", () => {
  it("3.3-fix-a: segments length is bounded to the post-snapshot tail across MANY commits — never grows with total commit count", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    const totalCommits = 3 * SNAPSHOT_EVERY;
    let sawASnapshotTrim = false;
    for (let i = 0; i < totalCommits; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `doc-${i}`)], []);
      const manifest = await readManifestRaw(objectStore);
      // The array must NEVER hold more than a single cadence window's worth of tail entries — in
      // particular it must stay far below `totalCommits` even once we're deep into the run. This is
      // the load-bearing assertion the old unbounded `segments` array (appended forever, trimmed
      // never) would have failed once `i` grew large.
      expect(manifest.segments.length).toBeLessThanOrEqual(SNAPSHOT_EVERY);
      if (manifest.segments.length === 0 && i + 1 >= SNAPSHOT_EVERY) sawASnapshotTrim = true;
    }

    // Sanity: at least one cadence snapshot actually fired and trimmed the array to empty (proves the
    // bound above isn't just "we never committed enough to see growth").
    expect(sawASnapshotTrim).toBe(true);

    // After the full run, the array holds only the tail since the LAST snapshot, not the whole history.
    const finalManifest = await readManifestRaw(objectStore);
    expect(finalManifest.segments.length).toBeLessThan(totalCommits);
    expect(finalManifest.segments.length).toBeLessThanOrEqual(SNAPSHOT_EVERY);

    await store.close();
  });

  it("3.3-fix-b: empty-tail bootstrap — a snapshot covering ALL segments (empty trimmed tail) still yields the correct nextSeqno on fresh open, not 0 (the old Math.max(...[])→0 trap)", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    // Commit EXACTLY SNAPSHOT_EVERY docs so the cadence snapshot fires and covers every committed
    // segment — the trimmed tail is empty (`segments: []`), the exact case `Math.max(...[])` would
    // have thrown/degenerated to 0 for.
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `doc-${i}`)], []);
    }
    const manifestAfterSnap = await readManifestRaw(objectStore);
    expect(manifestAfterSnap.snapshotTs).toBeDefined();
    expect(manifestAfterSnap.snapshotSegBase).toBe(SNAPSHOT_EVERY - 1);
    expect(manifestAfterSnap.segments).toEqual([]); // empty tail — the trap case

    const priorMaxTs = await store.maxTimestamp();
    expect(priorMaxTs).toBe(BigInt(SNAPSHOT_EVERY));
    await store.close();

    // A FRESH open over this exact bucket state must derive nextSeqno = SNAPSHOT_EVERY (from the
    // explicit `nextSeqno` field), NOT 0 (which `Math.max(...cached.manifest.segments)` would have
    // produced against an empty trimmed array).
    const fresh = await openAndAcquire(objectStore, "0", freshLocal());
    expect(await fresh.maxTimestamp()).toBe(priorMaxTs); // bootstrap restored the snapshot correctly

    const nextId = newDocumentId(TABLE);
    const nextTs = await fresh.commitWrite([doc(nextId, "post-bootstrap")], []);

    // ts must continue forward, never regress/collide with the restored state.
    expect(nextTs).toBe(priorMaxTs + 1n);

    // The new segment object must land at seqno = SNAPSHOT_EVERY (the correct next-free cursor) — a
    // buggy `Math.max(...[])→0` bootstrap would instead have written `seg/0`, OVERWRITING (or, on
    // keep-first `objectstore-fs`, silently colliding with) the durable seg/0 the snapshot already
    // superseded, which is exactly the corruption class this fix closes.
    expect(await objectStore.get(`s0/seg/${SNAPSHOT_EVERY}`)).not.toBeNull();
    const manifestAfterNext = await readManifestRaw(objectStore);
    expect(manifestAfterNext.segments).toEqual([SNAPSHOT_EVERY]);

    expect((await fresh.get(nextId))!.ts).toBe(nextTs);

    await fresh.close();
  });
});
