/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Task 5.1 — `ObjectStoreReplicaTailer` (poll manifest → pull tail segments → apply verbatim → build
 * `AppliedInvalidation` → advance watermark) + `readGlobalFrontier` (design record §7/§8, Tier 3 Slice
 * 5). Mirrors `ee/packages/fleet/test/replica-tailer.test.ts`'s coverage shape, ported to the
 * object-storage substrate: a replica tails a writer's manifest+segments over an fs bucket, applies
 * them verbatim onto a local `SqliteDocStore`, and emits the correct invalidation — no shared database,
 * only the bucket.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@helipod/docstore-sqlite";
import { FsObjectStore } from "@helipod/objectstore-fs";
import type { ObjectStore } from "@helipod/objectstore";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { readGlobalFrontier } from "../src/frontier";
import { ObjectStoreReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";

const TABLE = 30001;

function doc(id: InternalDocumentId, body: string, prevTs: bigint | null = null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: { id, value: { body } } };
}

/** A DELETE (tombstone) commit — `value: null`, per `DocumentLogEntry`'s own contract. */
function del(id: InternalDocumentId, prevTs: bigint | null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: null };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

/** `ObjectStoreDocStore.open` + `acquire()` with a huge TTL — commits require a held lease
 *  (Slice 4, Task 4.2). Mirrors every other test file's `openAndAcquire` helper. */
