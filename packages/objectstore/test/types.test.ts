import { describe, expect, it } from "vitest";
import { CasConflict, isCasConflict } from "../src/types";

describe("CasConflict", () => {
  it("has the expected name, code, and Error-ness", () => {
    const err = new CasConflict();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("CasConflict");
    expect(err.code).toBe("CAS_CONFLICT");
  });

  it("carries a default message", () => {
    const err = new CasConflict();
    expect(err.message).toBe("object-store CAS conflict (If-Match etag moved)");
  });

  it("accepts a custom message", () => {
    const err = new CasConflict("custom message");
    expect(err.message).toBe("custom message");
  });
});

describe("isCasConflict", () => {
  it("is true for a real CasConflict", () => {
    expect(isCasConflict(new CasConflict())).toBe(true);
  });

  it("is false for a plain Error", () => {
    expect(isCasConflict(new Error("x"))).toBe(false);
  });

  it("is false for null/undefined", () => {
    expect(isCasConflict(null)).toBe(false);
    expect(isCasConflict(undefined)).toBe(false);
  });

  it("is true structurally, e.g. across a dist/src or realm boundary", () => {
    expect(isCasConflict({ code: "CAS_CONFLICT" })).toBe(true);
  });
});
