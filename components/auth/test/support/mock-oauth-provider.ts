import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

/**
 * A local mock OIDC provider (no live network) for driving the real A3 OAuth flow through
 * `oauthHttp`'s `/start` + `/callback` phases. Serves discovery + JWKS + a token endpoint whose
 * `id_token` is jose-signed with a freshly generated RS256 keypair. Loopback (`127.0.0.1`), so
 * `isLoopbackUrl`'s insecure-http gate lets the server's own `oauth4webapi` calls through with no
 * app-settable flag (see `oauth.ts`'s `assertProviderEndpointsSecure`/`allowInsecureForUrl`).
 *
 * The **nonce-echo trick** (plan Resolved Ambiguity 3) is what makes this work without a real
 * browser/authorize step: the test drives `/start`, reads the `nonce` off the 302 `Location`, calls
 * `setNextIdTokenClaims({ nonce, ... })` so the mock's NEXT `/token` response mints an `id_token`
 * carrying that exact nonce, then drives `/callback?code=...&state=...` — the engine's
 * `oauth4webapi` POSTs to this mock's `/token` over loopback http, verifies the id_token's signature
 * against `/jwks`, and validates the nonce.
 *
 * Shared by `oauth-callback.test.ts` (this task) and the Task-7 real-server E2E (per the plan's
 * "factor it into a shared test/support/mock-oauth-provider.ts helper both tests import").
 */
export interface MockOidcProvider {
  url: string;
  /** Controls the claims embedded in the id_token the NEXT `/token` response mints. Must be called
   *  before each `/callback` drive (a fresh `sub`/`nonce`/etc per test case). */
  setNextIdTokenClaims(claims: { sub: string; aud: string; email?: string; email_verified?: boolean; nonce?: string; issuerOverride?: string }): void;
  close(): Promise<void>;
}

export async function startMockOidcProvider(): Promise<MockOidcProvider> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "mock-key-1";
  const publicJwk = await exportJWK(publicKey);

  let url = "";
  let pending: { sub: string; aud: string; email?: string; email_verified?: boolean; nonce?: string; issuerOverride?: string } | null = null;

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
    if (req.method === "GET" && req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      void (async () => {
        if (!pending) { res.writeHead(500); res.end(); return; }
        const claims = pending;
        const idToken = await new SignJWT({ email: claims.email, email_verified: claims.email_verified, nonce: claims.nonce })
          .setProtectedHeader({ alg: "RS256", kid })
          .setSubject(claims.sub)
          .setIssuedAt()
          .setIssuer(claims.issuerOverride ?? url)
          .setAudience(claims.aud)
          .setExpirationTime("5m")
          .sign(privateKey);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "mock-access-token", token_type: "bearer", id_token: idToken }));
      })();
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
    setNextIdTokenClaims(claims) { pending = claims; },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

/**
 * A local mock GitHub-shaped (non-OIDC oauth2) provider: `/token` (no id_token — just an
 * access_token), `/user`, `/user/emails`. Exercises `exchangeAndExtractIdentity`'s non-OIDC branch.
 */
export interface MockGithubProvider {
  url: string;
  setNextUser(user: { id: number; login?: string; name?: string }): void;
  setNextEmails(emails: Array<{ email: string; primary: boolean; verified: boolean }>): void;
  close(): Promise<void>;
}

export async function startMockGithubProvider(): Promise<MockGithubProvider> {
  let url = "";
  let user: { id: number; login?: string; name?: string } = { id: 0 };
  let emails: Array<{ email: string; primary: boolean; verified: boolean }> = [];

  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-gh-access-token", token_type: "bearer" }));
      return;
    }
    if (req.method === "GET" && req.url === "/user") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(user));
      return;
    }
    if (req.method === "GET" && req.url === "/user/emails") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(emails));
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
    setNextUser(u) { user = u; },
    setNextEmails(e) { emails = e; },
    async close() { await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