async function openAndAcquire(
  objectStore: ObjectStore,
  shard: string,
  local: SqliteDocStore,
  writerId = "w",
): Promise<ObjectStoreDocStore> {
  const store = await ObjectStoreDocStore.open({ objectStore, shard, local });
  const result = await store.acquire({ writerId, leaseTtlMs: Number.MAX_SAFE_INTEGER, now: 0 });
  if (!result.acquired) throw new Error(`test setup: acquire() unexpectedly refused (heldBy ${result.heldBy})`);
  return store;
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-replica-tailer-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here (not exported; same note as every other
// test file in this package) so the commit loops below are sized to actually trigger a cadence snapshot.
const SNAPSHOT_EVERY = 8;

describe("ObjectStoreReplicaTailer", () => {
  it("5.1a: tick() applies new segments verbatim, emits the correct AppliedInvalidation, advances the watermark; a second tick with nothing new returns false", async () => {
    const bucket = await freshBucket();
    const writer = await openAndAcquire(bucket, "0", freshLocal());

    const idA = newDocumentId(TABLE);
    const tsA = await writer.commitWrite([doc(idA, "a")], []); // segment 0

    // The replica bootstraps via ObjectStoreDocStore.open() (no acquire) — materializes what the
    // writer has committed SO FAR (doc A only).
    const replicaLocal = freshLocal();
    await ObjectStoreDocStore.open({ objectStore: bucket, shard: "0", local: replicaLocal });
    expect((await replicaLocal.get(idA))?.value.value.body).toBe("a");

    const applied: AppliedInvalidation[] = [];
    const tailer = new ObjectStoreReplicaTailer({
      objectStore: bucket,
      shard: "0",
      local: replicaLocal,
      onInvalidation: async (inv) => {
        applied.push(inv);
      },
    });

    // First tick(): `local` is ALREADY caught up (via the external open() bootstrap) — nothing NEW
    // to apply. The ts-based short-circuit must recognize this without re-deriving an invalidation
    // for data the replica already had before this tailer ever ran.
    expect(await tailer.tick()).toBe(false);
    expect(applied).toEqual([]);
    expect(tailer.appliedMaxTs).toBe(tsA);

    // The writer commits a SECOND batch — genuinely new since the replica's bootstrap.
    const idB = newDocumentId(TABLE);
    const tsB = await writer.commitWrite([doc(idB, "b")], []); // segment 1
    expect(tsB).toBeGreaterThan(tsA);

    expect(await tailer.tick()).toBe(true);
    // Applied verbatim: the replica's own local store now sees it via scan/get.
    const readB = await replicaLocal.get(idB);
    expect(readB).not.toBeNull();
    expect(readB!.value.value.body).toBe("b");

    // Exactly one invalidation, matching the commit tick() actually applied.
    expect(applied.length).toBe(1);
    const inv = applied[0]!;
    expect(inv.newMaxTs).toBe(tsB);
    expect(inv.writtenTables).toEqual([encodeStorageTableId(TABLE)]);
    expect(inv.writtenDocs).toEqual([{ tableId: encodeStorageTableId(TABLE), internalId: idB.internalId }]);
    // The test's own `doc()` helper commits with an empty indexUpdates array (mirrors every other
    // test file in this package — index-write behavior isn't this test's concern), so there are no
    // index rows to report here.
    expect(inv.writtenKeys).toEqual([]);

    expect(tailer.appliedSeqno).toBe(1);
    expect(tailer.appliedMaxTs).toBe(tsB);

    // A second tick() with no new commits → false, no further invalidation.
    expect(await tailer.tick()).toBe(false);
    expect(applied.length).toBe(1);

    await writer.close();
  });

  it("5.1a (bare local): a tailer over a completely fresh, un-bootstrapped local store performs a full catch-up on its first tick", async () => {
    const bucket = await freshBucket();
    const writer = await openAndAcquire(bucket, "0", freshLocal());

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);
    const tsA = await writer.commitWrite([doc(idA, "a")], []);
    const tsB = await writer.commitWrite([doc(idB, "b")], []);

    const replicaLocal = freshLocal(); // NEVER bootstrapped — the tailer must do it all itself
    await replicaLocal.setupSchema(); // schema setup is still the caller's job either way (open()'s own first step)
    const applied: AppliedInvalidation[] = [];
    const tailer = new ObjectStoreReplicaTailer({
      objectStore: bucket,
      shard: "0",
      local: replicaLocal,
      onInvalidation: async (inv) => {
        applied.push(inv);
      },
    });

    expect(await tailer.tick()).toBe(true);
    expect((await replicaLocal.get(idA))?.value.value.body).toBe("a");
    expect((await replicaLocal.get(idB))?.value.value.body).toBe("b");
    expect(applied.length).toBe(1);
    expect(applied[0]!.newMaxTs).toBe(tsB);
    expect(applied[0]!.writtenDocs).toHaveLength(2);
    expect(tailer.appliedMaxTs).toBe(tsB);
    void tsA;

    expect(await tailer.tick()).toBe(false);

    await writer.close();
  });

  it("5.1b: readGlobalFrontier is min(frontierTs) over every shard's manifest, and 0n on a partial (not-fully-initialized) shard set", async () => {
    const bucket = await freshBucket();

    // Neither shard initialized yet.
    expect(await readGlobalFrontier(bucket, ["0", "1"])).toBe(0n);

    const shard0 = await openAndAcquire(bucket, "0", freshLocal(), "w0");
    await shard0.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    await shard0.commitWrite([doc(newDocumentId(TABLE), "y")], []); // shard 0 frontier = 2

    // Only shard 0's manifest exists — a partial set is NOT ready, even though shard 0 alone has a
    // perfectly good frontier.
    expect(await readGlobalFrontier(bucket, ["0", "1"])).toBe(0n);
    // A caller only asking about the shard that DOES exist gets its real frontier.
    expect(await readGlobalFrontier(bucket, ["0"])).toBe(2n);

    const shard1 = await openAndAcquire(bucket, "1", freshLocal(), "w1");
    await shard1.commitWrite([doc(newDocumentId(TABLE), "z")], []); // shard 1 frontier = 1

    // Both present now: min(2, 1) = 1.
    expect(await readGlobalFrontier(bucket, ["0", "1"])).toBe(1n);

    // Advancing shard 1 past shard 0 flips which shard is the min.
    await shard1.commitWrite([doc(newDocumentId(TABLE), "w")], []);
    await shard1.commitWrite([doc(newDocumentId(TABLE), "v")], []); // shard 1 frontier = 3
    expect(await readGlobalFrontier(bucket, ["0", "1"])).toBe(2n); // min(2, 3)

    await shard0.close();
    await shard1.close();
  });

  it("5.1c: snapshot fallback — a replica whose appliedSeqno is below snapshotSegBase re-materializes from the snapshot instead of failing on gc()'d segments, and converges to the writer's current state", async () => {
    const bucket = await freshBucket();
    const writer = await openAndAcquire(bucket, "0", freshLocal());

    // Commit ONE doc, then bootstrap the replica EARLY (before the snapshot threshold) so its
    // appliedSeqno lands at 0 — well below the snapshotSegBase the writer will reach shortly.
    const id0 = newDocumentId(TABLE);
    const ts0 = await writer.commitWrite([doc(id0, "v0")], []); // segment 0

    const replicaLocal = freshLocal();
    await ObjectStoreDocStore.open({ objectStore: bucket, shard: "0", local: replicaLocal });

    const applied: AppliedInvalidation[] = [];
    const tailer = new ObjectStoreReplicaTailer({
      objectStore: bucket,
      shard: "0",
      local: replicaLocal,
      onInvalidation: async (inv) => {
        applied.push(inv);
      },
    });
    // Correlate the tailer to "caught up through ts0 / segment 0" — mirrors 5.1a's first tick.
    expect(await tailer.tick()).toBe(false);
    expect(tailer.appliedSeqno).toBe(0);
    expect(tailer.appliedMaxTs).toBe(ts0);

    // Drive the writer past SNAPSHOT_EVERY total commits (triggers a cadence snapshot whose
    // segBase is well above the replica's appliedSeqno=0), then gc() — this PHYSICALLY DELETES
    // segments 1..segBase, which the replica has never pulled.
    let lastTs = ts0;
    let lastId = id0;
    for (let i = 1; i < SNAPSHOT_EVERY + 2; i++) {
      const id = newDocumentId(TABLE);
      lastTs = await writer.commitWrite([doc(id, `v${i}`)], []);
      lastId = id;
    }
    const gcResult = await writer.gc();
    expect(gcResult.deletedSegments).toBeGreaterThan(0); // segments 1..segBase are now GONE

    // The replica's next tick MUST NOT fail on the now-absent pre-snapshot segments — it falls back
    // to restoring the snapshot, then replays whatever tail remains beyond it.
    expect(await tailer.tick()).toBe(true);

    // Converged: the replica's local store now matches the writer's CURRENT live state exactly.
    const writerScan = await writer.scan(encodeStorageTableId(TABLE));
    const replicaScan = await replicaLocal.scan(encodeStorageTableId(TABLE));
    expect(replicaScan.map((d) => d.value.value.body).sort()).toEqual(writerScan.map((d) => d.value.value.body).sort());
    expect((await replicaLocal.get(lastId))?.value.value.body).toBe(`v${SNAPSHOT_EVERY + 1}`);

    expect(tailer.appliedMaxTs).toBe(lastTs);
    expect(applied.length).toBe(1); // one round, even though it internally restored-from-snapshot + replayed a tail
    expect(applied[0]!.newMaxTs).toBe(lastTs);

    // A further tick with nothing new → false.
    expect(await tailer.tick()).toBe(false);

    await writer.close();
  });

  it("5.1d (regression, Critical review fix): a throwing onInvalidation leaves BOTH cursors unadvanced, and the retry re-delivers the SAME invalidation", async () => {
    const bucket = await freshBucket();
    const writer = await openAndAcquire(bucket, "0", freshLocal());

    const idA = newDocumentId(TABLE);
    const tsA = await writer.commitWrite([doc(idA, "a")], []); // segment 0

    const replicaLocal = freshLocal();
    await ObjectStoreDocStore.open({ objectStore: bucket, shard: "0", local: replicaLocal });

    let shouldThrow = true;
    const applied: AppliedInvalidation[] = [];
    const tailer = new ObjectStoreReplicaTailer({
      objectStore: bucket,
      shard: "0",
      local: replicaLocal,
      onInvalidation: async (inv) => {
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error("sink boom");
        }
        applied.push(inv);
      },
    });

    // Correlate the tailer to "caught up through ts0 / segment 0" — mirrors 5.1a/5.1c's first tick.
    expect(await tailer.tick()).toBe(false);
    expect(tailer.appliedSeqno).toBe(0);
    expect(tailer.appliedMaxTs).toBe(tsA);

    // A genuinely new commit — segment 1.
    const idB = newDocumentId(TABLE);
    const tsB = await writer.commitWrite([doc(idB, "b")], []);
    expect(tsB).toBeGreaterThan(tsA);

    // tick() #1: onInvalidation throws. The whole tick() call must reject — and BOTH cursors must
    // stay exactly where they were before this tick (the bug: appliedSeqno used to advance mid-round,
    // BEFORE the sink ran, so a throw here used to leave it desynced from appliedMaxTs).
    await expect(tailer.tick()).rejects.toThrow("sink boom");
    expect(applied).toEqual([]);
    expect(tailer.appliedSeqno).toBe(0);
    expect(tailer.appliedMaxTs).toBe(tsA);
    // The row IS already in `local` — applying to `local` is idempotent Overwrite and happens before
    // the sink is even invoked. The invariant this test guards is the CURSOR, not physical presence.
    expect((await replicaLocal.get(idB))?.value.value.body).toBe("b");

    // tick() #2: the sink now succeeds. The retry must re-pull from the SAME (unadvanced) cursor,
    // re-apply idempotently, and rebuild + redeliver the IDENTICAL invalidation — not silently skip
    // it via an empty-round short circuit. Only now do both cursors advance, together.
    expect(await tailer.tick()).toBe(true);
    expect(applied.length).toBe(1);
    expect(applied[0]!.newMaxTs).toBe(tsB);
    expect(applied[0]!.writtenDocs).toEqual([{ tableId: encodeStorageTableId(TABLE), internalId: idB.internalId }]);
    expect(tailer.appliedSeqno).toBe(1);
    expect(tailer.appliedMaxTs).toBe(tsB);

    // A further tick with nothing new → false, no further invalidation.
    expect(await tailer.tick()).toBe(false);
    expect(applied.length).toBe(1);

    await writer.close();
  });

  it("5.1e (regression, Finding 1 whole-branch review): a doc deleted in the range a snapshot-restore jumps over must NOT resurrect on the replica, and its deletion must be invalidated", async () => {
    const bucket = await freshBucket();
    const writer = await openAndAcquire(bucket, "0", freshLocal());

    // Two live docs, bootstrapped onto the replica EARLY (before anything is deleted or the
    // snapshot cadence fires) — mirrors 5.1c's "bootstrap early, correlate, then let the writer
    // race ahead of the replica" shape.
    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);
    const tsA = await writer.commitWrite([doc(idA, "a")], []); // segment 0
    const tsB = await writer.commitWrite([doc(idB, "b")], []); // segment 1

    const replicaLocal = freshLocal();
    await ObjectStoreDocStore.open({ objectStore: bucket, shard: "0", local: replicaLocal });
    expect((await replicaLocal.get(idA))?.value.value.body).toBe("a");
    expect((await replicaLocal.get(idB))?.value.value.body).toBe("b");

    const applied: AppliedInvalidation[] = [];
    const tailer = new ObjectStoreReplicaTailer({
      objectStore: bucket,
      shard: "0",
      local: replicaLocal,
      onInvalidation: async (inv) => {
        applied.push(inv);
      },
    });
    // Correlate the tailer to "caught up through tsB / segment 1" — mirrors 5.1c/5.1d's first tick.
    expect(await tailer.tick()).toBe(false);
    expect(tailer.appliedSeqno).toBe(1);
    expect(tailer.appliedMaxTs).toBe(tsB);

    // The writer DELETES A (segment 2), then commits enough filler to trigger the cadence snapshot
    // (SNAPSHOT_EVERY total commits: A, B, delete-A, + 5 filler = 8 → segBase = 7) — the snapshot's
    // live-doc dump therefore EXCLUDES A (tombstoned) entirely; it never mentions A at all.
    await writer.commitWrite([del(idA, tsA)], []); // segment 2
    let lastTs = tsB;
    for (let i = 0; i < SNAPSHOT_EVERY - 3; i++) {
      lastTs = await writer.commitWrite([doc(newDocumentId(TABLE), `filler-${i}`)], []);
    }
    const gcResult = await writer.gc();
    expect(gcResult.deletedSegments).toBeGreaterThan(0); // segments 0..segBase are now GONE

    // The replica's appliedSeqno (1) is well below the new snapshotSegBase (7) — its next tick MUST
    // fall into the snapshot-restore branch (`#materializeRound`'s Finding-1 diff+tombstone path),
    // NOT fail on the now-absent pre-snapshot segments.
    expect(await tailer.tick()).toBe(true);

    // THE ASSERTION: A must be gone on the replica — NOT resurrected by the snapshot overlay, which
    // never mentions A at all (a tombstone can't appear in a dump that excludes tombstones).
    expect(await replicaLocal.get(idA)).toBeNull();
    // B (never deleted, present in the snapshot) must still read live and unaffected.
    expect((await replicaLocal.get(idB))?.value.value.body).toBe("b");

    // The round's invalidation must cover A's deletion too — a `db.get(idA)` subscription must
    // re-run, not go silently stale forever.
    expect(applied.length).toBe(1);
    expect(applied[0]!.writtenDocs).toContainEqual({ tableId: encodeStorageTableId(TABLE), internalId: idA.internalId });
    expect(tailer.appliedMaxTs).toBe(lastTs);

    // A further tick with nothing new → false.
    expect(await tailer.tick()).toBe(false);

    await writer.close();
  });
});
