import { describe, it, expect } from "vitest";
import { v, validate, validatorFromJson, type AnyValidator } from "../src";

/** A rebuilt validator must accept/reject exactly what the original does. */
function agrees(orig: AnyValidator, good: unknown, bad: unknown) {
  const rebuilt = validatorFromJson(orig.toJSON());
  expect(validate(rebuilt, good as never)).toEqual([]);
  expect(validate(rebuilt, bad as never).length).toBeGreaterThan(0);
}

describe("validatorFromJson", () => {
  it("round-trips scalar validators", () => {
    agrees(v.string(), "x", 1);
    agrees(v.number(), 1, "x");
    agrees(v.int64(), 1n, 1);
    agrees(v.boolean(), true, "x");
    agrees(v.null(), null, 1);
    agrees(v.id("users"), "abc", 1);
    agrees(v.literal("a"), "a", "b");
  });

  it("round-trips containers (array/record/union/object) and optional", () => {
    agrees(v.array(v.number()), [1, 2], [1, "x"]);
    agrees(v.record(v.string(), v.number()), { a: 1 }, { a: "x" });
    agrees(v.union(v.literal("a"), v.literal("b")), "b", "c");
    // object: strict — missing required and extra field both fail
    const obj = v.object({ a: v.number(), b: v.optional(v.string()) });
    const rebuilt = validatorFromJson(obj.toJSON());
    expect(validate(rebuilt, { a: 1 } as never)).toEqual([]); // b optional → omission ok
    expect(validate(rebuilt, { a: 1, b: "y" } as never)).toEqual([]);
    expect(validate(rebuilt, { a: "x" } as never).length).toBeGreaterThan(0); // wrong type
    expect(validate(rebuilt, {} as never).length).toBeGreaterThan(0); // missing required a
    expect(validate(rebuilt, { a: 1, c: 9 } as never).length).toBeGreaterThan(0); // extra field
  });

  it("round-trips nested objects", () => {
    const nested = v.object({ inner: v.object({ n: v.number() }) });
    const rebuilt = validatorFromJson(nested.toJSON());
    expect(validate(rebuilt, { inner: { n: 1 } } as never)).toEqual([]);
    expect(validate(rebuilt, { inner: { n: "x" } } as never).length).toBeGreaterThan(0);
  });
});
