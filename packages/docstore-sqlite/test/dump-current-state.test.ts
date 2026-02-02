import { describe, it, expect } from "vitest";
import { newDocumentId, encodeStorageIndexId, internalIdToHex, type InternalDocumentId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

const TABLE = 20003;

function doc(id: InternalDocumentId, body: string | null, prev_ts: bigint | null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts, value: body === null ? null : { id, value: { body } } };
}
function liveIdx(indexId: string, key: Uint8Array, id: InternalDocumentId): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "NonClustered", docId: id } } };
}
function deletedIdx(indexId: string, key: Uint8Array): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "Deleted" } } };
}

describe("SqliteDocStore.dumpCurrentState", () => {
  it("returns exactly the current live documents (latest revision, tombstones excluded) + current index rows", async () => {
    const adapter = new NodeSqliteAdapter();
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();

    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const keyA = encodeIndexKey(["a"]);
    const keyB = encodeIndexKey(["b"]);
    const keyC = encodeIndexKey(["c"]);

    const id1 = newDocumentId(TABLE);
    const id2 = newDocumentId(TABLE);

    // id1: insert (ts1) then update (ts2, superseding ts1) — the update is what should survive.
    const ts1 = await store.commitWrite([doc(id1, "A", null)], [liveIdx(indexId, keyA, id1)]);
    const ts2 = await store.commitWrite(
      [doc(id1, "B", ts1)],
      [deletedIdx(indexId, keyA), liveIdx(indexId, keyB, id1)],
    );

    // id2: insert (ts3) then delete (ts4) — a tombstone; must be ABSENT from the dump.
    const ts3 = await store.commitWrite([doc(id2, "C", null)], [liveIdx(indexId, keyC, id2)]);
    await store.commitWrite([doc(id2, null, ts3)], [deletedIdx(indexId, keyC)]);

    const dump = await store.dumpCurrentState();

    // Exactly one live document: id1's UPDATED revision, at its real ts/prev_ts.
    expect(dump.documents).toHaveLength(1);
    const d = dump.documents[0]!;
    expect(d.id.tableNumber).toBe(id1.tableNumber);
    expect(d.id.internalId).toEqual(id1.internalId);
    expect(d.ts).toBe(ts2);
    expect(d.prev_ts).toBe(ts1);
    expect(d.value).not.toBeNull();
    expect((d.value!.value as Record<string, unknown>).body).toBe("B");

    // id2 (tombstoned) must not appear anywhere in the dump.
    expect(dump.documents.some((e) => internalIdToHex(e.id.internalId) === internalIdToHex(id2.internalId))).toBe(
      false,
    );

    // Current index rows: one per (indexId, key) — the newest revision, live or deleted alike.
    expect(dump.indexUpdates).toHaveLength(3);
    const byKey = new Map(dump.indexUpdates.map((w) => [Buffer.from(w.update.key).toString("hex"), w]));

    const rowA = byKey.get(Buffer.from(keyA).toString("hex"))!;
    expect(rowA.ts).toBe(ts2);
    expect(rowA.update.value).toEqual({ type: "Deleted" });

    const rowB = byKey.get(Buffer.from(keyB).toString("hex"))!;
    expect(rowB.ts).toBe(ts2);
    expect(rowB.update.value).toEqual({ type: "NonClustered", docId: id1 });

    const rowC = byKey.get(Buffer.from(keyC).toString("hex"))!;
    expect(rowC.update.value).toEqual({ type: "Deleted" });

    store.close();
  });

  it("returns an empty dump for a fresh store", async () => {
    const adapter = new NodeSqliteAdapter();
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();

    const dump = await store.dumpCurrentState();
    expect(dump.documents).toEqual([]);
    expect(dump.indexUpdates).toEqual([]);

    store.close();
  });

  it("write(dump, 'Overwrite') on a fresh store reproduces the exact current state", async () => {
    const adapter = new NodeSqliteAdapter();
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();

    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const key = encodeIndexKey(["x"]);
    const id = newDocumentId(TABLE);
    await store.commitWrite([doc(id, "X", null)], [liveIdx(indexId, key, id)]);
    await store.commitWrite([doc(id, "X2", await store.maxTimestamp())], []);

    const dump = await store.dumpCurrentState();

    const freshAdapter = new NodeSqliteAdapter();
    const fresh = new SqliteDocStore(freshAdapter);
    await fresh.setupSchema();
    await fresh.write(dump.documents, dump.indexUpdates, "Overwrite");

    const got = await fresh.get(id);
    expect(got).not.toBeNull();
    expect((got!.value.value as Record<string, unknown>).body).toBe("X2");
    expect(await fresh.dumpCurrentState()).toEqual(dump);

    store.close();
    fresh.close();
  });
});
