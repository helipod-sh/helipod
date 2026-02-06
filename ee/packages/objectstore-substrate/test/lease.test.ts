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
import { encodeSegment } from "../src/segment";

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
    // A commit-fence now clears `held` too (Finding 2, Task 4.5, symmetric with heartbeat's fence path)
    // — the very next call hits the `held === null` guard (checked before `poisoned`), so it now
    // surfaces as "not the lease owner" rather than "poisoned"; either way, A is durably refused.
    await expect(storeA.commitWrite([doc(newDocumentId(TABLE), "third-from-a")], [])).rejects.toThrow(/not the lease owner/i);

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

  it("4.2e: a zombie writer's independently-orphaned commit cannot clobber the live owner's data — the manifest still references only the live owner's segments after a fresh bootstrap (Critical, Task 4.2 review; seqno numbering updated for Finding 1's durable-burn-on-acquire, Task 4.5/4.6)", async () => {
    // The review's original Critical finding: A commits seg/0 (nextSeqno=1). B acquires (fences A,
    // epoch 2) and commits. Zombie A, unaware it's fenced, then commits reusing a seqno.
    //
    // UPDATED (Task 4.5/4.6): B's acquire now durably BURNS the one seqno (1) a just-fenced A could
    // have dirtied (durable-burn-on-acquire: the claim CAS advances manifest.nextSeqno past it) — so
    // B's own commit lands at seg/2, not seg/1. Zombie A's second commit (still using ITS OWN
    // uncorrected `nextSeqno = 1`, since A was never told it was fenced) therefore targets seg/1, which
    // is now simply UNCLAIMED rather than B's live data — its `putImmutable` succeeds (no collision to
    // keep-first-reject), but A's manifest CAS still fails on its own stale etag (fenced), so the write
    // it just landed is an ORPHAN: durable, but never manifest-referenced, exactly like Finding 1's own
    // scenario. This test demonstrates the OUTCOME both fixes jointly guarantee: whichever of
    // {keep-first, durable-burn} prevents a given collision, B's committed data is never shadowed and
    // the zombie's write never enters the materialized log.
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });
    const idA0 = newDocumentId(TABLE);
    await storeA.commitWrite([doc(idA0, "a-seg0")], []); // A's seg/0 — A's local nextSeqno is now 1

    // B acquires past A's lease expiry (fences A, bumps epoch to 2; durable-burn-on-acquire advances
    // the manifest cursor past the seqno (1) A's stalled zombie could dirty) and commits its own segment.
    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 })).toEqual({ acquired: true });
    const idB1 = newDocumentId(TABLE);
    await storeB.commitWrite([doc(idB1, "b-seg2")], []); // lands as seg/2 (durable burn moved past seg/1)

    const manifestAfterB = await readManifestRaw(objectStore);
    expect(manifestAfterB.segments).toEqual([0, 2]);
    expect(manifestAfterB.frontierTs).toBe("2");

    // Zombie A, unaware it was fenced, attempts its second commit — reusing seqno 1 (A's own
    // never-corrected view), a key B never touched.
    const idA1 = newDocumentId(TABLE);
    await expect(storeA.commitWrite([doc(idA1, "zombie-a-seg1")], [])).rejects.toBeInstanceOf(FencedError);

    // seg/2 must hold B's bytes — B's live, manifest-referenced data is untouched by the zombie.
    const seg2 = await objectStore.get("s0/seg/2");
    expect(seg2).not.toBeNull();
    expect(new TextDecoder().decode(seg2!.body)).toContain("b-seg2");

    // The manifest is untouched by the zombie's failed attempt — still exactly A's seg/0 + B's seg/2,
    // owned by B at epoch 2. (seg/1 durably exists as the zombie's unreferenced orphan — harmless,
    // never read by any bootstrap since `segments` never names it.)
    const manifestAfterZombie = await readManifestRaw(objectStore);
    expect(manifestAfterZombie.segments).toEqual([0, 2]);
    expect(manifestAfterZombie.frontierTs).toBe("2");
    expect(manifestAfterZombie.writerId).toBe("B");
    expect(manifestAfterZombie.epoch).toBe(2);

    // A fresh bootstrap from the bucket sees ONLY A's seg/0 and B's seg/2 — B's committed data
    // survived intact; the zombie's phantom write never entered the log.
    const storeC = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect((await storeC.get(idA0))!.value.value.body).toBe("a-seg0");
    expect((await storeC.get(idB1))!.value.value.body).toBe("b-seg2");
    expect(await storeC.get(idA1)).toBeNull();
    expect(await storeC.maxTimestamp()).toBe(2n);

    await storeA.close();
    await storeB.close();
    await storeC.close();
  });

  it("4.5: durable-burn-on-acquire fences a fenced predecessor's DIRTY (uncommitted) orphan segment — a taking-over writer's own commit must not let the orphan shadow its bytes (Critical, whole-branch review, Task 4.5/4.6)", async () => {
    // The exact scenario Finding 1 describes, distinct from 4.2e's "zombie commits AFTER B already
    // took the seqno" case: here A's `putImmutable` for its OWN commit lands durably, but A stalls
    // BEFORE its `casManifest` — so the manifest's `nextSeqno` is UNCHANGED and the segment A just
    // wrote is an orphan (durable, but never referenced). Without the durable-burn fence, a taking-over
    // B would reuse that exact seqno, its `putImmutable` would silently keep-first no-op against A's
    // orphan bytes, and B's manifest CAS would still succeed — referencing A's (failed) data instead
    // of B's. `acquire()`'s durable-burn-on-acquire (the claim CAS advances manifest.nextSeqno past the
    // orphan, and this writer starts at that advanced value) must prevent this by construction.
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });

    const idA0 = newDocumentId(TABLE);
    await storeA.commitWrite([doc(idA0, "a-seg0")], []); // lands as seg/0; A's local nextSeqno is now 1

    const manifestBeforeStall = await readManifestRaw(objectStore);
    expect(manifestBeforeStall.nextSeqno).toBe(1); // the durable cursor A's stalled commit will reuse
    const orphanSeqno = manifestBeforeStall.nextSeqno;

    // Simulate A's SECOND commit: its object-storage PUT succeeds (durable) but it stalls before the
    // manifest CAS that would reference it — an orphan at exactly `seg/${orphanSeqno}`, written but
    // never manifest-referenced. This is done directly against the bucket (not via `storeA`) to model
    // "A's process got exactly this far and no further" without racing real timers.
    const idAOrphan = newDocumentId(TABLE);
    await objectStore.putImmutable(
      `s0/seg/${orphanSeqno}`,
      encodeSegment({ documents: [doc(idAOrphan, "a-orphan-uncommitted")], indexUpdates: [] }),
    );
    // The manifest itself is untouched by the orphan PUT — still points at seg/0 only, nextSeqno 1.
    const manifestAfterOrphanPut = await readManifestRaw(objectStore);
    expect(manifestAfterOrphanPut).toEqual(manifestBeforeStall);

    // A's lease (ttl=1000 from now=0) expires; B takes over well past it.
    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 })).toEqual({ acquired: true });

    const idB = newDocumentId(TABLE);
    await storeB.commitWrite([doc(idB, "b-bytes")], []);

    // (a) B's commit must have written seg/{orphanSeqno + 1}, skipping the dirtied seqno entirely —
    // not colliding with (or being shadowed by) the orphan at seg/{orphanSeqno}.
    const manifestAfterB = await readManifestRaw(objectStore);
    expect(manifestAfterB.segments).toEqual([0, orphanSeqno + 1]);
    expect(manifestAfterB.nextSeqno).toBe(orphanSeqno + 2);

    // seg/{orphanSeqno} on the bucket is UNTOUCHED — still holds A's orphan bytes (keep-first left it
    // alone since B never targeted that key), but it is not reachable from the manifest at all.
    const orphanObj = await objectStore.get(`s0/seg/${orphanSeqno}`);
    expect(orphanObj).not.toBeNull();
    expect(new TextDecoder().decode(orphanObj!.body)).toContain("a-orphan-uncommitted");

    const bSeg = await objectStore.get(`s0/seg/${orphanSeqno + 1}`);
    expect(bSeg).not.toBeNull();
    const bSegText = new TextDecoder().decode(bSeg!.body);
    expect(bSegText).toContain("b-bytes");
    expect(bSegText).not.toContain("a-orphan-uncommitted");

    // (b) A FRESH bootstrap of shard "0" materializes B's committed doc and does NOT resurrect the
    // orphan (it was never manifest-referenced, so `materializeTo`'s replay loop never reads it).
    const storeC = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect((await storeC.get(idA0))!.value.value.body).toBe("a-seg0");
    expect((await storeC.get(idB))!.value.value.body).toBe("b-bytes");
    expect(await storeC.get(idAOrphan)).toBeNull(); // the orphan never entered materialized state

    // (c) `manifest.segments` does not include the orphaned seqno.
    expect(manifestAfterB.segments).not.toContain(orphanSeqno);

    await storeA.close();
    await storeB.close();
    await storeC.close();
  });

  it("4.6: durable-burn-on-acquire is robust across a CHAIN of stalled takeovers with NO successful commit between them — the gap Task 4.5's in-process-only skip-one missed (whole-branch v2 re-review)", async () => {
    // A commits once (manifest.nextSeqno lands at N=1), then A's SECOND commit stalls before its own
    // manifest CAS — an orphan at seg/N, durable but unreferenced. B takes over (its claim CAS must
    // durably burn nextSeqno to N+1) and ALSO stalls before ITS first commit's manifest CAS — a
    // SECOND orphan at seg/{N+1} — so NO successful commit ever lands between the two takeovers. With
    // the old Task 4.5 fix (in-process-only `this.nextSeqno = manifest.nextSeqno + 1`, leaving the
    // DURABLE manifest.nextSeqno untouched by acquire), C's takeover would re-read the SAME unmoved
    // durable cursor (still N) and recompute the SAME target (N+1) that B just orphaned — a collision
    // that resurrects B's failed write and loses C's. The fix (Task 4.6) makes EVERY takeover durably
    // burn the cursor, so C lands at N+2 no matter how many generations stalled in a row.
    const objectStore = await freshBucket();
    const storeA = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeA.acquire({ writerId: "A", leaseTtlMs: 1000, now: 0 })).toEqual({ acquired: true });
    const idA0 = newDocumentId(TABLE);
    await storeA.commitWrite([doc(idA0, "a-seg-committed")], []); // lands as seg/0; manifest.nextSeqno -> 1

    const manifestAfterA = await readManifestRaw(objectStore);
    const N = manifestAfterA.nextSeqno;
    expect(N).toBe(1);

    // A's SECOND commit: object PUT lands durably at seg/N, but stalls before the manifest CAS that
    // would reference it — an orphan, modeled directly against the bucket (same technique as the 4.5
    // test above) to avoid racing real timers.
    const idAOrphan = newDocumentId(TABLE);
    await objectStore.putImmutable(`s0/seg/${N}`, encodeSegment({ documents: [doc(idAOrphan, "a-orphan-uncommitted")], indexUpdates: [] }));

    // B takes over past A's lease expiry. Its claim CAS must durably burn manifest.nextSeqno to N+1
    // — assert this BEFORE B ever attempts a commit, proving the burn happens at acquire time itself.
    const storeB = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeB.acquire({ writerId: "B", leaseTtlMs: 1000, now: 2000 })).toEqual({ acquired: true });
    const manifestAfterB = await readManifestRaw(objectStore);
    expect(manifestAfterB.nextSeqno).toBe(N + 1);

    // B's FIRST commit ALSO stalls before its manifest CAS — a second orphan at seg/{N+1}. B never
    // successfully commits, so no commit advances the durable cursor between the two takeovers.
    const idBOrphan = newDocumentId(TABLE);
    await objectStore.putImmutable(`s0/seg/${N + 1}`, encodeSegment({ documents: [doc(idBOrphan, "b-orphan-uncommitted")], indexUpdates: [] }));

    // C takes over past B's lease expiry.
    const storeC = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await storeC.acquire({ writerId: "C", leaseTtlMs: 1000, now: 4000 })).toEqual({ acquired: true });
    const manifestAfterC = await readManifestRaw(objectStore);
    // THE assertion the chain exercises: the durable cursor must have advanced past BOTH orphans, not
    // just A's — exactly what the old in-process-only skip-one got wrong (it would leave this at N).
    expect(manifestAfterC.nextSeqno).toBe(N + 2);

    const idC = newDocumentId(TABLE);
    await storeC.commitWrite([doc(idC, "c-bytes")], []);
    const manifestAfterCCommit = await readManifestRaw(objectStore);
    expect(manifestAfterCCommit.segments).toEqual([0, N + 2]);
    expect(manifestAfterCCommit.nextSeqno).toBe(N + 3);

    // C's committed segment holds ONLY C's bytes — not shadowed by (or shadowing) either orphan.
    const cSeg = await objectStore.get(`s0/seg/${N + 2}`);
    expect(cSeg).not.toBeNull();
    const cSegText = new TextDecoder().decode(cSeg!.body);
    expect(cSegText).toContain("c-bytes");
    expect(cSegText).not.toContain("a-orphan-uncommitted");
    expect(cSegText).not.toContain("b-orphan-uncommitted");

    // A fresh bootstrap sees ONLY A's real commit (seg/0) and C's committed segment — NEITHER orphan
    // ever entered materialized state, and `segments` excludes both N and N+1.
    const storeD = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect((await storeD.get(idA0))!.value.value.body).toBe("a-seg-committed");
    expect((await storeD.get(idC))!.value.value.body).toBe("c-bytes");
    expect(await storeD.get(idAOrphan)).toBeNull();
    expect(await storeD.get(idBOrphan)).toBeNull();
    const finalManifest = await readManifestRaw(objectStore);
    expect(finalManifest.segments).not.toContain(N);
    expect(finalManifest.segments).not.toContain(N + 1);

    await storeA.close();
    await storeB.close();
    await storeC.close();
    await storeD.close();
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
