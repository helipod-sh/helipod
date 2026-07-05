/**
 * The shared HMAC capability-token helper for `@helipod/storage`'s upload/download surface.
 * `./context.ts`'s `signUploadToken`/`privateGetUrl` (the create side, called inside a mutation via
 * `generateUploadUrl`/`getUrl`) and `./http.ts`'s upload/confirm/serve endpoints (the verify side,
 * called at the HTTP boundary, via `verifyStorageToken` directly) both build on this ONE module,
 * so the two sides can never drift.
 *
 * ── Scope tagging (security-load-bearing) ───────────────────────────────────────────────────────
 * The token HMACs a `scope` tag alongside `id`/`exp` (`${scope}:${id}.${exp}`), so an
 * `"upload"`-scoped token and a `"get"`-scoped token for the SAME `id`/`exp` are NOT
 * interchangeable — a `getUrl()` token embedded in a page (and thus prone to leaking into logs/
 * history/Referer) cannot be replayed against the upload endpoint to overwrite a file's bytes, and
 * an upload token cannot be used to read a private file early. Without this tag the two token
 * kinds were byte-for-byte identical given the same `(id, exp)`, which is exactly the
 * token-scope-confusion vulnerability this field closes.
 *
 * The token is otherwise self-contained: it embeds its own `exp` (`${exp}.${hmac}`), so
 * verification needs only `(signingKey, scope, id, token, now)` — no separate expiry field to keep
 * in sync out-of-band (the `exp` query param some callers also carry alongside the token is
 * informational only; the token itself is what's authoritative and tamper-evident, since `exp` is
 * part of what's HMAC'd).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SEP = ".";

/** What a capability token authorizes: minting/finalizing a blob's bytes, or reading them. */
export type TokenScope = "upload" | "get";

/**
 * Mint a capability token for `id`, scoped to `scope`, valid until `exp` (ms epoch).
 * Pure/deterministic given stable inputs — safe to compute inside a mutation and reproducible on
 * replay (see `context.ts`'s determinism note on `generateUploadUrl`).
 */
export function createStorageToken(signingKey: string, scope: TokenScope, id: string, exp: number): string {
  const sig = createHmac("sha256", signingKey).update(`${scope}:${id}.${exp}`).digest("hex");
  return `${exp}${SEP}${sig}`;
}

/**
 * Verify a token minted by `createStorageToken`: parse its embedded `exp`, reject if `now` is
 * past it, then recompute the HMAC — over the SAME `scope` the caller expects — and constant-time
 * compare. A token minted for a different scope (e.g. a `"get"` token presented where `"upload"`
 * is required) recomputes to a different HMAC and is rejected here. `now` here IS wall-clock —
 * verification happens at the HTTP/action boundary, never inside a mutation.
 */
export function verifyStorageToken(
  signingKey: string,
  scope: TokenScope,
  id: string,
  token: string,
  now: number,
): boolean {
  const sepIndex = token.indexOf(SEP);
  if (sepIndex < 0) return false;
  const exp = Number(token.slice(0, sepIndex));
  if (!Number.isFinite(exp) || now > exp) return false;

  const expected = createStorageToken(signingKey, scope, id, exp);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
