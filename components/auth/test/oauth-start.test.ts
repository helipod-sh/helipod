import { describe, it, expect, afterEach } from "vitest";
import { defineSchema } from "@helipod/values";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { query, type QueryCtx } from "@helipod/executor";
import { defineAuth } from "../src/component";
import { oauthProvider, githubProvider } from "../src/oauth";
import { sha256base64url } from "../src/crypto";

// A mock OIDC discovery server so `authorizationServerFor()` resolves without live network.
import { createServer, type Server } from "node:http";
let mock: Server;
let mockUrl = "";
async function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    if (req.url === "/.well-known/openid-configuration") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: mockUrl,
          authorization_endpoint: `${mockUrl}/authorize`,
          token_endpoint: `${mockUrl}/token`,
          jwks_uri: `${mockUrl}/jwks`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => mock.listen(0, "127.0.0.1", r));
  const a = mock.address();
  mockUrl = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}
afterEach(async () => {
  await new Promise<void>((r) => mock.close(() => r()));
});

/** Privileged test-only reader over `auth/oauthState` — same raw-physical-table idiom as
 *  `email-issue.test.ts`'s `_readAuthCode` (`ctx.privileged` bypasses component namespacing). */
const _allOauthState = query(async (ctx: QueryCtx) => {
  return ctx.db.query("auth/oauthState", "byStateHash").collect();
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
    systemModules: { "_test:allOauthState": _allOauthState },
  });
}

it("/start allowlisted ⇒ writes a hashed state row + 302s to the authorize URL with S256 + nonce", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"));
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(`${mockUrl}/authorize`);
  expect(loc.searchParams.get("response_type")).toBe("code");
  expect(loc.searchParams.get("client_id")).toBe("cid");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("code_challenge")).toBeTruthy();
  expect(loc.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:1/api/auth/oauth/mock/callback");
  const nonce = loc.searchParams.get("nonce");
  const state = loc.searchParams.get("state")!;
  expect(nonce).toBeTruthy();
  expect(state).toBeTruthy();

  // The state row is hashed at rest; the raw state never appears in a row. codeVerifier/nonce are
  // stored RECOVERABLE (the documented PKCE exception) — never hashed, never returned to the client.
  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(1);
  const row = rows[0]!;
  expect(row.stateHash).toBe(sha256base64url(state));
  expect(row.stateHash).not.toBe(state); // never the raw state
  expect(typeof row.codeVerifier).toBe("string");
  expect((row.codeVerifier as string).length).toBeGreaterThan(0);
  expect(row.nonce).toBe(nonce); // recoverable, matches what's in the authorize URL
  expect(row.redirectTo).toBe("http://localhost:5173/app");
  expect(row.provider).toBe("mock");
  expect(row.linkUserId).toBeUndefined(); // no Authorization header presented

  // Nothing in the response leaks codeVerifier/nonce/state beyond the (expected) authorize URL params.
  expect(res.headers.get("content-type") ?? "").not.toMatch(/json/);

});

it("/start with a non-allowlisted redirectTo ⇒ 400, no state row written (open-redirect guard)", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const res = await rt.runHttpAction(
    "auth:oauthHttp",
    new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://evil.example/x")),
    { identity: null },
  );
  expect(res.status).toBe(400);
  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(0);

});

it("/start for an unknown provider ⇒ 404", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const res = await rt.runHttpAction(
    "auth:oauthHttp",
    new Request("http://127.0.0.1:1/api/auth/oauth/nope/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app")),
    { identity: null },
  );
  expect(res.status).toBe(404);

});

it("/start with a live Authorization bearer ⇒ the state row records linkUserId (link-while-signed-in)", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const { token, userId } = (await rt.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"), {
    headers: { authorization: `Bearer ${token}` },
  });
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);

  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(1);
  expect(rows[0]!.linkUserId).toBe(userId);

});

// ─────────────────────────── Fix wave regression pins ───────────────────────────

