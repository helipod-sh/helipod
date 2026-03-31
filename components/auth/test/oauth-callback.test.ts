import { describe, it, expect, afterEach } from "vitest";
import { defineSchema } from "@stackbase/values";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { query, type QueryCtx } from "@stackbase/executor";
import { generateKeyPair, SignJWT } from "jose";
import { defineAuth } from "../src/component";
import { oauthProvider } from "../src/oauth";
import type { MintResult } from "../src/functions";
import { startMockOidcProvider, startMockGithubProvider, type MockOidcProvider, type MockGithubProvider } from "./support/mock-oauth-provider";

/**
 * The `/callback` phase of `oauthHttp` (Task 5): consume state, exchange the code, extract the
 * identity, resolve/link/provision via `_resolveExternalIdentity` (Task 4, `outcome:"handoff"`),
 * write an `oauthHandoff` row, and 302 to `redirectTo#code=<handoff>`. `completeOAuthSignIn` then
 * consumes the handoff and mints (`_consumeHandoff`).
 *
 * This is the Task-7 real-server E2E in miniature at the component layer (drives `oauthHttp`
 * directly via `runtime.runHttpAction`, since component-contributed routes are not yet dispatched
 * by any URL router at this layer — same pattern as `oauth-start.test.ts`).
 */

let mock: MockOidcProvider;
let ghMock: MockGithubProvider;
afterEach(async () => {
  if (mock) await mock.close();
  if (ghMock) await ghMock.close();
});

async function makeRuntime(comp: ReturnType<typeof defineAuth>) {
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    tableNumbers,
  });
}

