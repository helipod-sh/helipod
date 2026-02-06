/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 4.2 — the manifest lease + acquire/heartbeat/commit-gating protocol (design record §4/§7,
 * Tier 3 Slice 4). Four scenarios (plan's 4.2a-d): a fresh acquire succeeds and unblocks commits; an
 * expired lease is fenceable by a challenger, whose epoch bump poisons the stale owner's next
 * commit/heartbeat; a LIVE lease refuses a different writer's acquire; a heartbeat renews the lease so
 * a challenger against the OLD expiry is refused.
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
import { FencedError } from "../src/fenced-error";
import type { Manifest } from "../src/manifest";

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
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-lease-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

async function readManifestRaw(os: FsObjectStore): Promise<Manifest> {
  const e = await os.get("s0/manifest");
  return JSON.parse(new TextDecoder().decode(e!.body));
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("ObjectStoreDocStore lease protocol (Tier 3 Slice 4, Task 4.2)", () => {
  it("4.2a: open + acquire on a fresh shard succeeds; a commit then works; the manifest shows writerId, a future leaseExpiresAt, epoch===1", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    const result = await store.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 });
    expect(result).toEqual({ acquired: true });

    const manifestAfterAcquire = await readManifestRaw(objectStore);
    expect(manifestAfterAcquire.writerId).toBe("A");
    expect(manifestAfterAcquire.leaseExpiresAt).toBe("1000");
    expect(Number(manifestAfterAcquire.leaseExpiresAt)).toBeGreaterThan(0);
    expect(manifestAfterAcquire.epoch).toBe(1);

    const id = newDocumentId(TABLE);
    const ts = await store.commitWrite([doc(id, "hello")], []);
    expect(ts).toBe(1n);
    expect((await store.get(id))!.value.value.body).toBe("hello");

    // The commit doesn't touch the lease fields — still A/epoch 1.
    const manifestAfterCommit = await readManifestRaw(objectStore);
    expect(manifestAfterCommit.writerId).toBe("A");
    expect(manifestAfterCommit.epoch).toBe(1);
    expect(manifestAfterCommit.leaseExpiresAt).toBe("1000");

    await store.close();
  });

  it("4.2b: the fence — a challenger's acquire past the owner's leaseExpiresAt bumps epoch/writerId; the stale owner's next commit AND heartbeat throw FencedError and poison it; the challenger commits fine", async () => {
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const idA = newDocumentId(TABLE);
    await storeA.commitWrite([doc(idA, "from-a")], []);

    // A challenger opens fresh (bootstraps A's commit) and acquires PAST A's leaseExpiresAt (1000).
    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const acquireB = await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 });
    expect(acquireB).toEqual({ acquired: true });

    const manifestAfterB = await readManifestRaw(objectStore);
    expect(manifestAfterB.epoch).toBe(2);
    expect(manifestAfterB.writerId).toBe("B");

    // B already sees A's committed row (acquire's catch-up materialized it before claiming).
    expect((await storeB.get(idA))!.value.value.body).toBe("from-a");

    // A, unaware it was fenced, throws FencedError on its next commit AND is poisoned.
    const idA2 = newDocumentId(TABLE);
    await expect(storeA.commitWrite([doc(idA2, "second-from-a")], [])).rejects.toBeInstanceOf(FencedError);
    await expect(storeA.commitWrite([doc(newDocumentId(TABLE), "third-from-a")], [])).rejects.toThrow(/poisoned|re-open/i);

    // B's own commit (the actual current owner) still succeeds.
    const idB = newDocumentId(TABLE);
    await storeB.commitWrite([doc(idB, "from-b")], []);
    expect((await storeB.get(idB))!.value.value.body).toBe("from-b");

    // The SAME fence mechanism also trips a stale owner's heartbeat, not just its commit: D acquires
    // (fencing B), then E acquires past D's lease (fencing D) — D's heartbeat throws FencedError and
    // poisons it, exactly like A's commit did above.
    const storeD = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeD.acquire({ writerId: "D", leaseTtlMs: 100, now: 5000 })).toEqual({ acquired: true }); // now=5000 > B's expiresAt=3000
    const storeE = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeE.acquire({ writerId: "E", leaseTtlMs: 100, now: 6000 })).toEqual({ acquired: true }); // fences D
    await expect(storeD.heartbeat({ now: 6100, leaseTtlMs: 100 })).rejects.toBeInstanceOf(FencedError);
    // heartbeat's fence clears `held` (not just `poisoned`) — a further commit is refused as
    // "not the lease owner", the SAME terminal outcome (must re-`acquire()` to continue).
    await expect(storeD.commitWrite([doc(newDocumentId(TABLE), "from-fenced-d")], [])).rejects.toThrow(/not the lease owner/i);

    await storeA.close();
    await storeB.close();
    await storeD.close();
    await storeE.close();
  });

  it("4.2c: a LIVE lease refuses a different writer's acquire; the incumbent's commit still works; the manifest is unchanged", async () => {
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    // now === leaseExpiresAt (1000) still counts as LIVE per the `now <= leaseExpiresAt` contract.
    const acquireB = await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 1000 });
    expect(acquireB).toEqual({ acquired: false, heldBy: "A", expiresAt: 1000 });

    // B never got a held lease — its own commit is refused (not fenced, just never an owner).
    await expect(storeB.commitWrite([doc(newDocumentId(TABLE), "from-b")], [])).rejects.toThrow(/not the lease owner/i);

    // A's commit still works — untouched by B's refused attempt.
    const idA = newDocumentId(TABLE);
    const ts = await storeA.commitWrite([doc(idA, "from-a")], []);
    expect(ts).toBe(1n);

    const manifest = await readManifestRaw(objectStore);
    expect(manifest.writerId).toBe("A");
    expect(manifest.epoch).toBe(1);
    expect(manifest.leaseExpiresAt).toBe("1000");

    await storeA.close();
    await storeB.close();
  });

  it("4.2d: heartbeat renews the lease — a challenger against the OLD expiry is refused", async () => {
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    await storeA.heartbeat({ now: 500, leaseTtlMs: 1000 });
    const manifestAfterHeartbeat = await readManifestRaw(objectStore);
    expect(manifestAfterHeartbeat.leaseExpiresAt).toBe("1500");
    expect(manifestAfterHeartbeat.epoch).toBe(1); // heartbeat never bumps epoch
    expect(manifestAfterHeartbeat.writerId).toBe("A");

    // now=1200 is PAST the ORIGINAL leaseExpiresAt (1000) but still <= the RENEWED one (1500) — a
    // challenger must be refused, proving the heartbeat's renewal is what's actually enforced.
    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const acquireB = await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 1200 });
    expect(acquireB).toEqual({ acquired: false, heldBy: "A", expiresAt: 1500 });

    // A, still the legitimate owner, keeps committing/heartbeating fine.
    await storeA.commitWrite([doc(newDocumentId(TABLE), "from-a")], []);
    await storeA.heartbeat({ now: 1400, leaseTtlMs: 1000 });
    const finalManifest = await readManifestRaw(objectStore);
    expect(finalManifest.leaseExpiresAt).toBe("2400");
    expect(finalManifest.writerId).toBe("A");

    await storeA.close();
    await storeB.close();
  });
});
