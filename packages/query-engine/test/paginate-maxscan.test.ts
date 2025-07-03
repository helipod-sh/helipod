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

    // Walk all pages via capped cursors (maxScan=3 forces multiple capped pages).
    // Collect every returned doc unconditionally — proves no row is skipped and
    // no row is duplicated across page boundaries regardless of how many caps fire.
    const snapshot = await store.maxTimestamp();
    const allDocs: unknown[] = [];
    let cursor: string | null = null;
    let iterations = 0;
    const MAX_ITERATIONS = 50; // guard against infinite loop if hasMore is bugged

    do {
      const result = await qr.paginate(query, snapshot, {
        cursor,
        pageSize: 5,
        maxScan: 3,
      });
      allDocs.push(...result.page);
      cursor = result.nextCursor;
      iterations++;
      if (iterations > MAX_ITERATIONS) {
        throw new Error(`paginate walk exceeded ${MAX_ITERATIONS} iterations — possible infinite loop`);
      }
      if (!result.hasMore) break;
    } while (cursor !== null);

    // The matching row (n===5) must appear in the collected set — unconditionally,
    // even when every individual page was scanCapped.
    expect(allDocs.some((d) => (d as Record<string, unknown>)["n"] === 5)).toBe(true);

    // No duplicates: every doc identity (_id) appears exactly once.
    const ids = allDocs.map((d) => (d as Record<string, unknown>)["_id"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
