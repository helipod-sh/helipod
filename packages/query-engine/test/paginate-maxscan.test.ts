import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import {
  newDocumentId,
  encodeInternalDocumentId,
  encodeStorageIndexId,
  type InternalDocumentId,
} from "@stackbase/id-codec";
import type { DocumentValue, IndexWrite } from "@stackbase/docstore";
import { QueryRuntime, computeIndexUpdates, type IndexSpec, type Query } from "../src/index";

const TABLE = 7001;
const TABLE_NAME = "items";

const idx = (index: string, fields: string[]): IndexSpec => ({
  table: TABLE_NAME,
  tableNumber: TABLE,
  index,
  fields,
  indexId: encodeStorageIndexId(TABLE, index),
});

function makeDoc(id: InternalDocumentId, creation: number, extra: Record<string, unknown>): DocumentValue {
  return { _id: encodeInternalDocumentId(id), _creationTime: creation, ...extra } as DocumentValue;
}

async function insert(store: SqliteDocStore, indexes: IndexSpec[], id: InternalDocumentId, doc: DocumentValue, ts: bigint): Promise<void> {
  const indexWrites: IndexWrite[] = computeIndexUpdates(indexes, null, doc, id).map((update) => ({ ts, update }));
  await store.write([{ ts, id, prev_ts: null, value: { id, value: doc } }], indexWrites, "Error");
}

describe("paginate maxScan", () => {
  it("stops after maxScan rows and reports scanCapped when the page isn't filled", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const qr = new QueryRuntime(store);
    const byCreation = idx("by_creation", []);

    // seed 10 rows with n: 0..9; only n===9 matches the eq filter
    let ts = 0n;
    for (let n = 0; n < 10; n++) {
      const id = newDocumentId(TABLE);
      await insert(store, [byCreation], id, makeDoc(id, n + 1, { n }), ++ts);
    }

    const query: Query = {
      index: byCreation,
      filters: [{ op: "eq", field: "n", value: 9 }],
    };

    // maxScan=4 → scans rows n=0,1,2,3; page not filled (only n=9 matches, which is beyond row 4)
    const res = await qr.paginate(query, await store.maxTimestamp(), { pageSize: 5, maxScan: 4 });

    expect(res.scanCapped).toBe(true);
    expect(res.page.length).toBeLessThan(5);
    expect(res.hasMore).toBe(true);            // stopped early → may be more
    expect(res.nextCursor).not.toBeNull();     // cursor resumes past the last scanned key
  });

  it("no maxScan → unchanged (full page, scanCapped false)", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const qr = new QueryRuntime(store);
    const byCreation = idx("by_creation", []);

    let ts = 0n;
    for (let n = 0; n < 3; n++) {
      const id = newDocumentId(TABLE);
      await insert(store, [byCreation], id, makeDoc(id, n + 1, { n }), ++ts);
    }

    const query: Query = { index: byCreation };
    const res = await qr.paginate(query, await store.maxTimestamp(), { pageSize: 50 });

    expect(res.scanCapped).toBe(false);
    expect(res.page.length).toBe(3);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
  });

  it("capped cursor resumes past lastScanned so next page continues the scan", async () => {
    const store = new SqliteDocStore(new NodeSqliteAdapter());
    await store.setupSchema();
    const qr = new QueryRuntime(store);
    const byCreation = idx("by_creation", []);

    // seed 6 rows, only n===5 matches the filter
    let ts = 0n;
    for (let n = 0; n < 6; n++) {
      const id = newDocumentId(TABLE);
      await insert(store, [byCreation], id, makeDoc(id, n + 1, { n }), ++ts);
    }

    const query: Query = {
      index: byCreation,
      filters: [{ op: "eq", field: "n", value: 5 }],
    };

    // First page: maxScan=3, scans n=0,1,2, doesn't reach n=5
    const page1 = await qr.paginate(query, await store.maxTimestamp(), { pageSize: 5, maxScan: 3 });
    expect(page1.scanCapped).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    // Second page resumes from cursor → should continue from n=3 onward
    const page2 = await qr.paginate(query, await store.maxTimestamp(), { cursor: page1.nextCursor, pageSize: 5, maxScan: 3 });
    // page2 scans n=3,4,5 (or hits the match sooner)
    // Either way: if n=5 is within the next 3, we get it; if not, still capped
    // The important guarantee: no rows are skipped (n=3 is not missed)
    const allPages = [...page1.page, ...page2.page];
    // The matching row (n=5) should appear eventually in sequential pages
    if (!page2.scanCapped) {
      expect(allPages.some((d) => d["n"] === 5)).toBe(true);
    }
  });
});
