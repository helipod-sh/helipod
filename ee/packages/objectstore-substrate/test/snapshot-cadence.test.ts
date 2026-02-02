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
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

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
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

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
