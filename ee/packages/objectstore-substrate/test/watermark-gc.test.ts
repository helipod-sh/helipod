/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 5.2 — watermark-aware GC (design record §6c, Tier 3 Slice 5): `gc()` floors deletion at the
 * slowest published `consumers/{id}` watermark, never stranding a lagging replica, and degrades
 * exactly to Slice 3's behavior when no consumers are registered.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { publishConsumerWatermark, readConsumerWatermarks, removeConsumer } from "../src/consumers";

const TABLE = 30001;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

async function openAndAcquire(objectStore: FsObjectStore, shard: string, local: SqliteDocStore): Promise<ObjectStoreDocStore> {
  const store = await ObjectStoreDocStore.open({ objectStore, shard, local });
  const result = await store.acquire({ writerId: "w", leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!result.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${result.heldBy})`);
  return store;
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-watermark-gc-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

function seqnoOf(prefix: string, key: string): number {
  return Number(key.slice(prefix.length));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here (not exported; same note as gc.test.ts)
// so the commit loop below is sized to actually trigger a cadence snapshot.
const SNAPSHOT_EVERY = 8;

describe("ObjectStoreDocStore.gc — watermark floor (Task 5.2)", () => {
  it("5.2a: a lagging consumer's watermark floors deletion below snapshotSegBase; advancing/removing it lets a second gc() reclaim the rest", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    // Trigger the cadence snapshot: segBase = SNAPSHOT_EVERY - 1 = 7.
    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `snap-${i}`)], []);
    }
    // A tail beyond the snapshot (not enough to trigger a second snapshot).
    for (let i = 0; i < 3; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `tail-${i}`)], []);
    }

    const segPrefix = "s0/seg/";
    const preGcSeqnos = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(preGcSeqnos).toEqual(Array.from({ length: 11 }, (_, i) => i)); // 0..10

    // A lagging consumer at seqno 3 — well below segBase (7).
    const consumerId = "replica-1";
    await publishConsumerWatermark(objectStore, "0", consumerId, { appliedSeqno: 3 });
    expect(await readConsumerWatermarks(objectStore, "0")).toEqual([{ consumerId, appliedSeqno: 3 }]);

    // --- first gc(): floor = min(segBase=7, W_min=3) = 3 ---
    const firstResult = await store.gc();
    expect(firstResult.deletedSegments).toBe(4); // seqnos 0,1,2,3
    expect(firstResult.deletedSnapshots).toBe(0); // only one snapshot ever taken

    const afterFirstGc = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    // The lagging consumer's window (3, 7] MUST survive, along with the tail (8,9,10).
    expect(afterFirstGc).toEqual([4, 5, 6, 7, 8, 9, 10]);

    // gc() again with the SAME lagging watermark is a no-op — nothing new below the floor.
    const secondResult = await store.gc();
    expect(secondResult).toEqual({ deletedSegments: 0, deletedSnapshots: 0 });

    // Advance the consumer past segBase — the watermark floor no longer binds; a third gc()
    // reclaims exactly what remains at/below segBase (7): seqnos 4,5,6,7.
    await publishConsumerWatermark(objectStore, "0", consumerId, { appliedSeqno: 100 });
    const thirdResult = await store.gc();
    expect(thirdResult.deletedSegments).toBe(4);
    const afterThirdGc = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(afterThirdGc).toEqual([8, 9, 10]);

    await store.close();
  });

  it("5.2a-remove: removing the lagging consumer (instead of advancing it) also lets a second gc() reclaim up to segBase", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `snap-${i}`)], []);
    }
    for (let i = 0; i < 2; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `tail-${i}`)], []);
    }

    const consumerId = "replica-2";
    await publishConsumerWatermark(objectStore, "0", consumerId, { appliedSeqno: 2 });

    const segPrefix = "s0/seg/";
    const first = await store.gc();
    expect(first.deletedSegments).toBe(3); // 0,1,2
    let remaining = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(remaining).toEqual([3, 4, 5, 6, 7, 8, 9]);

    await removeConsumer(objectStore, "0", consumerId);
    expect(await readConsumerWatermarks(objectStore, "0")).toEqual([]);

    const second = await store.gc();
    expect(second.deletedSegments).toBe(5); // 3,4,5,6,7 (up to segBase=7)
    remaining = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(remaining).toEqual([8, 9]);

    await store.close();
  });

  it("5.2b: no consumers registered — gc() behaves identically to Slice 3 (floor = snapshotSegBase)", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    for (let i = 0; i < SNAPSHOT_EVERY; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `snap-${i}`)], []);
    }
    for (let i = 0; i < 3; i++) {
      await store.commitWrite([doc(newDocumentId(TABLE), `tail-${i}`)], []);
    }

    expect(await readConsumerWatermarks(objectStore, "0")).toEqual([]); // no consumers published

    const segPrefix = "s0/seg/";
    const result = await store.gc();
    expect(result.deletedSegments).toBe(SNAPSHOT_EVERY); // seqnos 0..7 (segBase)

    const remaining = (await objectStore.list(segPrefix)).map((k) => seqnoOf(segPrefix, k)).sort((a, b) => a - b);
    expect(remaining).toEqual([8, 9, 10]);

    await store.close();
  });
});
