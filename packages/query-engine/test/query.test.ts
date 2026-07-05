import { describe, it, expect, beforeEach } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import {
  newDocumentId,
  encodeInternalDocumentId,
  encodeStorageIndexId,
  encodeStorageTableId,
  type InternalDocumentId,
} from "@helipod/id-codec";
import { RangeSet, indexKeyspaceId, deserializeKeyRange, keyInRange } from "@helipod/index-key-codec";
import type { DocumentValue, IndexWrite } from "@helipod/docstore";
import { QueryRuntime, computeIndexUpdates, extractIndexKey, type IndexSpec, type Query } from "../src/index";

const TABLE = 10001;
const TABLE_NAME = "messages";

const idx = (index: string, fields: string[]): IndexSpec => ({
  table: TABLE_NAME,
  tableNumber: TABLE,
  index,
  fields,
  indexId: encodeStorageIndexId(TABLE, index),
});

let store: SqliteDocStore;
let qr: QueryRuntime;
beforeEach(async () => {
  store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  qr = new QueryRuntime(store);
});

function makeDoc(id: InternalDocumentId, creation: number, extra: Record<string, unknown>): DocumentValue {
  return { _id: encodeInternalDocumentId(id), _creationTime: creation, ...extra } as DocumentValue;
}

async function insert(indexes: IndexSpec[], id: InternalDocumentId, doc: DocumentValue, ts: bigint): Promise<void> {
  const indexWrites: IndexWrite[] = computeIndexUpdates(indexes, null, doc, id).map((update) => ({ ts, update }));
  await store.write([{ ts, id, prev_ts: null, value: { id, value: doc } }], indexWrites, "Error");
}

describe("indexed equality query", () => {
  const byConversation = idx("by_conversation", ["conversationId"]);

  it("returns matching rows in index order and records a precise read set", async () => {
    const c1Docs: DocumentValue[] = [];
    const c2Docs: DocumentValue[] = [];
    let ts = 0n;
    for (const [conv, body, creation] of [
      ["c1", "a", 1],
      ["c1", "b", 2],
      ["c2", "x", 3],
      ["c1", "c", 4],
      ["c2", "y", 5],
    ] as const) {
      const id = newDocumentId(TABLE);
      const doc = makeDoc(id, creation, { conversationId: conv, body });
      (conv === "c1" ? c1Docs : c2Docs).push(doc);
      await insert([byConversation], id, doc, ++ts);
    }

    const query: Query = { index: byConversation, range: [{ field: "conversationId", operator: "eq", value: "c1" }] };
    const { documents, readSet } = await qr.collect(query, ts);

    expect(documents.map((d) => d["body"])).toEqual(["a", "b", "c"]); // only c1, in creation order

    // read set is the c1 slice of the by_conversation index: a write to a c1 row intersects,
    // a write to a c2 row does not (range precision within the same keyspace).
    const ks = indexKeyspaceId(encodeStorageTableId(TABLE), "by_conversation");
    const writeC1 = new RangeSet();
    writeC1.addKey(ks, extractIndexKey(c1Docs[0]!, ["conversationId"]));
    const writeC2 = new RangeSet();
    writeC2.addKey(ks, extractIndexKey(c2Docs[0]!, ["conversationId"]));
    expect(readSet.intersects(writeC1)).toBe(true);
    expect(readSet.intersects(writeC2)).toBe(false);
  });
});

describe("index range push-down vs residual filter", () => {
  const byConvPriority = idx("by_conv_priority", ["conversationId", "priority"]);

  beforeEach(async () => {
    let ts = 0n;
    for (const priority of [1, 2, 3, 4, 5]) {
      const id = newDocumentId(TABLE);
      await insert([byConvPriority], id, makeDoc(id, priority, { conversationId: "c1", priority, body: `p${priority}` }), ++ts);
    }
  });

  it("pushes equality + inequality into a single index range scan", async () => {
    const query: Query = {
      index: byConvPriority,
      range: [
        { field: "conversationId", operator: "eq", value: "c1" },
        { field: "priority", operator: "gte", value: 3 },
      ],
    };
    const { documents } = await qr.collect(query, 5n);
    expect(documents.map((d) => d["priority"])).toEqual([3, 4, 5]); // narrowed by the index, no filter
  });

  it("applies a residual post-filter the index can't express", async () => {
    const query: Query = {
      index: byConvPriority,
      range: [{ field: "conversationId", operator: "eq", value: "c1" }],
      filters: [{ op: "gt", field: "priority", value: 3 }],
    };
    const { documents } = await qr.collect(query, 5n);
    expect(documents.map((d) => d["priority"])).toEqual([4, 5]);
  });
});