it("/start with a FORGED bearer token ⇒ linkUserId stays UNSET (no pre-seeded link to an arbitrary user)", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  // A victim exists so a would-be attacker has a real userId to try to link against — but the
  // attacker never actually authenticated as them, only guessed/forged a bearer value.
  await rt.run<{ token: string; userId: string }>("auth:signUp", { email: "victim@b.co", password: "pw" });

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"), {
    headers: { authorization: "Bearer not-a-real-session" },
  });
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);

  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(1);
  expect(rows[0]!.linkUserId).toBeUndefined();
});

it("/start with a REVOKED (signed-out) session token ⇒ linkUserId stays UNSET", async () => {
  await startMock();
  const comp = defineAuth({
    oauth: {
      providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const { token } = (await rt.run<{ token: string; userId: string }>("auth:signUp", { email: "gone@b.co", password: "pw" })).value;
  await rt.run("auth:signOut", { token }); // the session row backing `token` no longer exists

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"), {
    headers: { authorization: `Bearer ${token}` },
  });
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);

  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(1);
  expect(rows[0]!.linkUserId).toBeUndefined();
});

it("/start for a NON-OIDC (oauth2, github-shaped) provider ⇒ authorize URL has NO nonce param, flow still works", async () => {
  const comp = defineAuth({
    oauth: {
      providers: { gh: githubProvider({ clientId: "cid", clientSecret: "sec" }) },
      redirectAllowlist: ["http://localhost:5173"],
    },
  });
  const rt = await makeRuntime(comp);

  const start = new Request("http://127.0.0.1:1/api/auth/oauth/gh/start?redirectTo=" + encodeURIComponent("http://localhost:5173/app"));
  const res = await rt.runHttpAction("auth:oauthHttp", start, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(loc.searchParams.get("response_type")).toBe("code");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.has("nonce")).toBe(false); // the oauth2 (non-OIDC) branch — no nonce ever minted

  const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
  expect(rows.length).toBe(1);
  expect(rows[0]!.nonce).toBeUndefined();
  expect(rows[0]!.provider).toBe("gh");
});

it.each(["__proto__", "constructor", "hasOwnProperty", "toString"])(
  "/start for prototype-member provider name %s ⇒ clean 404, no internal-error leak (prototype-pollution guard)",
  async (provider) => {
    await startMock();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mockUrl, clientId: "cid", clientSecret: "sec" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const res = await rt.runHttpAction(
      "auth:oauthHttp",
      new Request(`http://127.0.0.1:1/api/auth/oauth/${provider}/start?redirectTo=` + encodeURIComponent("http://localhost:5173/app")),
      { identity: null },
    );
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toBe("authentication failed"); // the generic GENERIC fail() shape, not a stack/message leak
    expect((res.headers.get("content-type") ?? "")).toMatch(/text\/plain/);

    const rows = (await rt.runSystem<Record<string, unknown>[]>("_test:allOauthState", {})).value;
    expect(rows.length).toBe(0); // never reached the state-write path
  },
);

describe("isAllowedRedirect — path-prefix requires a segment boundary", () => {
  // Imported lazily inside the describe to keep the top-level import list unchanged for the
  // other tests in this file; oauth.ts already exports `isAllowedRedirect` publicly.
  it("rejects a same-origin sibling path that merely shares a string prefix", async () => {
    const { isAllowedRedirect } = await import("../src/oauth");
    expect(isAllowedRedirect("https://app.com/app-evil/x", ["https://app.com/app"])).toBe(false);
  });

  it("accepts a true subtree path and the exact allowlisted path itself", async () => {
    const { isAllowedRedirect } = await import("../src/oauth");
    expect(isAllowedRedirect("https://app.com/app/sub", ["https://app.com/app"])).toBe(true);
    expect(isAllowedRedirect("https://app.com/app", ["https://app.com/app"])).toBe(true);
  });

  it("a trailing-slash allowlist entry behaves the same as its non-slash form", async () => {
    const { isAllowedRedirect } = await import("../src/oauth");
    expect(isAllowedRedirect("https://app.com/app/", ["https://app.com/app/"])).toBe(true);
    expect(isAllowedRedirect("https://app.com/app/sub", ["https://app.com/app/"])).toBe(true);
    expect(isAllowedRedirect("https://app.com/app-evil/x", ["https://app.com/app/"])).toBe(false);
  });
});
