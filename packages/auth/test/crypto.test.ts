import { describe, it, expect } from "vitest";
import { hashSecret, verifySecret, generateToken } from "../src/crypto";

describe("password hashing", () => {
  it("verifies the correct password and rejects a wrong one", () => {
    const stored = hashSecret("hunter2");
    expect(stored).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
    expect(verifySecret("hunter2", stored)).toBe(true);
    expect(verifySecret("wrong", stored)).toBe(false);
  });
  it("uses a random salt (same password → different stored hashes)", () => {
    expect(hashSecret("x")).not.toBe(hashSecret("x"));
  });
  it("rejects a malformed stored value", () => {
    expect(verifySecret("x", "notvalid")).toBe(false);
  });
  it("generates distinct url-safe tokens", () => {
    const a = generateToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(generateToken());
  });
});
