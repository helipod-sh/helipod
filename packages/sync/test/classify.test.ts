import { describe, it, expect } from "vitest";
import { classifyByIdRead, rangeReadFromDiffable, type RangeRead } from "../src/classify";
import { serializeKeyRange, keySuccessor, indexKeyspaceId, tableKeyspaceId } from "@stackbase/index-key-codec";

const b = (...n: number[]) => new Uint8Array(n);
const pointRange = (keyspace: string, start: Uint8Array) =>
  serializeKeyRange({ keyspace, start, end: keySuccessor(start) });
const doc = { _id: "docs|abc", n: 1 };

describe("classifyByIdRead", () => {
  it("classifies a single point read in a table keyspace returning one doc", () => {
    const r = classifyByIdRead(doc as never, [pointRange(tableKeyspaceId("3"), b(1, 2, 3))]);
    expect(r).not.toBeNull();
    expect(r!.keyspace).toBe(tableKeyspaceId("3"));
  });
  it("classifies a by-id read returning null (doc absent)", () => {
    const r = classifyByIdRead(null as never, [pointRange(tableKeyspaceId("3"), b(9))]);
    expect(r).not.toBeNull();
  });
  it("RERUN: more than one read range", () => {
    const r = classifyByIdRead(doc as never, [pointRange(tableKeyspaceId("3"), b(1)), pointRange(tableKeyspaceId("3"), b(2))]);
    expect(r).toBeNull();
  });
  it("RERUN: an index keyspace read (a collect/withIndex)", () => {
    const r = classifyByIdRead([doc] as never, [pointRange(indexKeyspaceId("3", "by_x"), b(1))]);
    expect(r).toBeNull();
  });
  it("RERUN: a span (not a point) range", () => {
    const r = classifyByIdRead([doc] as never, [serializeKeyRange({ keyspace: tableKeyspaceId("3"), start: b(1), end: b(5) })]);
    expect(r).toBeNull();
  });
  it("RERUN: an array value even with one point range", () => {
    const r = classifyByIdRead([doc] as never, [pointRange(tableKeyspaceId("3"), b(1))]);
    expect(r).toBeNull();
  });
});

describe("rangeReadFromDiffable (DLR 2b)", () => {
  it("adapts a DiffableRange into a RangeRead verbatim", () => {
    const d = { keyspace: "index:AAA", bounds: { keyspace: "index:AAA", start: "AA", end: "AB" }, filters: [], order: "asc" as const, fields: ["channelId"] };
    const r: RangeRead = rangeReadFromDiffable(d);
    expect(r).toEqual(d);
  });
});
