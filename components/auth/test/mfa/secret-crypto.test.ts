import { describe, it, expect } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
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
  it("round-trips: encrypt then decrypt returns the original plaintext", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "JBSWY3DPEHPK3PXP", "user_123");
    expect(await decryptSecret(keyring, envelope, "user_123")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("produces the v1.<keyId>.<iv>.<ct>.<tag> envelope shape, using keyring[0] as the encrypting key", async () => {
    const keyring = [makeKey("primary"), makeKey("secondary")];
    const envelope = await encryptSecret(keyring, "some-secret", "user_abc");
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

  it("uses a fresh random IV each time (same plaintext -> different envelopes)", async () => {
    const keyring = [makeKey("1")];
    const a = await encryptSecret(keyring, "same-secret", "user_1");
    const b = await encryptSecret(keyring, "same-secret", "user_1");
    expect(a).not.toBe(b);
    expect(await decryptSecret(keyring, a, "user_1")).toBe("same-secret");
    expect(await decryptSecret(keyring, b, "user_1")).toBe("same-secret");
  });

  it("fails to decrypt under the wrong aadUserId (AAD binding)", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "top-secret", "user_owner");
    await expect(decryptSecret(keyring, envelope, "user_attacker")).rejects.toThrow();
  });

  it("fails to decrypt with the wrong key", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "top-secret", "user_1");
    const wrongKeyring = [{ id: "1", key: randomBytes(32) }];
    await expect(decryptSecret(wrongKeyring, envelope, "user_1")).rejects.toThrow();
  });

  it("dispatches on the stored keyId to pick the right key from the keyring", async () => {
    const keyA = makeKey("a");
    const keyB = makeKey("b");
    const envelope = await encryptSecret([keyB, keyA], "dispatch-me", "user_1"); // keyB is primary
    // decrypting keyring order shouldn't matter, only the id lookup
    expect(await decryptSecret([keyA, keyB], envelope, "user_1")).toBe("dispatch-me");
  });

  it("throws a generic error when the stored keyId is absent from the keyring", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "secret", "user_1");
    await expect(decryptSecret([makeKey("2")], envelope, "user_1")).rejects.toThrow();
  });

  it("supports key rotation: a secret encrypted under a one-key ring still decrypts after a second (newer) key is prepended", async () => {
    const oldKey = makeKey("old");
    const envelope = await encryptSecret([oldKey], "rotate-me", "user_1");
    const newKey = makeKey("new");
    const rotatedKeyring = [newKey, oldKey]; // new key is now primary
    expect(await decryptSecret(rotatedKeyring, envelope, "user_1")).toBe("rotate-me");
    // new encryptions now use the new primary key
    const freshEnvelope = await encryptSecret(rotatedKeyring, "fresh-secret", "user_1");
    expect(freshEnvelope.split(".")[1]).toBe("new");
    expect(await decryptSecret(rotatedKeyring, freshEnvelope, "user_1")).toBe("fresh-secret");
  });

  it("fails to decrypt a tampered ciphertext", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "immutable-secret", "user_1");
    const [version, keyId, iv, ct = "", tag] = envelope.split(".");
    const tamperedCt = ct.slice(0, -2) + (ct.slice(-2) === "AA" ? "BB" : "AA");
    const tampered = [version, keyId, iv, tamperedCt, tag].join(".");
    await expect(decryptSecret(keyring, tampered, "user_1")).rejects.toThrow();
  });

  it("fails to decrypt a tampered auth tag", async () => {
    const keyring = [makeKey("1")];
    const envelope = await encryptSecret(keyring, "immutable-secret", "user_1");
    const [version, keyId, iv, ct, tag = ""] = envelope.split(".");
    const tamperedTag = tag.slice(0, -2) + (tag.slice(-2) === "AA" ? "BB" : "AA");
    const tampered = [version, keyId, iv, ct, tamperedTag].join(".");
    await expect(decryptSecret(keyring, tampered, "user_1")).rejects.toThrow();
  });

  it("rejects a malformed envelope (wrong version or wrong part count)", async () => {
    const keyring = [makeKey("1")];
    await expect(decryptSecret(keyring, "not-an-envelope", "user_1")).rejects.toThrow();
    await expect(decryptSecret(keyring, "v2.1.aa.bb.cc", "user_1")).rejects.toThrow();
  });

  // Migration-safety proof: the WebCrypto AES-GCM port must stay byte-for-byte envelope-compatible
  // with the previous node:crypto `createCipheriv("aes-256-gcm")` implementation. AES-256-GCM is the
  // same algorithm in both; the only representational difference is that node exposes the 16-byte
  // auth tag separately (`getAuthTag()`) while `crypto.subtle.encrypt` appends it to the ciphertext.
  // The port splits/re-joins the tag so the `v1.<keyId>.<iv>.<ct>.<tag>` envelope is identical. This
  // test builds an envelope with the *old* node path directly and decrypts it with the *new* port,
  // proving any pre-port ciphertext (dev DBs, future rollbacks) still decrypts — no version bump.
  it("decrypts an envelope produced by the legacy node:crypto createCipheriv path (format-compat)", async () => {
    const key = makeKey("legacy");
    const plaintext = "JBSWY3DPEHPK3PXP";
    const aadUserId = "user_legacy";
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key.key, iv);
    cipher.setAAD(Buffer.from(aadUserId));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const legacyEnvelope = [
      "v1",
      key.id,
      iv.toString("base64url"),
      ct.toString("base64url"),
      tag.toString("base64url"),
    ].join(".");

    expect(await decryptSecret([key], legacyEnvelope, aadUserId)).toBe(plaintext);
    // and the reverse: a port-produced envelope carries the same shape a legacy reader would expect
    const portEnvelope = await encryptSecret([key], plaintext, aadUserId);
    expect(portEnvelope.split(".")).toHaveLength(5);
    expect(portEnvelope.split(".")[0]).toBe("v1");
  });
});
