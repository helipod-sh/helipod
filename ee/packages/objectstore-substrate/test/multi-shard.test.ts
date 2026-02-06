/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Task 4.3 — multi-shard composition + zero-cross-contention (design record §5, Tier 3 Slice 4). The
 * substrate is ALREADY per-shard (each `ObjectStoreDocStore` instance owns one `s{shard}/…` key
 * prefix) — "multi-shard" is a composition + independence PROOF, not new machinery. No
 * `openShardSet`/router helper is added here (per the plan's "decide minimally" note): composing N
 * lanes is just N `ObjectStoreDocStore.open()` + `acquire()` calls over the SAME bucket at distinct
 * `shard` ids, which is already the whole public API — a thin wrapper around two lines wouldn't earn
 * its place, and a real mutation→shard ROUTER is explicitly the engine's `ShardedTransactor` concern,
 * not this substrate's.
 *
 * This test proves the only thing actually new at this layer: that two lanes over one bucket share
 * NO manifest-CAS domain (a commit to lane 0 never moves lane 1's etag), that each lane's bootstrap
 * materializes ONLY its own state, and that `ensureGlobals` records the fleet-wide `numShards`.
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
import { readManifest } from "../src/manifest";
import { ensureGlobals } from "../src/globals";

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
  const dir = await mkdtemp(join(tmpdir(), "objectstore-substrate-multishard-test-"));
  dirs.push(dir);
  return new FsObjectStore({ dir });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("multi-shard composition (Tier 3 Slice 4, Task 4.3)", () => {
  it("4.3a: two lanes over one bucket are independent — distinct manifest-CAS domains, isolated bootstrap, numShards recorded", async () => {
    const objectStore = await freshBucket();

    // Fleet-level: record the shard count once, before any lane opens (Task 4.1's globals).
    const globals = await ensureGlobals(objectStore, { deploymentId: "dep-multishard", numShards: 2 });
    expect(globals.numShards).toBe(2);

    // Two independent lanes, distinct writers, over the SAME bucket.
    const lane0 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await lane0.acquire({ writerId: "writer-0", leaseTtlMs: 1_000_000, now: 0 })).toEqual({ acquired: true });
    const lane1 = await ObjectStoreDocStore.open({ objectStore, shard: "1", local: freshLocal() });
    expect(await lane1.acquire({ writerId: "writer-1", leaseTtlMs: 1_000_000, now: 0 })).toEqual({ acquired: true });

    // Capture lane 1's manifest etag before touching lane 0 at all.
    const lane1EtagBefore = (await readManifest(objectStore, "1"))!.etag;

    // Interleave commits: lane0, lane1, lane0, lane1, ...
    const id0a = newDocumentId(TABLE);
    const id1a = newDocumentId(TABLE);
    const id0b = newDocumentId(TABLE);
    const id1b = newDocumentId(TABLE);
    await lane0.commitWrite([doc(id0a, "lane0-a")], []);

    // A commit to lane 0 must NOT move lane 1's manifest etag at all — distinct CAS domains.
    const lane1EtagAfterLane0Commit = (await readManifest(objectStore, "1"))!.etag;
    expect(lane1EtagAfterLane0Commit).toBe(lane1EtagBefore);

    await lane1.commitWrite([doc(id1a, "lane1-a")], []);
    const lane0EtagAfterFirst = (await readManifest(objectStore, "0"))!.etag;
    await lane0.commitWrite([doc(id0b, "lane0-b")], []);
    const lane0EtagAfterSecond = (await readManifest(objectStore, "0"))!.etag;
    // Lane 0's OWN etag DOES advance on its own commits (sanity: the etag capture above wasn't inert).
    expect(lane0EtagAfterSecond).not.toBe(lane0EtagAfterFirst);
    await lane1.commitWrite([doc(id1b, "lane1-b")], []);

    // And symmetrically: lane 1's commits never move lane 0's manifest etag.
    const lane0EtagFinal = (await readManifest(objectStore, "0"))!.etag;
    expect(lane0EtagFinal).toBe(lane0EtagAfterSecond);

    // Each lane's manifest independently reflects ONLY its own two commits.
    const manifest0 = (await readManifest(objectStore, "0"))!.manifest;
    const manifest1 = (await readManifest(objectStore, "1"))!.manifest;
    expect(manifest0.segments).toEqual([0, 1]);
    expect(manifest0.frontierTs).toBe("2");
    expect(manifest0.writerId).toBe("writer-0");
    expect(manifest1.segments).toEqual([0, 1]);
    expect(manifest1.frontierTs).toBe("2");
    expect(manifest1.writerId).toBe("writer-1");

    // A fresh `open` of each lane materializes ONLY that lane's documents — no cross-contamination.
    const freshLane0 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect((await freshLane0.get(id0a))!.value.value.body).toBe("lane0-a");
    expect((await freshLane0.get(id0b))!.value.value.body).toBe("lane0-b");
    expect(await freshLane0.get(id1a)).toBeNull();
    expect(await freshLane0.get(id1b)).toBeNull();

    const freshLane1 = await ObjectStoreDocStore.open({ objectStore, shard: "1", local: freshLocal() });
    expect((await freshLane1.get(id1a))!.value.value.body).toBe("lane1-a");
    expect((await freshLane1.get(id1b))!.value.value.body).toBe("lane1-b");
    expect(await freshLane1.get(id0a)).toBeNull();
    expect(await freshLane1.get(id0b)).toBeNull();

    await lane0.close();
    await lane1.close();
    await freshLane0.close();
    await freshLane1.close();
  });
});
