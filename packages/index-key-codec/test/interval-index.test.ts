import { describe, it, expect } from "vitest";
import { IntervalIndex } from "../src/interval-index";
import type { KeyRange } from "../src/range";
import { keySuccessor } from "../src/range";

const KS = "t/idx";
const b = (...n: number[]) => new Uint8Array(n);
function point(key: Uint8Array, ks = KS): KeyRange { return { keyspace: ks, start: key, end: keySuccessor(key) }; }
function span(start: Uint8Array, end: Uint8Array | null, ks = KS): KeyRange { return { keyspace: ks, start, end }; }

describe("IntervalIndex", () => {
  it("stabs a point that lands inside a span", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["A"]);
    expect(idx.queryOverlaps(point(b(9)))).toEqual([]); // end is exclusive
    expect(idx.queryOverlaps(point(b(0)))).toEqual([]);
  });

  it("returns all overlapping ranges including nested and wide", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(0), null), "ALL");           // whole keyspace, +∞
    idx.insert(span(b(1), b(9)), "WIDE");
    idx.insert(span(b(4), b(6)), "NARROW");
    idx.insert(point(b(2)), "PT2");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["ALL", "NARROW", "WIDE"]);
    expect(idx.queryOverlaps(point(b(2))).sort()).toEqual(["ALL", "PT2", "WIDE"]);
  });

  it("keeps values in different keyspaces independent", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9), "ks1"), "A");
    idx.insert(span(b(1), b(9), "ks2"), "B");
    expect(idx.queryOverlaps(span(b(5), b(6), "ks1"))).toEqual(["A"]);
    expect(idx.queryOverlaps(span(b(5), b(6), "ks2"))).toEqual(["B"]);
  });

  it("supports two values on identical bounds", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    idx.insert(span(b(1), b(9)), "B");
    expect(idx.queryOverlaps(point(b(5))).sort()).toEqual(["A", "B"]);
  });

  it("insert is idempotent for the same (bounds,value); remove deletes the exact entry", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(1), b(9)), "A");
    idx.insert(span(b(1), b(9)), "A"); // idempotent
    expect(idx.size).toBe(1);
    idx.insert(span(b(1), b(9)), "B");
    idx.remove(span(b(1), b(9)), "A");
    expect(idx.queryOverlaps(point(b(5)))).toEqual(["B"]);
    expect(idx.size).toBe(1);
    idx.remove(span(b(1), b(9)), "B");
    expect(idx.size).toBe(0);
    expect(idx.queryOverlaps(point(b(5)))).toEqual([]);
  });

  it("survives churn and stays correct (insert/remove interleaved)", () => {
    const idx = new IntervalIndex<string>();
    for (let i = 0; i < 200; i++) idx.insert(point(b(i)), `v${i}`);
    for (let i = 0; i < 200; i += 2) idx.remove(point(b(i)), `v${i}`);
    expect(idx.size).toBe(100);
    expect(idx.queryOverlaps(point(b(3)))).toEqual(["v3"]);
    expect(idx.queryOverlaps(point(b(4)))).toEqual([]); // removed
  });

  it("handles +∞ (null end) in the augmentation prune", () => {
    const idx = new IntervalIndex<string>();
    idx.insert(span(b(10), null), "TAIL"); // [10, +∞)
    idx.insert(span(b(1), b(2)), "LOW");
    expect(idx.queryOverlaps(point(b(50))).sort()).toEqual(["TAIL"]);
    expect(idx.queryOverlaps(point(b(1))).sort()).toEqual(["LOW"]);
  });
});
