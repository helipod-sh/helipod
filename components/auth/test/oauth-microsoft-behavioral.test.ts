import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import * as oauth from "oauth4webapi";
import { authorizationServerFor, oauthProvider, microsoftExpectedIssuer, exchangeAndExtractIdentity } from "../src/oauth";

/**
 * A4 BEHAVIORAL proof (beyond `oauth-seam.test.ts`'s white-box wiring check): drives the REAL
 * oauth4webapi `processAuthorizationCodeResponse` against a genuinely RS256-signed id_token over a
 * live JWKS HTTP endpoint (no mocking of oauth4webapi itself):
 *
 *  1. a tenant-shaped `iss` that does NOT equal the discovery `issuer` VALIDATES when
 *     `expectedIssuer` (here, `microsoftExpectedIssuer`) accepts it.
 *  2. with NO `expectedIssuer` configured, the identical tenant-shaped `iss` mismatch is
 *     STRICT-rejected — the A3 default is unaffected by the seam existing.
 *
 * ⚠️ UPDATE (Task 3.5): tests 1-2 above were and remain accurate — `expectedIssuer` only ever touches
 * the `iss` string-equality step, never the signature. What FOLLOWS in this file used to pin a real gap
 * (test 3 previously asserted a garbage-signature id_token was ACCEPTED, pipeline-wide, by
 * `processAuthorizationCodeResponse`/`getValidatedIdTokenClaims` alone). Task 3.5 closed that gap by
 * having `exchangeAndExtractIdentity` (`../src/oauth.ts`) explicitly call the separate
 * `oauth.validateApplicationLevelSignature` step against the AS's `jwks_uri`, for every OIDC provider,
 * right after `processAuthorizationCodeResponse` and before the claims are trusted. The tests below now
 * prove: (3) a garbage-signature token is REJECTED once that extra call is made (the decode-only step
 * alone still doesn't reject it — that's WHY the extra call is necessary); (4) a forged-signature token
 * from an entirely different keypair is REJECTED too (not just corrupted bytes); (5) the
 * Microsoft-shaped carry-forward — a forged-signature token whose `iss` shape-matches
 * `microsoftExpectedIssuer`'s tenant pattern but is the WRONG tenant is REJECTED, proving signature
 * verification (not the regex alone) is what makes the multi-tenant relaxation safe; (6) a
 * VALID-signature token is still ACCEPTED (no over-correction); (7) a missing `jwks_uri` makes
 * `exchangeAndExtractIdentity` throw loud rather than silently skip verification.
 */

interface MockJwksServer {
  url: string;
  kid: string;
  privateKey: CryptoKey;
  close(): Promise<void>;
}

