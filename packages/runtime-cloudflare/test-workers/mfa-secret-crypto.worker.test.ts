/**
 * Proves, on REAL workerd, that the auth MFA secret-encryption mechanism runs on Cloudflare
 * Workers / Durable Objects. The 2026-07-17 CF audit (gap 8b) showed node:crypto's
 * `createCipheriv("aes-256-gcm")` is `not a function` under `nodejs_compat`, breaking TOTP-secret
 * storage on a DO; `components/auth/src/mfa/secret-crypto.ts` was ported to WebCrypto
 * (`crypto.subtle` AES-GCM) as the fix. `@helipod/auth` is not a dependency of this package (its
 * hash-wasm transitive dep won't resolve under the vitest esbuild bundler — the same harness
 * artifact the audit noted for argon2id), so this replicates the port's EXACT crypto operations
 * inline — import-raw AES-GCM key, `getRandomValues` IV, `subtle.encrypt` with `additionalData`
 * (AAD), split the trailing 16-byte GCM tag off, re-join it, `subtle.decrypt` — and asserts the
 * round-trip + AAD binding + tamper rejection all hold under workerd.
 */
import { describe, it, expect } from "vitest";

const TAG_BYTES = 16; // 128-bit GCM tag — WebCrypto default; the port splits this many trailing bytes

async function importKey(raw: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [usage]);
}

async function encrypt(keyBytes: Uint8Array, plaintext: string, aad: string): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importKey(keyBytes, "encrypt");
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
      key,
      new TextEncoder().encode(plaintext),
    ),
  );
  // Mirror the port: split trailing tag, then re-join iv||ct||tag so the caller can round-trip it.
  const ct = combined.subarray(0, combined.length - TAG_BYTES);
  const tag = combined.subarray(combined.length - TAG_BYTES);
  const packed = new Uint8Array(iv.length + ct.length + tag.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  packed.set(tag, iv.length + ct.length);
  return packed;
}

async function decrypt(keyBytes: Uint8Array, packed: Uint8Array, aad: string): Promise<string> {
  const iv = packed.subarray(0, 12);
  const ctAndTag = packed.subarray(12); // subtle.decrypt wants ct||tag concatenated
  const key = await importKey(keyBytes, "decrypt");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    key,
    ctAndTag,
  );
  return new TextDecoder().decode(plaintext);
}

describe("MFA secret crypto (WebCrypto AES-GCM) on real workerd", () => {
  it("createCipheriv is STILL unavailable — the reason the port exists (regression anchor)", async () => {
    const { createCipheriv } = await import("node:crypto");
    expect(typeof createCipheriv).not.toBe("function");
  });

  it("crypto.subtle AES-GCM round-trips a TOTP secret", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const packed = await encrypt(key, "JBSWY3DPEHPK3PXP", "user_123");
    expect(await decrypt(key, packed, "user_123")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("AAD (userId) binding: the wrong userId fails to decrypt", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const packed = await encrypt(key, "top-secret", "user_owner");
    await expect(decrypt(key, packed, "user_attacker")).rejects.toThrow();
  });

  it("a tampered ciphertext byte fails authentication", async () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const packed = await encrypt(key, "immutable", "user_1");
    packed[20] ^= 0xff; // flip a ciphertext byte
    await expect(decrypt(key, packed, "user_1")).rejects.toThrow();
  });
});
