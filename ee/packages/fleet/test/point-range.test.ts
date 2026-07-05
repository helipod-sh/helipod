/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * The point-range conversion is the trickiest pure logic in the tailer→sync bridge: a follower
 * derives written `(indexId, key)` pairs straight from the Postgres `indexes` table — where
 * `index_id` is the STORAGE index id (`encodeStorageIndexId`'s `"<tableNumber>/<indexName>"`, e.g.
 * `"10001/by_creation"`) — and must turn each into the exact same half-open point range the engine
 * records for a point read/write under the engine's KEYSPACE id (`indexKeyspaceId`'s
 * `"index:<table>:<name>"`), so `rangesOverlap` matches a subscription's read range.
 *
 * These two id spaces are NOT interchangeable strings — feeding a storage index id straight through
 * as a keyspace (the original bug this test now guards against) produces ranges that silently never
 * overlap anything, because `rangesOverlap`/`RangeSet` compare keyspace strings for exact equality.
 * So every assertion here feeds `keyToPointRange` a real storage `index_id` (as it would actually
 * come out of the `indexes.index_id` column) and compares against the engine's OWN
 * `indexKeyspaceId`/`RangeSet` helpers — never a hand-rolled expected string.
 */
import { describe, it, expect } from "vitest";
import {
  RangeSet,
  keySuccessor,
  deserializeKeyRange,
  rangesOverlap,
  encodeIndexKey,
  indexKeyspaceId,
  tableKeyspaceId,
} from "@helipod/index-key-codec";
import {
  encodeStorageIndexId,
  encodeStorageTableId,
  keyToPointRange as canonicalKeyToPointRange,
  docKeyToPointRange as canonicalDocKeyToPointRange,
} from "@helipod/id-codec";
import { keyToPointRange, docKeyToPointRange } from "../src/node";

