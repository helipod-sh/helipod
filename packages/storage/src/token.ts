/**
 * The shared HMAC capability-token helper for `@stackbase/storage`'s upload/download surface.
 * `./context.ts`'s `signUploadToken` (the create side, called inside a mutation via
 * `generateUploadUrl`) and `./http.ts`'s upload/confirm endpoints' `authorize` (the verify side,
 * called at the HTTP boundary, via `verifyStorageToken` directly) both build on this ONE module,
 * so the two sides can never drift.
 *
 * The token is self-contained: it embeds its own `exp` (`${exp}.${hmac}`), so verification needs
 * only `(signingKey, id, token, now)` — no separate expiry field to keep in sync out-of-band (the
 * `exp` query param some callers also carry alongside the token is informational only; the token
 * itself is what's authoritative and tamper-evident, since `exp` is part of what's HMAC'd).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SEP = ".";

/**
 * Mint a capability token for `id`, valid until `exp` (ms epoch). Pure/deterministic given stable
 * inputs — safe to compute inside a mutation and reproducible on replay (see `context.ts`'s
 * determinism note on `generateUploadUrl`).
 */
export function createStorageToken(signingKey: string, id: string, exp: number): string {
  const sig = createHmac("sha256", signingKey).update(`${id}.${exp}`).digest("hex");
  return `${exp}${SEP}${sig}`;
}

/**
 * Verify a token minted by `createStorageToken`: parse its embedded `exp`, reject if `now` is
 * past it, then recompute the HMAC and constant-time compare. `now` here IS wall-clock —
 * verification happens at the HTTP/action boundary, never inside a mutation.
 */
export function verifyStorageToken(signingKey: string, id: string, token: string, now: number): boolean {
  const sepIndex = token.indexOf(SEP);
  if (sepIndex < 0) return false;
  const exp = Number(token.slice(0, sepIndex));
  if (!Number.isFinite(exp) || now > exp) return false;

  const expected = createStorageToken(signingKey, id, exp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
