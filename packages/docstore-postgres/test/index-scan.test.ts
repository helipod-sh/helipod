import { describe, it, expect, beforeEach } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import { PgliteClient } from "./pglite-client";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@stackbase/docstore";

const TABLE = 10001;
const INDEX_ID = encodeStorageIndexId(TABLE, "by_key");
let store: PostgresDocStore;
beforeEach(async () => { store = new PostgresDocStore(new PgliteClient()); await store.setupSchema(); });

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } };
}
function idxDel(key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "Deleted" } } };
}
async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> { const o: T[] = []; for await (const x of g) o.push(x); return o; }
const FULL: Interval = { start: new Uint8Array(), end: null };

describe("index_scan / load_documents / previous_revisions", () => {
  it("scans keys in order, resolves docs, skips deletions and doc tombstones", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE), c = newDocumentId(TABLE);
    const ka = encodeIndexKey(["a"]);
    const kb = encodeIndexKey(["b"]);
    const kc = encodeIndexKey(["c"]);
    await store.write([rev(a, 1n, null, "A"), rev(b, 1n, null, "B"), rev(c, 1n, null, "C")],
      [idxPut(a, ka, 1n), idxPut(b, kb, 1n), idxPut(c, kc, 1n)], "Error");
    await store.write([rev(b, 2n, 1n, null)], [idxDel(kb, 2n)], "Error"); // delete b (doc + index)

    const asc = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc"));
    expect(asc.map(([, d]) => d.value.value.body)).toEqual(["A", "C"]); // b skipped, order preserved
    const desc = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "desc"));
    expect(desc.map(([, d]) => d.value.value.body)).toEqual(["C", "A"]);

    // snapshot before deletion sees B too
    const at1 = await collect(store.index_scan(INDEX_ID, "", 1n, FULL, "asc"));
    expect(at1.map(([, d]) => d.value.value.body)).toEqual(["A", "B", "C"]);
  });

  it("limit counts only live rows (tombstones must not shorten the page)", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE), c = newDocumentId(TABLE);
    const ka = encodeIndexKey(["a"]);
    const kb = encodeIndexKey(["b"]);
    const kc = encodeIndexKey(["c"]);
    await store.write([rev(a, 1n, null, "A"), rev(b, 1n, null, "B"), rev(c, 1n, null, "C")],
      [idxPut(a, ka, 1n), idxPut(b, kb, 1n), idxPut(c, kc, 1n)], "Error");
    await store.write([rev(b, 2n, 1n, null)], [idxDel(kb, 2n)], "Error"); // b dead
    const page = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc", 2));
    expect(page.map(([, d]) => d.value.value.body)).toEqual(["A", "C"]); // 2 LIVE rows, not [A] short page
  });

  it("load_documents tails the log across a ts range", async () => {
    const a = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "v1")], [], "Error");
    await store.write([rev(a, 2n, 1n, "v2")], [], "Error");
    const entries = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 3n }, "asc"));
    expect(entries.map((e) => e.ts)).toEqual([1n, 2n]);
  });

  it("previous_revisions resolves a batch in one call", async () => {
    const a = newDocumentId(TABLE), b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "A1")], [], "Error");
    await store.write([rev(a, 2n, 1n, "A2")], [], "Error");
    await store.write([rev(b, 2n, null, "B1")], [], "Error");
    const { getPrevRevQueryKey } = await import("@stackbase/docstore");
    const res = await store.previous_revisions([{ id: a, ts: 1n }, { id: b, ts: 5n }]);
    expect(res.get(getPrevRevQueryKey(a, 1n))!.value!.value.body).toBe("A1");
    expect(res.get(getPrevRevQueryKey(b, 5n))!.value!.value.body).toBe("B1");
  });
});
