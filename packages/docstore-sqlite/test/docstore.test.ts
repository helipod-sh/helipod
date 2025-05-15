import { describe, it, expect, beforeEach } from "vitest";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import { getPrevRevQueryKey } from "@stackbase/docstore";
import type { DocumentLogEntry, InternalDocumentId, IndexWrite } from "@stackbase/docstore";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

let store: SqliteDocStore;
beforeEach(async () => {
  store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
});

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return {
    ts,
    id,
    prev_ts: prevTs,
    value: body === null ? null : { id, value: { body, n: ts } },
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe("MVCC document revisions", () => {
  it("reads the newest revision visible at a read timestamp", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

    expect(await store.get(id, 0n)).toBeNull(); // nothing visible before ts 1
    expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
    expect((await store.get(id, 2n))!.value.value.body).toBe("v2");
    const latest = (await store.get(id))!;
    expect(latest.value.value.body).toBe("v2");
    expect(latest.ts).toBe(2n);
    expect(latest.prev_ts).toBe(1n); // chain back to v1
  });

  it("hides a tombstoned document while preserving its history", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");
    await store.write([rev(id, 3n, 2n, null)], [], "Error"); // delete

    expect(await store.get(id)).toBeNull(); // deleted as of latest
    expect((await store.get(id, 2n))!.value.value.body).toBe("v2"); // history intact
    expect(await store.count(TABLE_ID)).toBe(0);
  });

  it("round-trips bigint and preserves value fidelity", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 5n, null, "x")], [], "Error");
    expect((await store.get(id))!.value.value.n).toBe(5n);
  });
});

describe("MVCC index scans", () => {
  function indexUpdate(indexId: string, ts: bigint, key: Uint8Array, docId: InternalDocumentId | null): IndexWrite {
    return {
      ts,
      update: {
        indexId,
        key,
        value: docId === null ? { type: "Deleted" } : { type: "NonClustered", docId },
      },
    };
  }

  it("resolves index entries to documents at a point in time", async () => {
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);
    const keyA = encodeIndexKey(["apple"]);
    const keyB = encodeIndexKey(["banana"]);

    await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, keyA, a)], "Error");
    await store.write([rev(b, 2n, null, "banana")], [indexUpdate(indexId, 2n, keyB, b)], "Error");

    const all = await collect(
      store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "asc"),
    );
    expect(all.map(([, doc]) => doc.value.value.body)).toEqual(["apple", "banana"]); // key order

    const desc = await collect(
      store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "desc"),
    );
    expect(desc.map(([, doc]) => doc.value.value.body)).toEqual(["banana", "apple"]);
  });

  it("honors index deletions at the right timestamp", async () => {
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const a = newDocumentId(TABLE);
    const keyA = encodeIndexKey(["apple"]);

    await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, keyA, a)], "Error");
    // delete the index entry (and tombstone the doc) at ts 2
    await store.write([rev(a, 2n, 1n, null)], [indexUpdate(indexId, 2n, keyA, null)], "Error");

    const atOne = await collect(store.index_scan(indexId, TABLE_ID, 1n, { start: encodeIndexKey([]), end: null }, "asc"));
    expect(atOne).toHaveLength(1);
    const atTwo = await collect(store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "asc"));
    expect(atTwo).toHaveLength(0);
  });

  it("restricts to the requested key interval", async () => {
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, encodeIndexKey(["apple"]), a)], "Error");
    await store.write([rev(b, 2n, null, "cherry")], [indexUpdate(indexId, 2n, encodeIndexKey(["cherry"]), b)], "Error");

    const onlyApple = await collect(
      store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey(["a"]), end: encodeIndexKey(["b"]) }, "asc"),
    );
    expect(onlyApple.map(([, d]) => d.value.value.body)).toEqual(["apple"]);
  });
});

describe("log tailing", () => {
  it("returns revisions in timestamp order, including tombstones", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");
    await store.write([rev(id, 3n, 2n, null)], [], "Error");

    const entries = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 4n }, "asc"));
    expect(entries.map((e) => e.ts)).toEqual([1n, 2n, 3n]);
    expect(entries.map((e) => (e.value === null ? null : e.value.value.body))).toEqual(["v1", "v2", null]);
  });
});

describe("previous_revisions (OCC support)", () => {
  it("returns the revision visible at each queried timestamp", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

    const result = await store.previous_revisions([
      { id, ts: 1n },
      { id, ts: 2n },
    ]);
    expect(result.get(getPrevRevQueryKey(id, 1n))!.ts).toBe(1n);
    expect(result.get(getPrevRevQueryKey(id, 2n))!.value!.value.body).toBe("v2");
  });
});

describe("globals", () => {
  it("round-trips and supports if-absent semantics", async () => {
    expect(await store.getGlobal("schema_version")).toBeNull();
    await store.writeGlobal("schema_version", 3);
    expect(await store.getGlobal("schema_version")).toBe(3);

    expect(await store.writeGlobalIfAbsent("once", "a")).toBe(true);
    expect(await store.writeGlobalIfAbsent("once", "b")).toBe(false);
    expect(await store.getGlobal("once")).toBe("a");
  });
});

describe("conflict strategy", () => {
  it("rejects a duplicate (id, ts) under Error but replaces under Overwrite", async () => {
    const id = newDocumentId(TABLE);
    await store.write([rev(id, 1n, null, "v1")], [], "Error");
    await expect(store.write([rev(id, 1n, null, "dup")], [], "Error")).rejects.toThrow();
    await store.write([rev(id, 1n, null, "replaced")], [], "Overwrite");
    expect((await store.get(id, 1n))!.value.value.body).toBe("replaced");
  });
});

describe("scan", () => {
  it("returns live documents in a table at a timestamp", async () => {
    const a = newDocumentId(TABLE);
    const b = newDocumentId(TABLE);
    await store.write([rev(a, 1n, null, "a")], [], "Error");
    await store.write([rev(b, 2n, null, "b")], [], "Error");
    expect((await store.scan(TABLE_ID)).length).toBe(2);
    await store.write([rev(a, 3n, 1n, null)], [], "Error"); // delete a
    const live = await store.scan(TABLE_ID);
    expect(live.map((d) => d.value.value.body)).toEqual(["b"]);
  });
});
