// packages/admin/test/auth.test.ts
import { describe, it, expect } from "vitest";
import { generateAdminKey, verifyAdminKey } from "../src/auth";

describe("admin key", () => {
  it("generates distinct url-safe keys", () => {
    const a = generateAdminKey();
    const b = generateAdminKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("verifies only the exact key (constant-time, undefined-safe)", () => {
    const key = generateAdminKey();
    expect(verifyAdminKey(key, key)).toBe(true);
    expect(verifyAdminKey(key, key + "x")).toBe(false);
    expect(verifyAdminKey(key, "nope")).toBe(false);
    expect(verifyAdminKey(key, undefined)).toBe(false);
  });
});
