// packages/admin/src/auth.ts
import { randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh url-safe admin key (192 bits of entropy). */
export function generateAdminKey(): string {
  return randomBytes(24).toString("base64url");
}

/** Constant-time comparison; false for a missing or wrong-length key. */
export function verifyAdminKey(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
