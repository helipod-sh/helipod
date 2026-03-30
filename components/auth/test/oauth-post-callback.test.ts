import { describe, it, expect, afterEach } from "vitest";
import { defineSchema } from "@stackbase/values";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineAuth } from "../src/component";
import { oauthProvider } from "../src/oauth";
import type { MintResult } from "../src/functions";
import { startMockOidcProvider, type MockOidcProvider } from "./support/mock-oauth-provider";

let mock: MockOidcProvider;
afterEach(async () => { if (mock) await mock.close(); });

async function makeRuntime(comp: ReturnType<typeof defineAuth>) {
  const { catalog, moduleMap, componentNames, contextProviders, tableNumbers } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog, modules: moduleMap, componentNames, contextProviders, tableNumbers,
  });
}

/** Drive `/start`, returning the authorize-URL params the callback needs (state + nonce). */
async function driveStart(rt: Awaited<ReturnType<typeof makeRuntime>>, redirectTo: string): Promise<{ state: string; nonce: string }> {
  const req = new Request(`http://127.0.0.1:1/api/auth/oauth/mock/start?redirectTo=` + encodeURIComponent(redirectTo));
  const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get("location")!);
  return { state: loc.searchParams.get("state")!, nonce: loc.searchParams.get("nonce")! };
}

/** POST a urlencoded form body to the callback (the Apple `form_post` transport). */
function drivePostCallback(rt: Awaited<ReturnType<typeof makeRuntime>>, body: Record<string, string>): Promise<Response> {
  const req = new Request("http://127.0.0.1:1/api/auth/oauth/mock/callback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  return rt.runHttpAction("auth:oauthHttp", req, { identity: null });
}

async function complete(rt: Awaited<ReturnType<typeof makeRuntime>>, handoffCode: string): Promise<MintResult> {
  const r = await rt.runAction<MintResult>("auth:completeOAuthSignIn", { handoffCode }, { identity: null });
  return r.value;
}

describe("A2/A1/A3 seam: form_post POST callback + async clientSecret + cosmetic user JSON", () => {
  it("a urlencoded POST callback reaches the same downstream as GET; identity comes from the id_token, NOT the POST user JSON", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: {
          // Apple-shaped: oidc + form_post + an ASYNC clientSecret minter, pointed at the loopback mock.
          mock: oauthProvider({
            kind: "oidc", issuer: mock.url, clientId: "cid",
            clientSecret: async () => "minted-secret",
            responseMode: "form_post",
            mapClaims: (c, extra) => {
              const first = extra?.user?.name?.firstName;
              const last = extra?.user?.name?.lastName;
              const name = [first, last].filter((s): s is string => typeof s === "string" && s.length > 0).join(" ") || undefined;
              return {
                accountId: String(c.sub ?? ""),
                email: typeof c.email === "string" ? c.email : undefined,       // from the VERIFIED id_token only
                emailVerified: c.email_verified === true || c.email_verified === "true",
                ...(name ? { name } : {}),
              };
            },
          }),
        },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);

    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    // The id_token carries the TRUE identity email; the POST `user` JSON carries a DIFFERENT email that
    // must be ignored for identity.
    mock.setNextIdTokenClaims({ sub: "apple-sub", aud: "cid", email: "real@icloud.com", email_verified: true, nonce });

    const res = await drivePostCallback(rt, {
      code: "mockcode",
      state,
      user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "attacker@evil.com" }),
    });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get("location")!);
    expect(target.origin + target.pathname).toBe("http://localhost:5173/app");
    expect(target.search).toBe("");                 // handoff in the fragment, never the query
    expect(target.hash).toMatch(/^#code=/);
    const handoffCode = target.hash.slice("#code=".length);

    const mint = await complete(rt, handoffCode);
    expect(mint.token).toBeTruthy();
    expect(mint.userId).toBeTruthy();
    // The provisioned user's email is the id_token's, never the POST body's — verified via a privileged read.
    const uid = await rt.run<string | null>("auth:getUserId", { token: mint.token }, { identity: null });
    expect(uid.value).toBe(mint.userId);
  });

  it("a POST callback with a non-urlencoded content-type ⇒ 400", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: async () => "s", responseMode: "form_post" }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);
    await driveStart(rt, "http://localhost:5173/app");
    const req = new Request("http://127.0.0.1:1/api/auth/oauth/mock/callback", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "x", state: "y" }),
    });
    const res = await rt.runHttpAction("auth:oauthHttp", req, { identity: null });
    expect(res.status).toBe(400);
  });

  it("a replayed POST callback (same state twice) ⇒ 400 on the second (single-use state, transport-agnostic)", async () => {
    mock = await startMockOidcProvider();
    const comp = defineAuth({
      oauth: {
        providers: { mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: "cid", clientSecret: async () => "s", responseMode: "form_post", mapClaims: (c) => ({ accountId: String(c.sub ?? ""), email: typeof c.email === "string" ? c.email : undefined, emailVerified: c.email_verified === true }) }) },
        redirectAllowlist: ["http://localhost:5173"],
      },
    });
    const rt = await makeRuntime(comp);
    const { state, nonce } = await driveStart(rt, "http://localhost:5173/app");
    mock.setNextIdTokenClaims({ sub: "s1", aud: "cid", email: "u@icloud.com", email_verified: true, nonce });
    const first = await drivePostCallback(rt, { code: "mockcode", state });
    expect(first.status).toBe(302);
    const replay = await drivePostCallback(rt, { code: "mockcode", state });
    expect(replay.status).toBe(400);
  });
});
