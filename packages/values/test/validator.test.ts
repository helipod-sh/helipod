import { describe, it, expect } from "vitest";
import { v, validate, isValid, convexToJson, jsonToConvex, valuesEqual, type Value } from "../src/index";

const message = v.object({
  body: v.string(),
  authorId: v.id("users"),
  pinned: v.optional(v.boolean()),
  tags: v.array(v.string()),
});

describe("v.object validation", () => {
  it("accepts a valid document (optional field absent)", () => {
    expect(validate(message, { body: "hi", authorId: "u1", tags: [] })).toEqual([]);
  });

  it("accepts the optional field when present", () => {
    expect(isValid(message, { body: "hi", authorId: "u1", pinned: true, tags: ["x"] })).toBe(true);
  });

  it("rejects a missing required field", () => {
    const failures = validate(message, { authorId: "u1", tags: [] });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.path).toBe("body");
    expect(failures[0]!.message).toMatch(/missing required field/);
  });

  it("rejects an extra field", () => {
    const failures = validate(message, { body: "hi", authorId: "u1", tags: [], oops: 1 });
    expect(failures.some((f) => f.path === "oops")).toBe(true);
  });

  it("rejects a wrong field type", () => {
    const failures = validate(message, { body: 123, authorId: "u1", tags: [] } as unknown as Value);
    expect(failures.some((f) => f.path === "body")).toBe(true);
  });

  it("reports nested array element paths", () => {
    const failures = validate(message, { body: "hi", authorId: "u1", tags: ["ok", 5] } as unknown as Value);
    expect(failures.some((f) => f.path === "tags[1]")).toBe(true);
  });
});

describe("scalar and composite validators", () => {
  it("union matches any member", () => {
    const status = v.union(v.literal("open"), v.literal("closed"));
    expect(isValid(status, "open")).toBe(true);
    expect(isValid(status, "closed")).toBe(true);
    expect(isValid(status, "other")).toBe(false);
  });

  it("distinguishes float64 from int64", () => {
    expect(isValid(v.number(), 1)).toBe(true);
    expect(isValid(v.number(), 1n)).toBe(false);
    expect(isValid(v.int64(), 1n)).toBe(true);
    expect(isValid(v.int64(), 1)).toBe(false);
  });

  it("v.any accepts anything", () => {
    expect(isValid(v.any(), { whatever: [1, 2n, "x"] })).toBe(true);
  });
});

describe("validator JSON form", () => {
  it("serializes object fields with optionality", () => {
    const json = message.toJSON();
    expect(json.type).toBe("object");
    if (json.type !== "object") throw new Error("unreachable");
    expect(json.value.body).toEqual({ fieldType: { type: "string" }, optional: false });
    expect(json.value.pinned).toEqual({ fieldType: { type: "boolean" }, optional: true });
    expect(json.value.authorId).toEqual({ fieldType: { type: "id", tableName: "users" }, optional: false });
  });
});

describe("validated value round-trips through convexToJson", () => {
  it("validate-then-encode-then-decode preserves the document", () => {
    const doc: Value = { body: "hi", authorId: "u1", pinned: true, tags: ["a", "b"] };
    expect(validate(message, doc)).toEqual([]);
    const restored = jsonToConvex(convexToJson(doc));
    expect(valuesEqual(restored, doc)).toBe(true);
    expect(validate(message, restored)).toEqual([]);
  });
});
