import { describe, it, expect } from "vitest";
import { compareValues, valuesEqual, type Value } from "../src/index";

// A strictly-ascending sequence spanning every type rank:
// null < boolean < number(float64) < bigint(int64) < string < bytes < array < object
const bytes = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer;

const ascending: Value[] = [
  null,
  false,
  true,
  -1.5,
  0,
  3.14,
  Number.NaN, // NaN sorts last among numbers
  -5n,
  0n,
  99n, // every bigint sorts after every number
  "",
  "a",
  "abc",
  "b",
  bytes([]),
  bytes([0]),
  bytes([1]),
  bytes([1, 2]),
  [],
  [1],
  [1, 2],
  {},
  { a: 1 },
  { a: 2 },
  { b: 1 },
];

describe("compareValues — total order", () => {
  it("is strictly increasing along the canonical sequence", () => {
    for (let i = 0; i + 1 < ascending.length; i++) {
      const a = ascending[i]!;
      const b = ascending[i + 1]!;
      expect(compareValues(a, b)).toBe(-1);
      expect(compareValues(b, a)).toBe(1);
    }
  });

  it("is reflexive (x compares equal to itself)", () => {
    for (const x of ascending) expect(compareValues(x, x)).toBe(0);
  });

  it("sorts a shuffled copy back to canonical order", () => {
    const shuffled = [...ascending].reverse();
    shuffled.sort(compareValues);
    for (let i = 0; i < ascending.length; i++) {
      expect(valuesEqual(shuffled[i]!, ascending[i]!)).toBe(true);
    }
  });

  it("is a consistent comparator (antisymmetry + sign coherence) across all pairs", () => {
    for (const a of ascending) {
      for (const b of ascending) {
        const ab = compareValues(a, b);
        const ba = compareValues(b, a);
        // `===` (not Object.is) so that 0 === -0; antisymmetry: cmp(a,b) === -cmp(b,a).
        expect(ab === -ba).toBe(true);
      }
    }
  });

  it("ranks types correctly across the boundaries", () => {
    expect(compareValues(true, 0)).toBe(-1); // boolean < number
    expect(compareValues(999, 0n)).toBe(-1); // number < bigint
    expect(compareValues("z", bytes([0]))).toBe(-1); // string < bytes
    expect(compareValues([1, 2], { a: 1 })).toBe(-1); // array < object
    expect(compareValues(null, false)).toBe(-1); // null first
  });

  it("compares structurally for arrays and objects", () => {
    expect(valuesEqual([1, "x", true], [1, "x", true])).toBe(true);
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true); // key order irrelevant
    expect(valuesEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(compareValues([1], [1, 2])).toBe(-1); // prefix sorts first
  });

  it("keeps float64 and int64 distinct (never equal)", () => {
    expect(valuesEqual(1, 1n)).toBe(false);
    expect(compareValues(1, 1n)).toBe(-1);
  });
});