describe("keyToPointRange", () => {
  it("rebuilds the engine's index keyspace id from a real storage index_id, not the raw storage id", () => {
    const storageIndexId = encodeStorageIndexId(10001, "by_creation"); // "10001/by_creation" — as stored in indexes.index_id
    const key = encodeIndexKey(["hello"]);

    const r = keyToPointRange(storageIndexId, key);
    const back = deserializeKeyRange(r);

    // Must equal the ENGINE's own keyspace helper output, not the storage id verbatim.
    expect(back.keyspace).toBe(indexKeyspaceId(encodeStorageTableId(10001), "by_creation"));
    expect(back.keyspace).not.toBe(storageIndexId); // guards against the original bug
    expect([...back.start]).toEqual([...key]);
    expect(back.end).not.toBeNull();
    expect([...(back.end as Uint8Array)]).toEqual([...keySuccessor(key)]);
  });

  it("matches the engine's own point-write encoding end to end: a real index_id derives a range that overlaps a subscription's RangeSet-recorded read range", () => {
    const tableNumber = 10001;
    const indexName = "by_channel";
    const storageIndexId = encodeStorageIndexId(tableNumber, indexName); // what the tailer reads from Postgres
    const key = encodeIndexKey(["room-1", 42]);

    // Engine side: a subscribed query records a point read via RangeSet.addKey, keyed by the
    // engine's own keyspace id — exactly what `query-runtime.ts`'s `keyspace()` computes.
    const readSet = new RangeSet();
    readSet.addKey(indexKeyspaceId(encodeStorageTableId(tableNumber), indexName), key);
    const [readRange] = readSet.toArray();

    // Fleet side: the tailer derived the same written key (as a raw storage index_id) and converts
    // it to a point range via the bridge under test.
    const writeRange = deserializeKeyRange(keyToPointRange(storageIndexId, key));

    expect(rangesOverlap(writeRange, readRange!)).toBe(true);
  });

  it("does NOT overlap a different key in the same index", () => {
    const storageIndexId = encodeStorageIndexId(10001, "by_creation");
    const readSet = new RangeSet();
    readSet.addKey(indexKeyspaceId(encodeStorageTableId(10001), "by_creation"), encodeIndexKey(["a"]));
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(keyToPointRange(storageIndexId, encodeIndexKey(["b"])));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("does NOT overlap the same key in a different index (index isolation)", () => {
    const key = encodeIndexKey(["x"]);
    const readSet = new RangeSet();
    readSet.addKey(indexKeyspaceId(encodeStorageTableId(10001), "by_creation"), key);
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(keyToPointRange(encodeStorageIndexId(10001, "by_x"), key));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("does NOT overlap the same key/index number in a DIFFERENT table (table isolation)", () => {
    const key = encodeIndexKey(["x"]);
    const readSet = new RangeSet();
    readSet.addKey(indexKeyspaceId(encodeStorageTableId(10001), "by_creation"), key);
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(keyToPointRange(encodeStorageIndexId(10002, "by_creation"), key));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("is distinct from the table-level keyspace for the same table number (no accidental collision with tableKeyspaceId)", () => {
    const storageIndexId = encodeStorageIndexId(10001, "by_creation");
    const key = encodeIndexKey(["a"]);
    const writeRange = deserializeKeyRange(keyToPointRange(storageIndexId, key));
    expect(writeRange.keyspace).not.toBe(tableKeyspaceId(encodeStorageTableId(10001)));
  });
});

/**
 * `docKeyToPointRange` is the DOCUMENT-keyspace counterpart to `keyToPointRange` above: it
 * converts a `(table_id, internal_id)` pair read straight from the Postgres `documents` table
 * (`DerivedInvalidation.writtenDocs`) into the point range a bare `ctx.db.get(id)` read records.
 *
 * The ground truth for that read range is `packages/transactor/src/single-writer-transactor.ts`:
 * `docKeyspace(id)` is `tableKeyspaceId(encodeStorageTableId(id.tableNumber))`, and
 * `TransactionContextImpl.get()` records it via `this.reads.addKey(docKeyspace(id), id.internalId)`.
 * Every assertion below reproduces that exact composition with the engine's own exported helpers
 * (`tableKeyspaceId`, `encodeStorageTableId`, `RangeSet.addKey`) — never a hand-rolled string —
 * so a passing test proves the fleet bridge's derived range is byte-for-byte what the local
 * commit path would have produced for the same document write.
 */
describe("docKeyToPointRange", () => {
  it("produces the document-keyspace point range for a written doc, matching the transactor's own docKeyspace() composition", () => {
    const tableNumber = 10001;
    const tableId = encodeStorageTableId(tableNumber); // what documents.table_id actually stores
    const internalId = new Uint8Array([1, 2, 3, 4]);

    const r = docKeyToPointRange(tableId, internalId);
    const back = deserializeKeyRange(r);

    // Ground truth: single-writer-transactor.ts's docKeyspace(id) = tableKeyspaceId(encodeStorageTableId(id.tableNumber)).
    expect(back.keyspace).toBe(tableKeyspaceId(encodeStorageTableId(tableNumber)));
    expect([...back.start]).toEqual([...internalId]);
    expect(back.end).not.toBeNull();
    expect([...(back.end as Uint8Array)]).toEqual([...keySuccessor(internalId)]);
  });

  it("matches the engine's own point-write encoding end to end: a written doc's derived range overlaps a ctx.db.get-style recorded read range", () => {
    const tableNumber = 10001;
    const tableId = encodeStorageTableId(tableNumber);
    const internalId = new Uint8Array([9, 9, 9]);

    // Engine side: a bare `ctx.db.get(id)` records its read exactly this way — see
    // `TransactionContextImpl.get()`'s `this.reads.addKey(docKeyspace(id), id.internalId)`.
    const readSet = new RangeSet();
    readSet.addKey(tableKeyspaceId(encodeStorageTableId(tableNumber)), internalId);
    const [readRange] = readSet.toArray();

    // Fleet side: the tailer derived the same written (table_id, internal_id) pair straight from
    // the `documents` table and converts it via the bridge under test.
    const writeRange = deserializeKeyRange(docKeyToPointRange(tableId, internalId));

    expect(rangesOverlap(writeRange, readRange!)).toBe(true);
  });

  it("does NOT overlap a different document id in the same table", () => {
    const tableNumber = 10001;
    const readSet = new RangeSet();
    readSet.addKey(tableKeyspaceId(encodeStorageTableId(tableNumber)), new Uint8Array([1]));
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(docKeyToPointRange(encodeStorageTableId(tableNumber), new Uint8Array([2])));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("does NOT overlap the same internal id in a DIFFERENT table (table isolation)", () => {
    const internalId = new Uint8Array([5]);
    const readSet = new RangeSet();
    readSet.addKey(tableKeyspaceId(encodeStorageTableId(10001)), internalId);
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(docKeyToPointRange(encodeStorageTableId(10002), internalId));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("does NOT overlap an index-keyspace read on the same table/key (keyspace isolation from indexes)", () => {
    const tableNumber = 10001;
    const key = new Uint8Array([7]);
    const readSet = new RangeSet();
    readSet.addKey(indexKeyspaceId(encodeStorageTableId(tableNumber), "by_creation"), key);
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(docKeyToPointRange(encodeStorageTableId(tableNumber), key));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });
});

/**
 * Task 8.1b (Tier 3 Slice 8) — `keyToPointRange`/`docKeyToPointRange` were extracted verbatim out of
 * this package into `@helipod/id-codec` (see that package's `point-range.ts`), with `ee/packages/
 * fleet/src/ranges.ts` reduced to a thin re-export. This is the golden-value proof the extraction
 * didn't change a byte: fleet's own re-exported functions (imported here, as everywhere else in this
 * file, via `../src/node`) and the canonical `@helipod/id-codec` functions produce IDENTICAL
 * `SerializedKeyRange` output for the same inputs.
 */
describe("extraction parity: fleet's re-export vs the canonical @helipod/id-codec functions", () => {
  it("keyToPointRange: identical output for the same (indexId, key)", () => {
    const storageIndexId = encodeStorageIndexId(10001, "by_creation");
    const key = encodeIndexKey(["hello", 42]);

    expect(keyToPointRange(storageIndexId, key)).toEqual(canonicalKeyToPointRange(storageIndexId, key));
  });

  it("docKeyToPointRange: identical output for the same (tableId, internalId)", () => {
    const tableId = encodeStorageTableId(10001);
    const internalId = new Uint8Array([1, 2, 3, 4]);

    expect(docKeyToPointRange(tableId, internalId)).toEqual(canonicalDocKeyToPointRange(tableId, internalId));
  });

  it("fleet's re-export IS the canonical function (same reference, not just equal output)", () => {
    expect(keyToPointRange).toBe(canonicalKeyToPointRange);
    expect(docKeyToPointRange).toBe(canonicalDocKeyToPointRange);
  });
});
