/** Third-party JWT verification (spec Part 2). An ACTION verifies the token ONCE (jose live JWKS
 *  fetch + signature/iss/aud/exp/nbf), then delegates to a JIT-provision+mint mutation — a short-lived
 *  third-party token is exchanged once, not presented per request (deliberate divergence from Convex's
 *  per-request-JWT-is-identity model; documented). Per-request stateless JWT is a non-goal. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { JwtConfig } from "./config";

type Jwks = ReturnType<typeof createRemoteJWKSet>;
const jwksCache = new Map<string, Jwks>();

function jwksFor(issuer: string, jwksUrl: string): Jwks {
  const key = `${issuer}|${jwksUrl}`;
  let j = jwksCache.get(key);
  if (!j) { j = createRemoteJWKSet(new URL(jwksUrl)); jwksCache.set(key, j); }
  return j;
}

/** The verified external identity a third-party JWT yields. */
export interface VerifiedIdToken { issuer: string; sub: string; email?: string; emailVerified: boolean; name?: string }

/** Verify `idToken` against the FIRST configured issuer whose `iss` + `aud` + signature match. Throws
 *  (generic to the caller) on any failure. `jwksUrl` defaults to `${issuer}/.well-known/jwks.json`. */
export async function verifyIdToken(idToken: string, config: JwtConfig): Promise<VerifiedIdToken> {
  let lastErr: unknown;
  for (const cfg of config.issuers) {
    const jwksUrl = cfg.jwksUrl ?? new URL("/.well-known/jwks.json", cfg.issuer).toString();
    try {
      const { payload } = await jwtVerify(idToken, jwksFor(cfg.issuer, jwksUrl), { issuer: cfg.issuer, audience: cfg.audience });
      return {
        issuer: cfg.issuer,
        sub: String(payload.sub ?? ""),
        email: typeof payload.email === "string" ? payload.email : undefined,
        // STRICT-BOOLEAN CARRY-FORWARD: some IdPs emit `email_verified` as the STRING "false"/"true".
        // Coerce with `=== true` here (defense in depth; the T4 core re-asserts `=== true` too).
        emailVerified: (payload as JWTPayload & { email_verified?: unknown }).email_verified === true,
        name: typeof (payload as { name?: unknown }).name === "string" ? (payload as { name: string }).name : undefined,
      };
    } catch (e) { lastErr = e; }
  }
  throw new Error(String(lastErr ?? "invalid token"));
}
