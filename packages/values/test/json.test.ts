import { describe, it, expect } from "vitest";
import { convexToJson, jsonToConvex, valuesEqual, type Value } from "../src/index";

const bytes = (arr: number[]): ArrayBuffer => new Uint8Array(arr).buffer;

describe("convexToJson / jsonToConvex round-trip", () => {
  const cases: Value[] = [
    null,
    true,
    false,
    0,
    -1.5,
    3.141592653589793,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0n,
    -5n,
    9007199254740993n, // beyond Number.MAX_SAFE_INTEGER — must survive as int64
    "",
    "héllo 🌍",
    bytes([0, 1, 2, 255]),
    [1, "two", 3n, true, null],
    { a: 1, nested: { b: [2, 3], c: bytes([9]) } },
  ];

  it("round-trips every value type", () => {
    for (const value of cases) {
      const restored = jsonToConvex(convexToJson(value));
      expect(valuesEqual(restored, value)).toBe(true);
    }
  });

  it("encodes non-native types with tagged objects", () => {
    expect(convexToJson(5n)).toHaveProperty("$integer");
    expect(convexToJson(bytes([1]))).toHaveProperty("$bytes");
    expect(convexToJson(Number.POSITIVE_INFINITY)).toHaveProperty("$float");
  });

  it("leaves native JSON types untouched", () => {
    expect(convexToJson(3.5)).toBe(3.5);
    expect(convexToJson("hi")).toBe("hi");
    expect(convexToJson(true)).toBe(true);
    expect(convexToJson(null)).toBe(null);
    expect(convexToJson([1, 2])).toEqual([1, 2]);
  });

  it("produces JSON.stringify-safe output", () => {
    const json = convexToJson({ id: 7n, blob: bytes([1, 2]), name: "x" });
    expect(() => JSON.stringify(json)).not.toThrow();
    const restored = jsonToConvex(JSON.parse(JSON.stringify(json)));
    expect(valuesEqual(restored, { id: 7n, blob: bytes([1, 2]), name: "x" })).toBe(true);
  });
});
