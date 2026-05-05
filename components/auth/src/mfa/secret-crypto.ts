import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12; // 96-bit, standard for GCM
const ENVELOPE_VERSION = "v1";

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
 */
export function encryptSecret(keyring: MfaKey[], plaintext: string, aadUserId: string): string {
  const primary = keyring[0];
  if (!primary) throw new Error("encryptSecret: keyring is empty");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, primary.key, iv);
  cipher.setAAD(Buffer.from(aadUserId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    primary.id,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt an envelope produced by `encryptSecret`. Dispatches on the
 * envelope's stored `keyId` to select the matching `MfaKey` from `keyring`
 * (order-independent — supports key rotation, where an older key may no
 * longer be `keyring[0]`). Throws a generic error on any failure: malformed
 * envelope, unknown keyId, wrong `aadUserId`, or a tampered
 * ciphertext/auth-tag.
 */
export function decryptSecret(keyring: MfaKey[], envelope: string, aadUserId: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 5 || parts.some((p) => !p)) throw new Error("invalid MFA secret envelope");
  const [version, keyId, ivB64, ctB64, tagB64] = parts as [string, string, string, string, string];
  if (version !== ENVELOPE_VERSION) throw new Error("invalid MFA secret envelope");

  const mfaKey = keyring.find((k) => k.id === keyId);
  if (!mfaKey) throw new Error("invalid MFA secret envelope");

  const iv = Buffer.from(ivB64, "base64url");
  const ct = Buffer.from(ctB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");

  const decipher = createDecipheriv(ALGO, mfaKey.key, iv);
  decipher.setAAD(Buffer.from(aadUserId));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString("utf8");
}
