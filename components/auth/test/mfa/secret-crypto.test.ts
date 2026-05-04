import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { decodeKeyMaterial, encryptSecret, decryptSecret, type MfaKey } from "../../src/mfa/secret-crypto";

function makeKey(id: string): MfaKey {
  return { id, key: randomBytes(32) };
}

describe("decodeKeyMaterial", () => {
  it("accepts a 32-byte key given as base64", () => {
    const raw = randomBytes(32);
    const decoded = decodeKeyMaterial(raw.toString("base64"));
    expect(decoded.equals(raw)).toBe(true);
  });

  it("accepts a 32-byte key given as hex", () => {
    const raw = randomBytes(32);
    const decoded = decodeKeyMaterial(raw.toString("hex"));
    expect(decoded.equals(raw)).toBe(true);
  });

  it("throws on a key of the wrong length", () => {
    expect(() => decodeKeyMaterial(randomBytes(16).toString("base64"))).toThrow();
    expect(() => decodeKeyMaterial(randomBytes(16).toString("hex"))).toThrow();
  });

  it("throws on garbage input", () => {
    expect(() => decodeKeyMaterial("not-a-valid-key-at-all!!")).toThrow();
  });
});

describe("encryptSecret / decryptSecret (AES-256-GCM envelope)", () => {
  it("round-trips: encrypt then decrypt returns the original plaintext", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "JBSWY3DPEHPK3PXP", "user_123");
    expect(decryptSecret(keyring, envelope, "user_123")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("produces the v1.<keyId>.<iv>.<ct>.<tag> envelope shape, using keyring[0] as the encrypting key", () => {
    const keyring = [makeKey("primary"), makeKey("secondary")];
    const envelope = encryptSecret(keyring, "some-secret", "user_abc");
    const parts = envelope.split(".");
    expect(parts).toHaveLength(5);
    const [version, keyId, iv, ct, tag] = parts;
    expect(version).toBe("v1");
    expect(keyId).toBe("primary");
    // base64url-ish: no padding, no +/ characters
    expect(iv).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ct).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tag).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("uses a fresh random IV each time (same plaintext -> different envelopes)", () => {
    const keyring = [makeKey("1")];
    const a = encryptSecret(keyring, "same-secret", "user_1");
    const b = encryptSecret(keyring, "same-secret", "user_1");
    expect(a).not.toBe(b);
    expect(decryptSecret(keyring, a, "user_1")).toBe("same-secret");
    expect(decryptSecret(keyring, b, "user_1")).toBe("same-secret");
  });

  it("fails to decrypt under the wrong aadUserId (AAD binding)", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "top-secret", "user_owner");
    expect(() => decryptSecret(keyring, envelope, "user_attacker")).toThrow();
  });

  it("fails to decrypt with the wrong key", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "top-secret", "user_1");
    const wrongKeyring = [{ id: "1", key: randomBytes(32) }];
    expect(() => decryptSecret(wrongKeyring, envelope, "user_1")).toThrow();
  });

  it("dispatches on the stored keyId to pick the right key from the keyring", () => {
    const keyA = makeKey("a");
    const keyB = makeKey("b");
    const envelope = encryptSecret([keyB, keyA], "dispatch-me", "user_1"); // keyB is primary
    // decrypting keyring order shouldn't matter, only the id lookup
    expect(decryptSecret([keyA, keyB], envelope, "user_1")).toBe("dispatch-me");
  });

  it("throws a generic error when the stored keyId is absent from the keyring", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "secret", "user_1");
    expect(() => decryptSecret([makeKey("2")], envelope, "user_1")).toThrow();
  });

  it("supports key rotation: a secret encrypted under a one-key ring still decrypts after a second (newer) key is prepended", () => {
    const oldKey = makeKey("old");
    const envelope = encryptSecret([oldKey], "rotate-me", "user_1");
    const newKey = makeKey("new");
    const rotatedKeyring = [newKey, oldKey]; // new key is now primary
    expect(decryptSecret(rotatedKeyring, envelope, "user_1")).toBe("rotate-me");
    // new encryptions now use the new primary key
    const freshEnvelope = encryptSecret(rotatedKeyring, "fresh-secret", "user_1");
    expect(freshEnvelope.split(".")[1]).toBe("new");
    expect(decryptSecret(rotatedKeyring, freshEnvelope, "user_1")).toBe("fresh-secret");
  });

  it("fails to decrypt a tampered ciphertext", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "immutable-secret", "user_1");
    const [version, keyId, iv, ct = "", tag] = envelope.split(".");
    const tamperedCt = ct.slice(0, -2) + (ct.slice(-2) === "AA" ? "BB" : "AA");
    const tampered = [version, keyId, iv, tamperedCt, tag].join(".");
    expect(() => decryptSecret(keyring, tampered, "user_1")).toThrow();
  });

  it("fails to decrypt a tampered auth tag", () => {
    const keyring = [makeKey("1")];
    const envelope = encryptSecret(keyring, "immutable-secret", "user_1");
    const [version, keyId, iv, ct, tag = ""] = envelope.split(".");
    const tamperedTag = tag.slice(0, -2) + (tag.slice(-2) === "AA" ? "BB" : "AA");
    const tampered = [version, keyId, iv, ct, tamperedTag].join(".");
    expect(() => decryptSecret(keyring, tampered, "user_1")).toThrow();
  });

  it("rejects a malformed envelope (wrong version or wrong part count)", () => {
    const keyring = [makeKey("1")];
    expect(() => decryptSecret(keyring, "not-an-envelope", "user_1")).toThrow();
    expect(() => decryptSecret(keyring, "v2.1.aa.bb.cc", "user_1")).toThrow();
  });
});
