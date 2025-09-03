/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
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
} from "@stackbase/index-key-codec";
import { encodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";
import { keyToPointRange } from "../src/node";

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
