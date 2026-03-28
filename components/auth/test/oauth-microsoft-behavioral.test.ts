import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from "jose";
import * as oauth from "oauth4webapi";
import { authorizationServerFor, oauthProvider, microsoftExpectedIssuer } from "../src/oauth";

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
 * ⚠️ CONCERN pinned by test 3 (found while writing this behavioral proof, NOT introduced by this
 * task): oauth4webapi's Authorization Code flow does NOT verify the id_token's JWS signature by
 * default — `processAuthorizationCodeResponse`/`getValidatedIdTokenClaims` only decode + shape-check
 * the JWT (see `oauth.ts`'s long comment above `expectedIssuerKey` for the source-level citation);
 * cryptographic verification is a separate opt-in (`oauth.validateApplicationLevelSignature`) that
 * `exchangeAndExtractIdentity` never calls, for ANY oidc provider (google/microsoft/etc — this is not
 * microsoft- or expectedIssuer-specific). `expectedIssuer` only ever touches the `iss` string-equality
 * step of this same (signature-unverified) pipeline, so it neither causes nor worsens this; test 3
 * pins the current, honest behavior (a garbage-signature token is ACCEPTED) rather than asserting a
 * false rejection, so this is caught immediately if a future change alters the pipeline either way.
 * See the Task 3 report's Concerns section for the full writeup and suggested follow-up.
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

  it("PRE-EXISTING, pipeline-wide (not caused by expectedIssuer): a garbage-signature id_token is currently ACCEPTED by oauth4webapi's Authorization Code flow, with or without expectedIssuer — pinning honest behavior rather than a false rejection claim", async () => {
    const srv = await startMockJwksServer();
    servers.push(srv);
    const p = oauthProvider({ kind: "oidc", issuer: srv.url, clientId: "cid", clientSecret: "sec" }); // no expectedIssuer either — isolates this from A4
    const as = await authorizationServerFor(p);

    const idToken = await mintIdToken(srv.privateKey, srv.kid, { iss: srv.url, aud: "cid", sub: "user-1" });
    const parts = idToken.split(".");
    const garbageToken = `${parts[0]}.${parts[1]}.${"A".repeat(342)}`; // corrupt the signature segment only

    const result = await oauth.processAuthorizationCodeResponse(as, { client_id: "cid" }, tokenResponse(garbageToken));
    // If this ever starts throwing, oauth4webapi (or this codebase) has started verifying the id_token
    // signature — update this test (and the Task 3 report's Concerns note) to match the new reality.
    expect(oauth.getValidatedIdTokenClaims(result)?.sub).toBe("user-1");
  });
});
