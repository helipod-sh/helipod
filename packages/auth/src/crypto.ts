import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** Hash a password with a per-call random salt → "salt:hash" (hex). */
export function hashSecret(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/** Constant-time verify; false for a malformed stored value. */
export function verifySecret(password: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = stored.slice(0, sep);
  const hash = stored.slice(sep + 1);
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A url-safe session token (256 bits). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
