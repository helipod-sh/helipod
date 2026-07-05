import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

/**
 * A local mock OAuth/OIDC provider (no live third-party network) for `auth-external-e2e.test.ts` —
 * the Task-7 E2E through the REAL `helipod dev` server. Loopback (`127.0.0.1`), so
 * `isLoopbackUrl`'s insecure-http gate lets the server's own `oauth4webapi`/`jose` calls through
 * with no app-settable flag (see `components/auth/src/oauth.ts`'s `assertProviderEndpointsSecure`/
 * `allowInsecureForUrl`).
 *
 * Serves `/.well-known/openid-configuration`, `/jwks`, `POST /token`, `/user`, `/user/emails` off
 * one RS256 keypair. Two independent capabilities:
 *
 *  - `setNextToken({ nonce, sub, email, emailVerified, aud? })` primes the NEXT `POST /token`
 *    response — this is what makes the real `/start` -> `/callback` round trip work without a real
 *    browser/authorize step (the **nonce-echo trick**, plan Resolved Ambiguity 3): the test drives
 *    `/api/auth/oauth/mock/start`, reads the `nonce` off the 302 `Location`, calls
 *    `setNextToken({ nonce, ... })` so this mock's next `/token` response mints an `id_token`
 *    carrying that exact nonce, then drives `/api/auth/oauth/mock/callback?code=...&state=...` —
 *    the engine's `oauth4webapi` POSTs to THIS mock's `/token` over loopback http, verifies the
 *    id_token's signature against `/jwks`, and validates the nonce. `aud` defaults to
 *    `DEFAULT_CLIENT_ID` ("test-client") — the E2E's `oauthProvider({ clientId: ... })` must use
 *    the same value (it does, by convention, unless a test overrides `aud` explicitly).
 *
 *  - `signIdToken(claims)` mints a JWT directly (no `/token` round trip at all) — for the
 *    `signInWithIdToken` third-party-JWT half, which needs no OAuth provider server interaction:
 *    the test signs a token with THIS keypair (whose public JWK `/jwks` serves) and hands it
 *    straight to `client.action(api.auth.signInWithIdToken, { idToken })`. `aud` defaults to
 *    `"helipod"` (the repo's `jwt.issuers[].audience` convention, matching `jwt-signin.test.ts`).
 */
export interface MockProvider {
  url: string;
  jwksUrl: string;
  /** Mint a JWT directly with this mock's keypair (no `/token` round trip) — for `signInWithIdToken`. */
  signIdToken(claims: {
    sub: string;
    email?: string;
    emailVerified?: boolean;
    aud?: string;
    iss?: string;
    exp?: string;
  }): Promise<string>;
  /** Prime the NEXT `POST /token` response's `id_token` claims — for the `/start`->`/callback` round trip. */
  setNextToken(claims: { nonce?: string; sub: string; email?: string; emailVerified?: boolean; aud?: string }): void;
  /** Prime the `/user` response (GitHub-shaped oauth2 variant). */
  setNextUser(user: { id: number; login?: string; name?: string }): void;
  /** Prime the `/user/emails` response (GitHub-shaped oauth2 variant). */
  setNextEmails(emails: Array<{ email: string; primary: boolean; verified: boolean }>): void;
  close(): Promise<void>;
}

/** The default OAuth `client_id`/id_token `aud` this mock and the E2E's `oauthProvider(...)` config
 *  agree on when a test doesn't override it — kept as a named export so the test file's `oauthProvider`
 *  config and this mock's default never drift apart from a single source. */
export const DEFAULT_CLIENT_ID = "test-client";
const DEFAULT_JWT_AUDIENCE = "helipod";

export async function startMockProvider(): Promise<MockProvider> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "mock-key-1";
  const publicJwk = await exportJWK(publicKey);

  let url = "";
  let pendingToken: { nonce?: string; sub: string; email?: string; emailVerified?: boolean; aud?: string } | null = null;
  let nextUser: { id: number; login?: string; name?: string } = { id: 0 };
  let nextEmails: Array<{ email: string; primary: boolean; verified: boolean }> = [];

  async function mint(claims: { sub: string; email?: string; emailVerified?: boolean; aud: string; iss: string; nonce?: string; exp?: string }): Promise<string> {
    return new SignJWT({
      ...(claims.email !== undefined ? { email: claims.email } : {}),
      ...(claims.emailVerified !== undefined ? { email_verified: claims.emailVerified } : {}),
      ...(claims.nonce !== undefined ? { nonce: claims.nonce } : {}),
    })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(claims.sub)
      .setIssuedAt()
      .setIssuer(claims.iss)
      .setAudience(claims.aud)
      .setExpirationTime(claims.exp ?? "5m")
      .sign(privateKey);
  }

  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        jwks_uri: `${url}/jwks`,
      }));
      return;
    }
    if (req.method === "GET" && (req.url === "/jwks" || req.url === "/.well-known/jwks.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      void (async () => {
        if (!pendingToken) {
          res.writeHead(500);
          res.end();
          return;
        }
        const claims = pendingToken;
        const idToken = await mint({
          sub: claims.sub,
          email: claims.email,
          emailVerified: claims.emailVerified,
          nonce: claims.nonce,
          aud: claims.aud ?? DEFAULT_CLIENT_ID,
          iss: url,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "gh-access", token_type: "bearer", id_token: idToken }));
      })();
      return;
    }
    if (req.method === "GET" && req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(nextUser));
      return;
    }
    if (req.method === "GET" && req.url === "/user/emails") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(nextEmails));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  return {
    url,
    jwksUrl: `${url}/jwks`,
    async signIdToken(claims) {
      return mint({
        sub: claims.sub,
        email: claims.email,
        emailVerified: claims.emailVerified,
        aud: claims.aud ?? DEFAULT_JWT_AUDIENCE,
        iss: claims.iss ?? url,
        exp: claims.exp,
      });
    },
    setNextToken(claims) { pendingToken = claims; },
    setNextUser(u) { nextUser = u; },
    setNextEmails(e) { nextEmails = e; },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