describe("stable cursor pagination (desc) under concurrent head inserts", () => {
  const byCreation = idx("by_creation", []);

  it("does not skip or duplicate when new rows arrive at the head between pages", async () => {
    let ts = 0n;
    for (const creation of [1, 2, 3, 4, 5, 6]) {
      const id = newDocumentId(TABLE);
      await insert([byCreation], id, makeDoc(id, creation, { body: `m${creation}` }), ++ts);
    }

    const query: Query = { index: byCreation, order: "desc" };

    const page1 = await qr.paginate(query, ts, { pageSize: 2 });
    expect(page1.page.map((d) => d["body"])).toEqual(["m6", "m5"]);
    expect(page1.hasMore).toBe(true);

    // New rows arrive at the head (higher creation) before page 2 is fetched.
    for (const creation of [7, 8]) {
      const id = newDocumentId(TABLE);
      await insert([byCreation], id, makeDoc(id, creation, { body: `m${creation}` }), ++ts);
    }

    // Page 2 resumes from the cursor — unaffected by the head inserts (no m7/m8, no dup of m5).
    const page2 = await qr.paginate(query, ts, { cursor: page1.nextCursor, pageSize: 2 });
    expect(page2.page.map((d) => d["body"])).toEqual(["m4", "m3"]);

    const page3 = await qr.paginate(query, ts, { cursor: page2.nextCursor, pageSize: 2 });
    expect(page3.page.map((d) => d["body"])).toEqual(["m2", "m1"]);
    expect(page3.hasMore).toBe(false);
    expect(page3.nextCursor).toBeNull();
  });
});

describe("PaginatedResult.pageBounds (DLR 2c Task 1 review fix)", () => {
  const byCreation = idx("by_creation_bounds", []);
  let docs: DocumentValue[] = [];

  beforeEach(async () => {
    docs = [];
    let ts = 0n;
    for (const creation of [1, 2, 3, 4, 5]) {
      const id = newDocumentId(TABLE);
      const doc = makeDoc(id, creation, { body: `m${creation}` });
      docs.push(doc);
      await insert([byCreation], id, doc, ++ts);
    }
  });

  function keyOf(doc: DocumentValue): Uint8Array {
    return extractIndexKey(doc, byCreation.fields);
  }

  it("asc non-final page: bounds include this page's rows, exclude the next page's first row", async () => {
    const query: Query = { index: byCreation, order: "asc" };
    const page1 = await qr.paginate(query, 5n, { pageSize: 3 });
    expect(page1.page.map((d) => d["body"])).toEqual(["m1", "m2", "m3"]); // creation order
    expect(page1.hasMore).toBe(true);

    const bounds = deserializeKeyRange(page1.pageBounds);
    for (const d of [docs[0]!, docs[1]!, docs[2]!]) expect(keyInRange(keyOf(d), bounds)).toBe(true);
    expect(keyInRange(keyOf(docs[3]!), bounds)).toBe(false); // m4 — belongs to the NEXT page, not this one
  });

  it("asc last page: bounds equal the full (resolved) interval it scanned", async () => {
    // pageSize 10 > 5 rows: the FIRST page is also the last (hasMore=false, no cursor resolved yet),
    // so its own resolved interval IS the base interval — bounds must cover every row.
    const query: Query = { index: byCreation, order: "asc" };
    const onlyPage = await qr.paginate(query, 5n, { pageSize: 10 });
    expect(onlyPage.page.map((d) => d["body"])).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(onlyPage.hasMore).toBe(false);

    const bounds = deserializeKeyRange(onlyPage.pageBounds);
    for (const d of docs) expect(keyInRange(keyOf(d), bounds)).toBe(true);
  });

  it("desc non-final page: bounds include this page's rows, exclude the next page's row (fails pre-fix — the reported bug)", async () => {
    const query: Query = { index: byCreation, order: "desc" };
    const page1 = await qr.paginate(query, 5n, { pageSize: 3 });
    expect(page1.page.map((d) => d["body"])).toEqual(["m5", "m4", "m3"]); // reverse creation order
    expect(page1.hasMore).toBe(true);

    const bounds = deserializeKeyRange(page1.pageBounds);
    for (const d of [docs[4]!, docs[3]!, docs[2]!]) expect(keyInRange(keyOf(d), bounds)).toBe(true);
    expect(keyInRange(keyOf(docs[1]!), bounds)).toBe(false); // m2 — belongs to the NEXT page, not this one
  });

  it("desc last page: bounds equal the full (resolved) interval it scanned", async () => {
    // pageSize 10 > 5 rows: the FIRST page is also the last (hasMore=false, no cursor resolved yet),
    // so its own resolved interval IS the base interval — bounds must cover every row.
    const query: Query = { index: byCreation, order: "desc" };
    const onlyPage = await qr.paginate(query, 5n, { pageSize: 10 });
    expect(onlyPage.page.map((d) => d["body"])).toEqual(["m5", "m4", "m3", "m2", "m1"]);
    expect(onlyPage.hasMore).toBe(false);

    const bounds = deserializeKeyRange(onlyPage.pageBounds);
    for (const d of docs) expect(keyInRange(keyOf(d), bounds)).toBe(true);
  });
});
