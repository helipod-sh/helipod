// WHY WebCrypto (`crypto.subtle`) rather than node:crypto's `createCipheriv`/`createDecipheriv`:
// `createCipheriv` is NOT a function on Cloudflare Workers / Durable Objects (workerd), even under
// `nodejs_compat` — proven in the 2026-04-13 Cloudflare feature-completeness audit (gap 8b:
// "`createCipheriv is not a function`"), which broke TOTP-secret storage on a DO. `crypto.subtle`'s
// AES-GCM is available on BOTH Node 18+/Bun AND workerd, so this path is portable across every
// deployment target with no host fork and NO `node:crypto` dependency (the IV comes from the
// WebCrypto-native `crypto.getRandomValues`). AES-GCM here is the identical algorithm to node's
// "aes-256-gcm"; the ONLY representational difference is that `crypto.subtle.encrypt` returns the
// ciphertext with the 16-byte GCM auth tag APPENDED, whereas node's cipher exposes the tag
// separately via `getAuthTag()`. We split the trailing tag back out on encrypt (and re-append it on
// decrypt) so the on-disk envelope stays byte-for-byte identical to the previous node:crypto format
// — an envelope written by the old code decrypts unchanged here and vice versa (proven by the
// format-compat test), so no envelope version bump and no migration is needed.
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit, standard for GCM
const GCM_TAG_BYTES = 16; // 128-bit auth tag — WebCrypto AES-GCM default; matches node's getAuthTag()
const ENVELOPE_VERSION = "v1";

/** Import a raw 32-byte keyring key as a non-extractable WebCrypto AES-GCM key for one operation. */
async function importAesGcmKey(keyMaterial: Buffer, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new Uint8Array(keyMaterial), { name: "AES-GCM" }, false, [usage]);
}

/** A single decryption key in the deployment's MFA keyring. `key` is exactly 32 bytes. */
export interface MfaKey {
  id: string;
  key: Buffer;
}

/**
 * Decode a 32-byte key given as base64 or hex text. Throws if the decoded
 * material is not exactly 32 bytes (or if the input is neither valid base64
 * nor valid hex).
 */
export function decodeKeyMaterial(raw: string): Buffer {
  const candidates: Buffer[] = [];

  // hex: exactly 64 hex chars decodes to 32 bytes.
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === KEY_BYTES * 2) {
    candidates.push(Buffer.from(raw, "hex"));
  }

  // base64 (standard or url-safe): decode and check length. `Buffer.from(..., "base64")` never
  // throws on its own — it silently ignores anything outside the base64 alphabet — so the regex
  // above is the actual gate on "was this base64-shaped text" and the `exact` length check below
  // (against `KEY_BYTES`) is the actual gate on "did it decode to a usable 32-byte key". This
  // branch only pushes a non-empty decode result onto `candidates`; it does not re-encode or
  // compare against the original input.
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length > 0) candidates.push(decoded);
  }

  const exact = candidates.find((buf) => buf.length === KEY_BYTES);
  if (exact) return exact;

  throw new Error(`MFA encryption key must decode to exactly ${KEY_BYTES} bytes (base64 or hex)`);
}

/**
 * Encrypt `plaintext` (the raw TOTP secret) under the keyring's primary key
 * (`keyring[0]`), binding `aadUserId` as GCM additional authenticated data so
 * the resulting envelope cannot be transplanted onto another user's row.
 *
 * Envelope shape: `v1.<keyId>.<ivB64url>.<ctB64url>.<tagB64url>`.
 *
 * Async because `crypto.subtle` is Promise-based (unlike node's synchronous cipher); callers thread
 * the `await` through (see `mfa/functions.ts`).
 */
export async function encryptSecret(keyring: MfaKey[], plaintext: string, aadUserId: string): Promise<string> {
  const primary = keyring[0];
  if (!primary) throw new Error("encryptSecret: keyring is empty");

  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await importAesGcmKey(primary.key, "encrypt");
  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new Uint8Array(Buffer.from(aadUserId)) },
      key,
      new Uint8Array(Buffer.from(plaintext, "utf8")),
    ),
  );
  // `crypto.subtle.encrypt` returns ct||tag; split the trailing 16-byte tag back out so the envelope
  // matches node:crypto's separate-tag format exactly (see the file header for why).
  const ct = combined.subarray(0, combined.length - GCM_TAG_BYTES);
  const tag = combined.subarray(combined.length - GCM_TAG_BYTES);

  return [
    ENVELOPE_VERSION,
    primary.id,
    Buffer.from(iv).toString("base64url"),
    Buffer.from(ct).toString("base64url"),
    Buffer.from(tag).toString("base64url"),
  ].join(".");
}

/**
 * Decrypt an envelope produced by `encryptSecret`. Dispatches on the
 * envelope's stored `keyId` to select the matching `MfaKey` from `keyring`
 * (order-independent — supports key rotation, where an older key may no
 * longer be `keyring[0]`). Throws a generic error on any failure: malformed
 * envelope, unknown keyId, wrong `aadUserId`, or a tampered
 * ciphertext/auth-tag.
 *
 * Async because `crypto.subtle` is Promise-based (see `encryptSecret`).
 */
export async function decryptSecret(keyring: MfaKey[], envelope: string, aadUserId: string): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts.some((p) => !p)) throw new Error("invalid MFA secret envelope");
  const [version, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  if (version !== ENVELOPE_VERSION) throw new Error("invalid MFA secret envelope");

  const mfaKey = keyring.find((k) => k.id === keyId);
  if (!mfaKey) throw new Error("invalid MFA secret envelope");

  const iv = Buffer.from(ivB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");

  // `crypto.subtle.decrypt` expects ct||tag concatenated (the inverse of the split in `encryptSecret`)
  // and throws on any authentication failure — wrong key, wrong AAD, or a flipped ct/tag byte — which
  // is the same failure surface node's `decipher.final()` had, so every caller's try/catch is unchanged.
  const combined = Buffer.concat([ct, tag]);
  const key = await importAesGcmKey(mfaKey.key, "decrypt");
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: new Uint8Array(Buffer.from(aadUserId)) },
      key,
      combined,
    ),
  );
  return Buffer.from(plaintext).toString("utf8");
}