async function startMockJwksServer(): Promise<MockJwksServer> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "behavioral-key-1";
  const publicJwk = await exportJWK(publicKey);
  let url = "";
  const server: Server = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ issuer: url, authorization_endpoint: `${url}/authorize`, token_endpoint: `${url}/token`, jwks_uri: `${url}/jwks` }));
      return;
    }
    if (req.url === "/jwks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/token") {
      // Only exercised by the "missing jwks_uri" test below, which drives a real fetch through
      // `exchangeAndExtractIdentity` (unlike the other tests here, which call oauth4webapi directly
      // against a hand-built `Response`). Fixed, valid claims — that test only cares about the
      // jwks_uri guard, not claim content.
      void (async () => {
        const idToken = await new SignJWT({})
          .setProtectedHeader({ alg: "RS256", kid })
          .setIssuer(url)
          .setAudience("cid")
          .setSubject("missing-jwks-test-sub")
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: "at-1", token_type: "bearer", id_token: idToken }));
      })();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  return { url, kid, privateKey, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function mintIdToken(privateKey: CryptoKey, kid: string, claims: { iss: string; aud: string; sub: string }): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function tokenResponse(idToken: string): Response {
  return new Response(JSON.stringify({ access_token: "at-1", token_type: "bearer", id_token: idToken }), {
    headers: { "content-type": "application/json" },
  });
}

const TENANT_ISS = "https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0";

let servers: MockJwksServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe("A4 behavioral: expectedIssuer relaxes ONLY the iss string check", () => {
  it("a tenant-shaped iss (≠ discovery issuer) VALIDATES when expectedIssuer accepts it", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec", expectedIssuer: microsoftExpectedIssuer });
    const as = await authorizationServerFor(p);
    expect(as.issuer).toBe(srv.url); // discovery's own issuer — deliberately NOT the tenant iss below

    const idToken = await mintIdToken(srv.privateKey, srv.kid, { iss: TENANT_ISS, aud: "cid", sub: "user-1" });
    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, tokenResponse(idToken));
    const claims = oauth.getValidatedIdTokenClaims(result);
    expect(claims?.iss).toBe(TENANT_ISS);
    expect(claims?.iss).not.toBe(as.issuer); // proves the mismatch was real, and relaxation is why it passed
  });

  it("with NO expectedIssuer configured, the identical tenant-shaped iss mismatch is STRICT-rejected (A3 default, unaffected by the seam)", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" }); // no expectedIssuer
    const as = await authorizationServerFor(p);

    const idToken = await mintIdToken(srv.privateKey, srv.kid, { iss: TENANT_ISS, aud: "cid", sub: "user-1" });
    await expect(oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, tokenResponse(idToken))).rejects.toThrow();
  });

  it("Task 3.5 FLIP (was pinned as ACCEPTED, now REJECTED): a garbage-signature id_token — decode-only claims extraction still succeeds (that's WHY the extra call is necessary), but the added validateApplicationLevelSignature call (exactly what exchangeAndExtractIdentity now runs) rejects it", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" }); // no expectedIssuer either — isolates this from A4
    const as = await authorizationServerFor(p);

    const idToken = await mintIdToken(srv.privateKey, srv.kid, { iss: srv.url, aud: "cid", sub: "user-1" });
    const parts = idToken.split(".");
    const garbageToken = `${parts[0]}.${parts[1]}.${"A".repeat(342)}`; // corrupt the signature segment only
    const resp = tokenResponse(garbageToken); // the SAME Response object is reused below — validateApplicationLevelSignature keys off a WeakMap set on it by processAuthorizationCodeResponse

    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, resp);
    expect(oauth.getValidatedIdTokenClaims(result)?.sub).toBe("user-1"); // decode-only: still no rejection here

    await expect(
      oauth.validateApplicationLevelSignature(as, resp, { [oauth.allowInsecureRequests]: true }),
    ).rejects.toThrow();
  });

  it("generic OIDC forged-signature (signed by an entirely different keypair, never in the AS's JWKS): REJECTED", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" });
    const as = await authorizationServerFor(p);

    const { privateKey: foreignKey } = await generateKeyPair("RS256");
    const forged = await mintIdToken(foreignKey, srv.kid, { iss: srv.url, aud: "cid", sub: "attacker" });
    const resp = tokenResponse(forged);

    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, resp);
    expect(oauth.getValidatedIdTokenClaims(result)?.sub).toBe("attacker"); // claims are well-formed; only the signature is wrong

    await expect(
      oauth.validateApplicationLevelSignature(as, resp, { [oauth.allowInsecureRequests]: true }),
    ).rejects.toThrow();
  });

  it("THE MICROSOFT-SHAPED CARRY-FORWARD: a forged-signature token whose iss MATCHES microsoftExpectedIssuer's tenant-shape regex but is the WRONG tenant is REJECTED — proves signature verification, not regex-scoping alone, anchors the class of tokens expectedIssuer widens acceptance of", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec", expectedIssuer: microsoftExpectedIssuer });
    const as = await authorizationServerFor(p);

    const { privateKey: foreignKey } = await generateKeyPair("RS256");
    // A tenant NOBODY configured, shape-matching microsoftExpectedIssuer's regex, signed by a key not
    // in `as`'s JWKS at all (simulating an attacker who controls neither Microsoft nor this AS).
    const wrongTenantIss = "https://login.microsoftonline.com/ffffffff-0000-1111-2222-333333333333/v2.0";
    const forged = await mintIdToken(foreignKey, srv.kid, { iss: wrongTenantIss, aud: "cid", sub: "attacker" });
    const resp = tokenResponse(forged);

    // expectedIssuer accepts the iss STRING (it shape-matches the tenant pattern) — decode+iss-check succeeds.
    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, resp);
    expect(oauth.getValidatedIdTokenClaims(result)?.iss).toBe(wrongTenantIss);

    // But signature verification (what exchangeAndExtractIdentity now always runs) rejects it —
    // regex-scoping alone was necessary-but-not-sufficient; signature is what makes it sufficient.
    await expect(
      oauth.validateApplicationLevelSignature(as, resp, { [oauth.allowInsecureRequests]: true }),
    ).rejects.toThrow();
  });

  it("NO over-correction: a VALID-signature id_token (signed by the AS's own real key, present in its JWKS) is still ACCEPTED", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" });
    const as = await authorizationServerFor(p);

    const idToken = await mintIdToken(srv.privateKey, srv.kid, { iss: srv.url, aud: "cid", sub: "user-1" });
    const resp = tokenResponse(idToken);

    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, resp);
    await expect(
      oauth.validateApplicationLevelSignature(as, resp, { [oauth.allowInsecureRequests]: true }),
    ).resolves.toBeUndefined();
    expect(oauth.getValidatedIdTokenClaims(result)?.sub).toBe("user-1");
  });

  it("missing jwks_uri: exchangeAndExtractIdentity throws (fail loud, never silently skips verification)", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    // A manually built AuthorizationServer with NO jwks_uri — as if discovery had omitted it (bypasses
    // authorizationServerFor's own discovery, which always sets jwks_uri from the mock's real doc).
    const as: oauth.AuthorizationServer = {
      issuer: srv.url,
      authorization_endpoint: `${srv.url}/authorize`,
      token_endpoint: `${srv.url}/token`,
    };
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" });
    const client: oauth.Client = { client_id: "cid" };
    const cbUrl = new URL("http://cb.example/callback?code=abc123&state=s1");
    const params = oauth.validateAuthResponse(as, client, cbUrl.searchParams, "s1");

    await expect(
      exchangeAndExtractIdentity({ as, provider: p, params, redirectUri: "http://cb.example/callback", codeVerifier: "verifier" }),
    ).rejects.toThrow(/jwks_uri/);
  });
});