/** Drive `/start`, returning the parsed authorize-URL params (`state`, `nonce`) the callback needs. */
async function driveStart(rt: Awaited<ReturnType<typeof makeRuntime>>, redirectTo: string, provider = "mock"): Promise<{ state: string; nonce: string | null }> {
  const req = new Request(`http://127.0.0.1:1/api/auth/oauth/${provider}/start?redirectTo=` + encodeURIComponent(redirectTo));
  const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  return { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce") };
}

function driveCallback(rt: Awaited<ReturnType<typeof makeRuntime>>, provider: string, state: string, code = "mockcode"): Promise<Response> {
  const req = new Request(`http://127.0.0.1:1/api/auth/oauth/${provider}/callback?code=${code}&state=${encodeURIComponent(state)}`);
  return rt.runHttpAction("auth:oauthHttp", req, { identity: null });
}

async function completeOAuthSignIn(rt: Awaited<ReturnType<typeof makeRuntime>>, handoffCode: string): Promise<MintResult> {
  const result = await rt.runAction<MintResult>("auth:completeOAuthSignIn", { handoffCode }, { identity: null });
  return result.value;
}

describe("A3 Task 5: /callback + token exchange + oauthHandoff + completeOAuthSignIn", () => {
  it("full OIDC round-trip: /start -> /callback -> 302 redirectTo#code=<handoff> -> completeOAuthSignIn -> MintResult", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    expect(nonce).toBeTruthy();
    mock.setNextIdTokenClaims({ sub: "sub-1", aud: "cid", email: "user@example.com", email_verified: true, nonce: nonce! });

    const res = await driveCallback(rt, "mock", state);
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("http://localhost:5173/app");
    expect(target.search).toBe(""); // handoff MUST be in the fragment, never the query
    const hash = target.hash; // "#code=<handoff>"
    expect(hash).toMatch(/^#code=/);
    const handoffCode = hash.slice("#code=".length);
    expect(handoffCode.length).toBeGreaterThan(0);

    const mint = await completeOAuthSignIn(rt, handoffCode);
    expect(mint.token).toBeTruthy();
    expect(mint.refreshToken).toBeTruthy();
    expect(mint.userId).toBeTruthy();

    // The mint is REAL — getUserId resolves the returned access token to the same user.
    const uid = await rt.run<string | null>("auth:getUserId", { token: mint.token }, { identity: null });
    expect(uid.value).toBe(mint.userId);
  });

  it("completeOAuthSignIn is single-use: a second call with the same handoff code throws generic (consume-before-validate)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    mock.setNextIdTokenClaims({ sub: "sub-2", aud: "cid", email: "u2@example.com", email_verified: true, nonce: nonce! });
    const res = await driveCallback(rt, "mock", state);
    const handoffCode = new URL(res.headers.get("location")!).hash.slice("#code=".length);

    await completeOAuthSignIn(rt, handoffCode); // first use succeeds
    await expect(rt.runAction("auth:completeOAuthSignIn", { handoffCode }, { identity: null })).rejects.toThrow(/authentication failed/);
  });

  it("a tampered state (no matching row) ⇒ 400, generic, no enumeration", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    await driveStart(rt, "http://localhost:5173/app"); // writes a real (unrelated) state row
    const res = await driveCallback(rt, "mock", "totally-made-up-state-value");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toBe("authentication failed");
  });

  it("a replayed callback (same state twice) ⇒ 400 on the second attempt (single-use state, consumed on the first)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    mock.setNextIdTokenClaims({ sub: "sub-3", aud: "cid", email: "u3@example.com", email_verified: true, nonce: nonce! });
    const first = await driveCallback(rt, "mock", state);
    expect(first.status).toBe(302);

    const replay = await driveCallback(rt, "mock", state);
    expect(replay.status).toBe(400);
  });

  it("an unknown provider at /callback ⇒ 404 (resolveProvider guard, not a raw providers[] index)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);
    const req = new Request("http://127.0.0.1:1/api/auth/oauth/__proto__/callback?code=x&state=y");
    const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
    expect(res.status).toBe(404);
  });

  it("Task 3.5: an id_token signed with a key NOT in the mock's JWKS ⇒ /callback 400, generic, no enumeration (JWS signature verification composes with the existing generic-failure try/catch)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    // Mint a claims-valid id_token (right iss/aud/nonce/sub) but signed with a FOREIGN keypair the
    // mock's own /jwks never serves — the shape a network-position/malicious-AS attacker would forge.
    const { privateKey: foreignKey } = await generateKeyPair("RS256");
    const forged = await new SignJWT({ nonce })
      .setProtectedHeader({ alg: "RS256", kid: "attacker-key" })
      .setSubject("attacker-controlled-sub")
      .setIssuedAt()
      .setIssuer(mock.url)
      .setAudience("cid")
      .setExpirationTime("5m")
      .sign(foreignKey);
    mock.setNextRawIdToken(forged);

    const res = await driveCallback(rt, "mock", state);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("authentication failed");
  });

  it("GitHub (non-OIDC oauth2) round-trip: /user + /user/emails mapped, verified primary email autolinks correctly", async () => {
    ghMock = await startMockGithubProvider();
    const comp = defineAuth({
      oauth: {
        providers: {
          gh: oauthProvider({
            kind: "oauth2",
            authorizationEndpoint: `${ghMock.url}/authorize`,
            tokenEndpoint: `${ghMock.url}/token`,
            userinfoEndpoint: `${ghMock.url}/user`,
            emailsEndpoint: `${ghMock.url}/user/emails`,
            clientId: "cid", clientSecret: "sec",
            mapClaims: (u) => ({
              accountId: String(u.id ?? ""),
              email: typeof u.email === "string" ? u.email : undefined,
              emailVerified: u.emailVerified === true,
              name: typeof u.name === "string" ? u.name : undefined,
            }),
          }),
        },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state } = await driveStart(rt, "http://localhost:5173/app", "gh");
    ghMock.setNextUser({ id: 42, login: "octocat", name: "The Octocat" });
    ghMock.setNextEmails([
      { email: "secondary@example.com", primary: false, verified: true },
      { email: "primary@example.com", primary: true, verified: true },
    ]);

    const res = await driveCallback(rt, "gh", state);
    expect(res.status).toBe(302);
    const handoffCode = new URL(res.headers.get("location")!).hash.slice("#code=".length);
    const mint = await completeOAuthSignIn(rt, handoffCode);
    expect(mint.token).toBeTruthy();
  });
});
