import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import type { ObjectStore } from "@stackbase/objectstore";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { FencedError } from "../src/fenced-error";

const TABLE = 30001;

// SNAPSHOT_EVERY is 8 (object-doc-store.ts) — mirrored here (not exported; same note as every other
// test file in this package that needs to drive the cadence snapshot deliberately).
const SNAPSHOT_EVERY = 8;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

/** A DELETE (tombstone) commit — `value: null`, per `DocumentLogEntry`'s own contract. */
function del(id: InternalDocumentId, prevTs: bigint | null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: null };
}

function freshLocal(): SqliteDocStore {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return new SqliteDocStore(isBun ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" }));
}

/** `ObjectStoreDocStore.open` + `acquire()` with a huge TTL (Tier 3 Slice 4, Task 4.2) — commits now
 *  require a held lease, so every test that commits needs this instead of bare `open`. A huge TTL
 *  means the lease never expires within a test's lifetime unless the test explicitly drives `now`
 *  forward past it (the fence tests do that themselves via a second `acquire()` call). */
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

/** A local store whose Nth `write()` call throws (simulates a post-CAS local-apply disk fault), all
 *  other methods delegating to a real SqliteDocStore. */
function throwingWriteLocal(real: SqliteDocStore, throwOnWriteCall: number): SqliteDocStore {
  let n = 0;
  return new Proxy(real, {
    get(target, prop, recv) {
      if (prop === "write") {
        return async (...args: unknown[]) => {
          n += 1;
          if (n >= throwOnWriteCall) throw new Error("simulated local disk fault");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any).write(...args);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as SqliteDocStore;
}
async function readManifestRaw(os: { get: FsObjectStore["get"] }): Promise<{ segments: number[]; frontierTs: string }> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

/** An ObjectStore whose Nth `casPut` LANDS (the underlying write succeeds) and THEN throws a generic
 *  error — simulates a lost response after the CAS was durably applied on an S3-family store. Every
 *  other method delegates to a real FsObjectStore. */
function casLandsThenThrows(real: FsObjectStore, throwOnCasCall: number): ObjectStore {
  let n = 0;
  return new Proxy(real, {
    get(target, prop, recv) {
      if (prop === "casPut") {
        return async (...args: unknown[]) => {
          n += 1;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await (target as any).casPut(...args); // the CAS LANDS (durable)
          if (n >= throwOnCasCall) throw new Error("simulated lost response after CAS landed");
          return res;
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as unknown as ObjectStore;
}

const dirs: string[] = [];
async function freshBucket(): Promise<FsObjectStore> {
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ObjectStoreDocStore", () => {
  it("open on an empty bucket creates the manifest + an empty local store", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    expect(await store.maxTimestamp()).toBe(0n);
    expect(await store.scan(encodeStorageTableId(TABLE))).toEqual([]);

    const manifestEntry = await objectStore.get("s0/manifest");
    expect(manifestEntry).not.toBeNull();
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.body));
    expect(manifest).toEqual({
      epoch: 0,
      frontierTs: "0",
      tsCounter: "0",
      segments: [],
      nextSeqno: 0,
      writerId: "",
      leaseExpiresAt: "0",
    });

    await store.close();
  });

  it("commitWrite of one doc returns ts=1, lands seg/0, advances the manifest, and is visible via get", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    const id = newDocumentId(TABLE);
    const ts = await store.commitWrite([doc(id, "hello")], []);
    expect(ts).toBe(1n);

    const seg0 = await objectStore.get("s0/seg/0");
    expect(seg0).not.toBeNull();

    const manifestEntry = await objectStore.get("s0/manifest");
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.body));
    expect(manifest.frontierTs).toBe("1");
    expect(manifest.tsCounter).toBe("1");
    expect(manifest.segments).toEqual([0]);

    const read = await store.get(id);
    expect(read).not.toBeNull();
    expect(read!.ts).toBe(1n);
    expect(read!.value.value.body).toBe("hello");

    await store.close();
  });

  it("commitWriteBatch stamps strictly-increasing ts per unit and returns them in order", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);
    const tsList = await store.commitWriteBatch([
      { documents: [doc(idA, "a")], indexUpdates: [] },
      { documents: [doc(idB, "b")], indexUpdates: [] },
    ]);
    expect(tsList).toEqual([1n, 2n]);
    expect((await store.get(idA))!.ts).toBe(1n);
    expect((await store.get(idB))!.ts).toBe(2n);

    await store.close();
  });

  it("fence: after a challenger's acquire bumps the epoch, the stale owner's next commit throws FencedError and is poisoned (Tier 3 Slice 4)", async () => {
    // Under the Task 4.2 lease protocol, a well-behaved `acquire()` ALWAYS re-syncs its caller's local
    // `nextSeqno` to the manifest's current frontier first (see `materializeTo`) — so the OLD
    // "a store with a stale nextSeqno reuses an already-consumed seqno" collision this test used to
    // exercise can no longer happen through the acquire() gateway. What replaces it: a challenger's
    // acquire() bumps `epoch` (the fence) WITHOUT the original owner knowing — its next commit attempt
    // finds its cached manifest etag stale and throws `FencedError`.
    const objectStore = await freshBucket();
    const store1 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store1.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const id1 = newDocumentId(TABLE);
    await store1.commitWrite([doc(id1, "first")], []);

    // A different writer ("B") acquires once A's lease has expired (now=2000 > A's leaseExpiresAt=
    // 1000) — a legitimate takeover that bumps the manifest's epoch, fencing store1 without store1
    // knowing yet (its cached epoch is now stale).
    const store2 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store2.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 })).toEqual({ acquired: true });

    // store1, unaware it was fenced, attempts a second commit — the manifest CAS fails (moved etag),
    // throwing FencedError and poisoning the instance.
    const id2 = newDocumentId(TABLE);
    await expect(store1.commitWrite([doc(id2, "second")], [])).rejects.toBeInstanceOf(FencedError);

    // The fenced store is now poisoned AND its held lease cleared (C1 + Finding 2, Task 4.5 — the
    // `held === null` guard is checked before `poisoned`, so the message is now "not the lease owner"
    // rather than "poisoned"; either way a further commit is durably refused).
    await expect(store1.commitWrite([doc(newDocumentId(TABLE), "third")], [])).rejects.toThrow(/not the lease owner/i);

    // The manifest still reflects only store1's first commit, now owned by B at epoch 2 — store1's
    // failed second attempt's segment PUT landed as an unreferenced orphan (reclaiming it is GC's
    // concern, not correctness here), but the manifest itself never names it.
    const manifestEntry = await objectStore.get("s0/manifest");
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.body));
    expect(manifest.segments).toEqual([0]);
    expect(manifest.frontierTs).toBe("1");
    expect(manifest.writerId).toBe("B");
    expect(manifest.epoch).toBe(2);

    // store1's local store never received "second".
    expect(await store1.get(id2)).toBeNull();
    // A fresh store bootstrapped from the bucket only ever sees store1's first commit.
    const store3 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store3.get(id2)).toBeNull();
    expect((await store3.get(id1))!.value.value.body).toBe("first");

    await store1.close();
    await store2.close();
    await store3.close();
  });

  it("bootstrap: a second ObjectStoreDocStore.open over the same bucket materializes the committed doc", async () => {
    const objectStore = await freshBucket();
    const store1 = await openAndAcquire(objectStore, "0", freshLocal());
    const id = newDocumentId(TABLE);
    await store1.commitWrite([doc(id, "durable")], []);
    await store1.close();

    const store2 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const read = await store2.get(id);
    expect(read).not.toBeNull();
    expect(read!.value.value.body).toBe("durable");
    expect(await store2.maxTimestamp()).toBe(1n);

    await store2.close();
  });

  it("reads forward to the local store: setupSchema/write/scan/count/globals work through the decorator", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    expect(await store.writeGlobalIfAbsent("k", "v1")).toBe(true);
    expect(await store.writeGlobalIfAbsent("k", "v2")).toBe(false);
    expect(await store.getGlobal("k")).toBe("v1");
    await store.writeGlobal("k", "v3");
    expect(await store.getGlobal("k")).toBe("v3");

    const id = newDocumentId(TABLE);
    await store.commitWrite([doc(id, "x")], []);
    expect(await store.count(encodeStorageTableId(TABLE))).toBe(1);
    expect((await store.scan(encodeStorageTableId(TABLE))).length).toBe(1);

    await store.close();
  });

  it("commitWriteBatch([]) is a no-op — returns [] and writes no segment (matches SqliteDocStore)", async () => {
    const objectStore = await freshBucket();
    const store = await openAndAcquire(objectStore, "0", freshLocal());
    expect(await store.commitWriteBatch([])).toEqual([]);
    expect(await objectStore.get("s0/seg/0")).toBeNull(); // no segment written
    expect((await readManifestRaw(objectStore)).segments).toEqual([]); // manifest unchanged
    await store.close();
  });

  it("post-CAS-landed generic error poisons the instance (ambiguous-CAS untrustworthy-cursor guard, C1)", async () => {
    // commit #1's casManifest LANDS (durable) then throws a generic error (lost response). Call #1 is
    // open()'s create-only manifest CAS, call #2 is acquire()'s claim CAS (both must succeed), so
    // throw on call #3 — commit #1's own CAS.
    const objectStore = casLandsThenThrows(await freshBucket(), 3);
    const store = await openAndAcquire(objectStore, "0", freshLocal());

    // commit #1: seg/0 PUT, manifest CAS lands durably, then the generic error surfaces → poison + rethrow.
    await expect(store.commitWrite([doc(newDocumentId(TABLE), "a")], [])).rejects.toThrow(/lost response/i);
    // the CAS DID land — the manifest references seg/0 durably.
    expect((await readManifestRaw(objectStore)).segments).toEqual([0]);
    // CRITICAL: the instance must NOT serve another commit off its now-untrustworthy cursor. (Reusing
    // seqno 0 can no longer OVERWRITE a live segment — `putImmutable` is keep-first on every adapter,
    // including S3 via `IfNoneMatch:"*"` — but the cursor itself is still unreliable after an ambiguous
    // CAS, so poisoning + demanding a re-open remains correct.) It is poisoned.
    await expect(store.commitWrite([doc(newDocumentId(TABLE), "b")], [])).rejects.toThrow(/poisoned|re-open/i);
    await store.close();
  });

  it("post-CAS local-apply failure: commit is DURABLE, instance is poisoned, further commits refused", async () => {
    const objectStore = await freshBucket();
    // 2nd write() (commit #2's local apply) throws; open()/acquire()/commit#1's writes succeed first
    // (open/acquire make zero `local.write` calls on a fresh, commit-less bucket).
    const store = await openAndAcquire(objectStore, "0", throwingWriteLocal(freshLocal(), 2));

    await store.commitWrite([doc(newDocumentId(TABLE), "a")], []); // commit #1 — local write #1 ok

    // commit #2: CAS lands (durable), local write #2 throws → poison + a non-retryable "durable but
    // inconsistent" error (NOT a plain retryable failure that would double-commit).
    await expect(store.commitWrite([doc(newDocumentId(TABLE), "b")], [])).rejects.toThrow(/durable/i);
    // the commit IS durable: the manifest advanced and seg/1 exists.
    expect((await readManifestRaw(objectStore)).segments).toEqual([0, 1]);
    expect(await objectStore.get("s0/seg/1")).not.toBeNull();

    // further commits are refused until the store is re-opened.
    await expect(store.commitWrite([doc(newDocumentId(TABLE), "c")], [])).rejects.toThrow(/poisoned|re-opened/i);
    await store.close();
  });

  it("5.5-fix (writer-path regression, Slice 5 re-review): a stale writer instance re-acquiring after another writer deleted+snapshotted+GC'd a doc must NOT resurrect it via materializeTo's catch-up", async () => {
    // The writer-path analog of `replica-tailer.test.ts`'s 5.1e — same hazard (Finding 1, whole-
    // branch review), reached from `acquire()`'s catch-up (`materializeTo`) instead of the tailer's
    // `#materializeRound`. Both now call the shared `applySnapshotState` helper.
    const objectStore = await freshBucket();
    const writer = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const acq1 = await writer.acquire({ writerId: "w1", leaseTtlMs: 1000, now: 0 });
    expect(acq1.acquired).toBe(true);

    const idA = newDocumentId(TABLE);
    const idB = newDocumentId(TABLE);
    const tsA = await writer.commitWrite([doc(idA, "a")], []); // seg 0
    await writer.commitWrite([doc(idB, "b")], []); // seg 1

    // A SEPARATE, already-`open()`'d writer instance whose local store bootstrapped A and B LIVE —
    // simulates a writer process that opened early (but hasn't `acquire()`'d/committed anything of
    // its own yet) when it's about to take over from an incumbent whose lease has since expired.
    const staleLocal = freshLocal();
    const stale = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: staleLocal });
    expect((await staleLocal.get(idA))?.value.value.body).toBe("a");
    expect((await staleLocal.get(idB))?.value.value.body).toBe("b");

    // The live writer deletes A, then commits enough filler to trigger the cadence snapshot
    // (A, B, delete-A + 5 filler = 8 commits -> segBase = 7) — the snapshot's live-doc dump
    // therefore EXCLUDES A entirely. GC then reclaims the pre-snapshot segments.
    await writer.commitWrite([del(idA, tsA)], []); // seg 2
    for (let i = 0; i < SNAPSHOT_EVERY - 3; i++) {
      await writer.commitWrite([doc(newDocumentId(TABLE), `filler-${i}`)], []);
    }
    const gcResult = await writer.gc();
    expect(gcResult.deletedSegments).toBeGreaterThan(0); // pre-snapshot segments are GONE

    // Take over: the incumbent's short lease (ttl 1000, claimed at now=0) has long expired by
    // now=2000, so a DIFFERENT writerId may claim it. `acquire()`'s catch-up calls `materializeTo`
    // against the fresh (post-snapshot, post-GC) manifest onto `staleLocal`, which is NON-EMPTY and
    // still has A live from its own earlier `open()` bootstrap.
    const acq2 = await stale.acquire({ writerId: "w2", leaseTtlMs: 1000, now: 2000 });
    expect(acq2.acquired).toBe(true);

    // THE ASSERTION: A must be gone on the taking-over writer's own local store — NOT resurrected by
    // the snapshot overlay (which never mentions A). Left unfixed, `stale` could re-commit A next,
    // permanently undoing the delete in the durable log.
    expect(await staleLocal.get(idA)).toBeNull();
    expect((await staleLocal.get(idB))?.value.value.body).toBe("b");

    await writer.close();
    await stale.close();
  });
});
