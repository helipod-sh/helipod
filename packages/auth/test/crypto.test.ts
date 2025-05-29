import { describe, it, expect } from "vitest";
import { scryptSync, randomBytes } from "node:crypto";
import { hashSecret, verifySecret, needsRehash, generateToken } from "../src/crypto";

describe("password hashing (argon2id)", () => {
  it("hashes to an argon2id PHC string and verifies", async () => {
    const stored = await hashSecret("hunter2");
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await verifySecret("hunter2", stored)).toBe(true);
    expect(await verifySecret("wrong", stored)).toBe(false);
  });
  it("uses a random salt (same password → different hashes)", async () => {
    expect(await hashSecret("x")).not.toBe(await hashSecret("x"));
  });
  it("still verifies a legacy scrypt secret (migration), and flags it for rehash", async () => {
    const salt = randomBytes(16).toString("hex");
    const legacy = `${salt}:${scryptSync("legacypw", salt, 64).toString("hex")}`;
    expect(await verifySecret("legacypw", legacy)).toBe(true);
    expect(await verifySecret("nope", legacy)).toBe(false);
    expect(needsRehash(legacy)).toBe(true);
    expect(needsRehash(await hashSecret("x"))).toBe(false);
  });
  it("rejects a malformed stored value without throwing", async () => {
    expect(await verifySecret("x", "notvalid")).toBe(false);
  });
  it("generates distinct url-safe tokens", () => {
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateToken()).not.toBe(generateToken());
  });
});
