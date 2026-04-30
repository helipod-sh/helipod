import { describe, it, expect } from "vitest";
import { newDocumentId, encodeStorageIndexId, internalIdToHex, type InternalDocumentId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";

const TABLE = 20007;

function doc(id: InternalDocumentId, body: string | null, prev_ts: bigint | null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts, value: body === null ? null : { id, value: { body } } };
}
function liveIdx(indexId: string, key: Uint8Array, id: InternalDocumentId): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "NonClustered", docId: id } } };
}
function deletedIdx(indexId: string, key: Uint8Array): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "Deleted" } } };
}

// Slice 5 (migration export): PostgresDocStore.dumpCurrentState is the Postgres mirror of the SQLite
// one — run against PGlite (real Postgres semantics, in-process) so the source-topology export path
// is proven, not just typed.
describe("PostgresDocStore.dumpCurrentState (PGlite)", () => {
  it("returns exactly the current live documents (latest revision, tombstones excluded) + current index rows", async () => {
    const store = new PostgresDocStore(new PgliteClient());
    await store.setupSchema();

    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const keyA = encodeIndexKey(["a"]);
    const keyB = encodeIndexKey(["b"]);
    const keyC = encodeIndexKey(["c"]);
    const id1 = newDocumentId(TABLE);
    const id2 = newDocumentId(TABLE);

    const ts1 = await store.commitWrite([doc(id1, "A", null)], [liveIdx(indexId, keyA, id1)]);
    const ts2 = await store.commitWrite([doc(id1, "B", ts1)], [deletedIdx(indexId, keyA), liveIdx(indexId, keyB, id1)]);
    const ts3 = await store.commitWrite([doc(id2, "C", null)], [liveIdx(indexId, keyC, id2)]);
    await store.commitWrite([doc(id2, null, ts3)], [deletedIdx(indexId, keyC)]);

    const dump = await store.dumpCurrentState();

    expect(dump.documents).toHaveLength(1);
    const d = dump.documents[0]!;
    expect(d.ts).toBe(ts2);
    expect(d.prev_ts).toBe(ts1);
    expect((d.value!.value as Record<string, unknown>).body).toBe("B");
    expect(dump.documents.some((e) => internalIdToHex(e.id.internalId) === internalIdToHex(id2.internalId))).toBe(false);

    expect(dump.indexUpdates).toHaveLength(3);
    const byKey = new Map(dump.indexUpdates.map((w) => [Buffer.from(w.update.key).toString("hex"), w]));
    expect(byKey.get(Buffer.from(keyA).toString("hex"))!.update.value).toEqual({ type: "Deleted" });
    expect(byKey.get(Buffer.from(keyB).toString("hex"))!.update.value).toEqual({ type: "NonClustered", docId: id1 });
    expect(byKey.get(Buffer.from(keyC).toString("hex"))!.update.value).toEqual({ type: "Deleted" });
  });

  it("returns an empty dump for a fresh store", async () => {
    const store = new PostgresDocStore(new PgliteClient());
    await store.setupSchema();
    const dump = await store.dumpCurrentState();
    expect(dump.documents).toEqual([]);
    expect(dump.indexUpdates).toEqual([]);
  });
});
