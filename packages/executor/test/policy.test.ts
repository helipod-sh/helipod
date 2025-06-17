import { describe, it, expect } from "vitest";
import { compileWhere, mergeReadPolicy, evalReadPolicy } from "../src/policy";
import type { FilterExpr } from "@stackbase/query-engine";

describe("compileWhere", () => {
  it("true/undefined → null (no clause); false → always-false", () => {
    expect(compileWhere(true)).toBeNull();
    expect(compileWhere(undefined)).toBeNull();
    expect(compileWhere(false)).toEqual({ op: "or", clauses: [] });
  });

  it("bare value → eq; explicit ops map to comparison ops", () => {
    expect(compileWhere({ userId: "u1" })).toEqual({ op: "eq", field: "userId", value: "u1" });
    expect(compileWhere({ age: { gte: 18 } })).toEqual({ op: "gte", field: "age", value: 18 });
    expect(compileWhere({ n: { ne: 5 } })).toEqual({ op: "neq", field: "n", value: 5 });
  });

  it("multiple fields AND together", () => {
    expect(compileWhere({ a: 1, b: 2 })).toEqual({
      op: "and",
      clauses: [{ op: "eq", field: "a", value: 1 }, { op: "eq", field: "b", value: 2 }],
    });
  });

  it("in → OR-of-eq (empty in → always-false); notIn → AND-of-neq (empty → always-true)", () => {
    expect(compileWhere({ id: { in: ["a", "b"] } })).toEqual({
      op: "or",
      clauses: [{ op: "eq", field: "id", value: "a" }, { op: "eq", field: "id", value: "b" }],
    });
    expect(compileWhere({ id: { in: [] } })).toEqual({ op: "or", clauses: [] });
    expect(compileWhere({ id: { notIn: [] } })).toEqual({ op: "and", clauses: [] });
  });

  it("isNull → eq/neq null", () => {
    expect(compileWhere({ x: { isNull: true } })).toEqual({ op: "eq", field: "x", value: null });
    expect(compileWhere({ x: { isNull: false } })).toEqual({ op: "neq", field: "x", value: null });
  });

  it("AND/OR/NOT compose recursively", () => {
    expect(compileWhere({ NOT: { a: 1 } })).toEqual({ op: "not", clause: { op: "eq", field: "a", value: 1 } });
    expect(compileWhere({ OR: [{ a: 1 }, { b: 2 }] })).toEqual({
      op: "or",
      clauses: [{ op: "eq", field: "a", value: 1 }, { op: "eq", field: "b", value: 2 }],
    });
  });
});

describe("mergeReadPolicy", () => {
  it("null policy leaves existing filters untouched", () => {
    const existing: FilterExpr[] = [{ op: "eq", field: "done", value: false }];
    expect(mergeReadPolicy(existing, null)).toEqual(existing);
    expect(mergeReadPolicy(undefined, null)).toEqual([]);
  });
  it("appends the policy expr (AND semantics: both survive)", () => {
    const existing: FilterExpr[] = [{ op: "eq", field: "done", value: false }];
    const pol: FilterExpr = { op: "eq", field: "userId", value: "u1" };
    expect(mergeReadPolicy(existing, pol)).toEqual([...existing, pol]);
  });
});

describe("evalReadPolicy", () => {
  it("calls the policy's read(rc) and compiles the result", async () => {
    const rc = { auth: { userId: "u1" }, db: {} } as never;
    const expr = await evalReadPolicy({ read: ({ auth }: any) => ({ userId: auth.userId }) }, rc);
    expect(expr).toEqual({ op: "eq", field: "userId", value: "u1" });
    expect(await evalReadPolicy({}, rc)).toBeNull();
  });
});
