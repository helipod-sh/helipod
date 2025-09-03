/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * The point-range conversion is the trickiest pure logic in the tailer→sync bridge: a follower
 * derives written `(indexId, key)` pairs and must turn each into the exact same half-open point
 * range the engine records for a point read/write, so `rangesOverlap` matches a subscription's
 * read range. Tested against the SAME `@stackbase/index-key-codec` the engine uses.
 */
import { describe, it, expect } from "vitest";
import {
  RangeSet,
  keySuccessor,
  deserializeKeyRange,
  rangesOverlap,
  encodeIndexKey,
} from "@stackbase/index-key-codec";
import { keyToPointRange } from "../src/node";

describe("keyToPointRange", () => {
  it("produces [key, keySuccessor(key)) with the indexId as keyspace", () => {
    const key = encodeIndexKey(["hello"]);
    const r = keyToPointRange("table:10001", key);
    const back = deserializeKeyRange(r);
    expect(back.keyspace).toBe("table:10001");
    expect([...back.start]).toEqual([...key]);
    expect(back.end).not.toBeNull();
    expect([...(back.end as Uint8Array)]).toEqual([...keySuccessor(key)]);
  });

  it("matches the engine's own point-write encoding (RangeSet.addKey)", () => {
    const keyspace = "index:10001:by_channel";
    const key = encodeIndexKey(["room-1", 42]);

    // Engine side: a query records a point read via RangeSet.addKey.
    const readSet = new RangeSet();
    readSet.addKey(keyspace, key);
    const [readRange] = readSet.toArray();

    // Fleet side: the tailer derived the same written key and converts it to a point range.
    const writeRange = deserializeKeyRange(keyToPointRange(keyspace, key));

    expect(rangesOverlap(writeRange, readRange!)).toBe(true);
  });

  it("does NOT overlap a different key in the same keyspace", () => {
    const keyspace = "table:10001";
    const readSet = new RangeSet();
    readSet.addKey(keyspace, encodeIndexKey(["a"]));
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(keyToPointRange(keyspace, encodeIndexKey(["b"])));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });

  it("does NOT overlap the same key in a different keyspace (index isolation)", () => {
    const key = encodeIndexKey(["x"]);
    const readSet = new RangeSet();
    readSet.addKey("table:10001", key);
    const [readRange] = readSet.toArray();

    const writeRange = deserializeKeyRange(keyToPointRange("index:10001:by_x", key));
    expect(rangesOverlap(writeRange, readRange!)).toBe(false);
  });
});
