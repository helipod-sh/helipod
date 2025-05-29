import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ARGON = { parallelism: 1, iterations: 3, memorySize: 19456, hashLength: 32, outputType: "encoded" as const };

/** Hash a password with argon2id → an encoded PHC string (embeds salt + params). */
export async function hashSecret(password: string): Promise<string> {
  return argon2id({ password, salt: randomBytes(16), ...ARGON });
}

/** Verify against an argon2id PHC string, or a legacy scrypt "salt:hash" (for migration). */
export async function verifySecret(password: string, stored: string): Promise<boolean> {
  if (stored.startsWith("$argon2")) {
    try { return await argon2Verify({ password, hash: stored }); } catch { return false; }
  }
  return verifyScryptLegacy(password, stored);
}

/** True when `stored` is a legacy scrypt hash that should be upgraded to argon2id on next login. */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2");
}

function verifyScryptLegacy(password: string, stored: string): boolean {
  const sep = stored.indexOf(":");
  if (sep < 0) return false;
  const salt = stored.slice(0, sep), hash = stored.slice(sep + 1);
  if (!salt || !hash) return false;
  const a = Buffer.from(hash, "hex");
  const b = scryptSync(password, salt, 64);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A url-safe session token (256 bits). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}
