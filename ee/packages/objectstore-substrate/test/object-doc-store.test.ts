import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { newDocumentId, encodeStorageTableId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { BunSqliteAdapter, NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { ObjectStoreDocStore } from "../src/object-doc-store";
import { FencedError } from "../src/fenced-error";

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
    expect(manifest).toEqual({ epoch: 0, frontierTs: "0", tsCounter: "0", segments: [] });

    await store.close();
  });

  it("commitWrite of one doc returns ts=1, lands seg/0, advances the manifest, and is visible via get", async () => {
    const objectStore = await freshBucket();
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

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
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

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

  it("fence: a stale-etag committer throws FencedError with no new segment and no local write", async () => {
    const objectStore = await freshBucket();
    const store1 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    const store2 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

    const id1 = newDocumentId(TABLE);
    await store1.commitWrite([doc(id1, "first")], []);

    // store2 opened before store1 committed — its cached manifest etag is now stale.
    const id2 = newDocumentId(TABLE);
    await expect(store2.commitWrite([doc(id2, "second")], [])).rejects.toBeInstanceOf(FencedError);

    // No new segment landed for store2's attempt — still exactly the one segment store1 wrote.
    const segments = await objectStore.list("s0/seg/");
    expect(segments).toEqual(["s0/seg/0"]);

    // The manifest still reflects only store1's commit.
    const manifestEntry = await objectStore.get("s0/manifest");
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry!.body));
    expect(manifest.segments).toEqual([0]);
    expect(manifest.frontierTs).toBe("1");

    // store2's local store never received the write.
    expect(await store2.get(id2)).toBeNull();
    // A fresh store bootstrapped from the bucket only ever sees store1's document.
    const store3 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
    expect(await store3.get(id2)).toBeNull();
    expect((await store3.get(id1))!.value.value.body).toBe("first");

    await store1.close();
    await store2.close();
    await store3.close();
  });

  it("bootstrap: a second ObjectStoreDocStore.open over the same bucket materializes the committed doc", async () => {
    const objectStore = await freshBucket();
    const store1 = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });
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
    const store = await ObjectStoreDocStore.open({ objectStore, shard: "0", local: freshLocal() });

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
});
