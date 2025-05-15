import { describe, it, expect } from "vitest";
import {
  RangeSet,
  rangesOverlap,
  keyInRange,
  keySuccessor,
  writtenTablesFromRanges,
  serializeKeyRange,
  deserializeKeyRange,
  indexKeyspaceId,
  tableKeyspaceId,
  encodeIndexKey,
  type KeyRange,
} from "../src/index";

const ks = indexKeyspaceId("messages", "by_conversation");
const range = (start: number[], end: number[] | null): KeyRange => ({
  keyspace: ks,
  start: new Uint8Array(start),
  end: end === null ? null : new Uint8Array(end),
});

describe("range overlap", () => {
  it("detects overlapping and disjoint half-open intervals", () => {
    expect(rangesOverlap(range([0], [5]), range([3], [9]))).toBe(true);
    expect(rangesOverlap(range([0], [5]), range([5], [9]))).toBe(false); // touching, half-open
    expect(rangesOverlap(range([0], [5]), range([6], [9]))).toBe(false);
    expect(rangesOverlap(range([5], null), range([0], [6]))).toBe(true); // +∞ end
  });

  it("never overlaps across keyspaces", () => {
    const a: KeyRange = { keyspace: tableKeyspaceId("a"), start: new Uint8Array([0]), end: null };
    const b: KeyRange = { keyspace: tableKeyspaceId("b"), start: new Uint8Array([0]), end: null };
    expect(rangesOverlap(a, b)).toBe(false);
  });

  it("keyInRange respects half-open bounds", () => {
    const r = range([2], [5]);
    expect(keyInRange(new Uint8Array([2]), r)).toBe(true);
    expect(keyInRange(new Uint8Array([4]), r)).toBe(true);
    expect(keyInRange(new Uint8Array([5]), r)).toBe(false);
    expect(keyInRange(new Uint8Array([1]), r)).toBe(false);
  });

  it("point ranges contain exactly their key", () => {
    const key = encodeIndexKey(["x"]);
    const point: KeyRange = { keyspace: ks, start: key, end: keySuccessor(key) };
    expect(keyInRange(key, point)).toBe(true);
    expect(keyInRange(encodeIndexKey(["x", 0]), point)).toBe(false);
    expect(keyInRange(encodeIndexKey(["y"]), point)).toBe(false);
  });
});

describe("RangeSet — the read/write-set substrate", () => {
  it("intersects only when a write range overlaps a read range in the same keyspace", () => {
    const reads = new RangeSet();
    reads.add(range([0], [10]));

    const overlappingWrite = new RangeSet();
    overlappingWrite.add(range([5], [6]));
    expect(reads.intersects(overlappingWrite)).toBe(true);

    const disjointWrite = new RangeSet();
    disjointWrite.add(range([20], [30]));
    expect(reads.intersects(disjointWrite)).toBe(false);

    const otherKeyspaceWrite = new RangeSet();
    otherKeyspaceWrite.add({ keyspace: tableKeyspaceId("other"), start: new Uint8Array([5]), end: new Uint8Array([6]) });
    expect(reads.intersects(otherKeyspaceWrite)).toBe(false);
  });

  it("a full-keyspace read intersects any write in that keyspace", () => {
    const reads = new RangeSet();
    reads.addKeyspace(ks);
    const write = new RangeSet();
    write.addKey(ks, encodeIndexKey(["anything"]));
    expect(reads.intersects(write)).toBe(true);
  });

  it("derives the distinct table set for table-level invalidation", () => {
    const ranges: KeyRange[] = [
      { keyspace: indexKeyspaceId("messages", "by_conversation"), start: new Uint8Array(), end: null },
      { keyspace: tableKeyspaceId("messages"), start: new Uint8Array(), end: null },
      { keyspace: tableKeyspaceId("users"), start: new Uint8Array(), end: null },
    ];
    expect(writtenTablesFromRanges(ranges).sort()).toEqual(["messages", "users"]);
  });
});

describe("serialization (cross-process fan-out payload)", () => {
  it("round-trips a key range through base64", () => {
    const original = range([0, 1, 2, 255], [9, 9]);
    const restored = deserializeKeyRange(serializeKeyRange(original));
    expect(restored.keyspace).toBe(original.keyspace);
    expect([...restored.start]).toEqual([...original.start]);
    expect([...(restored.end ?? [])]).toEqual([...(original.end ?? [])]);
  });

  it("preserves a null (+∞) end", () => {
    const restored = deserializeKeyRange(serializeKeyRange(range([0], null)));
    expect(restored.end).toBeNull();
  });
});
