/**
 * Auth A3 (external identity) — E2E through the real `stackbase dev` server
 * (e2e-through-shipped-entrypoint rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL
 * server with `@stackbase/auth` composed WITH `oauth`/`jwt` config blocks, mirroring
 * `auth-session-e2e.test.ts`/`auth-email-e2e.test.ts` exactly (`loadProject` + `createEmbeddedRuntime`
 * + `startDevServer` + real client/WebSocket transport, event-driven `waitFor` — no bare sleeps for
 * correctness-critical waits). Two LOOPBACK mock servers stand in for a real provider/issuer (no live
 * third-party network — `packages/cli/test/support/mock-oauth-provider.ts`).
 *
 * Per Task 1, a composed component's reserved routes (`@stackbase/auth`'s `/api/auth/oauth/*`) are
 * NOT dispatched automatically by `startDevServer` — the caller must build the runtime-bound
 * closures and pass them as `componentRoutes`, exactly as `packages/cli/src/boot.ts`'s `bootLoaded`
 * does (see that file's `bearerOf`/`componentRoutes` block, and Task 1's own
 * `component-routes-e2e.test.ts`).
 *
 *  (1) OAuth round trip: `/start` -> read `state`/`nonce` off the 302 `Location` -> the mock's
 *      `/token` echoes the nonce into a jose-signed `id_token` -> `/callback` -> a 302 whose
 *      FRAGMENT (never the query) carries a one-time handoff code -> `completeOAuthSignIn` ->
 *      `setAuth` -> a live `whoami.get` subscription (opened BEFORE) sees the new userId. Plus: a
 *      second `completeOAuthSignIn` with the same handoff rejects (single-use, consume-before-
 *      validate), and a tampered `state` -> `/callback` 400.
 *  (2) `signInWithIdToken` round trip: a JWT minted directly with the mock's `signIdToken` (no
 *      provider round trip at all) -> `client.action(signInWithIdToken)` -> `setAuth` -> the live
 *      `whoami.get` subscription sees the JIT-provisioned `oidc:<issuer>` userId.
 *  (3) THE security payoff — verified-email autolink through the real server: a password user signs
 *      up (unverified — no verification flow driven) and opens a live `whoami` subscription; a
 *      SEPARATE connection then runs the OAuth flow with the SAME verified email. The resulting
 *      `userId` is the SAME (external identity linked to the pre-existing account, never a fresh
 *      one), and the password session's subscription flips to `null` — the flip-gated
 *      first-mailbox-proof revocation (`markVerifiedRevokingIfFirstProof`) fanning out reactively.
 */
import { describe, it, expect, afterAll } from "vitest";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineAuth, oauthProvider, type MintResult } from "@stackbase/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";
import { startMockProvider, DEFAULT_CLIENT_ID, type MockProvider } from "./support/mock-oauth-provider";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

const appSchema = defineSchema({});

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
  },
};

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    completeOAuthSignIn: { __path: string };
    signInWithIdToken: { __path: string };
  };
  whoami: { get: { __path: string } };
};

const REDIRECT_ALLOWLIST = ["http://localhost:5173"];

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

/** Boot the real dev server with `@stackbase/auth` composed WITH both `oauth` (a single "mock"
 *  provider pointed at the loopback mock) and `jwt` (its issuer pointed at the same mock's `/jwks`).
 *  Builds `componentRoutes` exactly as `boot.ts`'s `bootLoaded` does — see that file's comment. */
async function startServer(mock: MockProvider): Promise<{ server: DevServer; wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules }, [
    defineAuth({
      oauth: {
        providers: {
          mock: oauthProvider({ kind: "oidc", issuer: mock.url, clientId: DEFAULT_CLIENT_ID, clientSecret: "sec" }),
        },
        redirectAllowlist: REDIRECT_ALLOWLIST,
      },
      jwt: { issuers: [{ issuer: mock.url, audience: "stackbase", jwksUrl: mock.jwksUrl }] },
    }),
  ]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  // Component-contributed reserved routes (Task 1) — bound to the runtime EXACTLY as boot.ts's
  // bootLoaded does (bearerOf + the StorageRoute-shaped closure), since startDevServer itself does
  // not know about any component's routes — the caller (normally boot.ts; here, the test) wires them.
  const bearerOf = (request: Request): string | null => {
    const h = request.headers.get("authorization");
    const m = h ? /^Bearer\s+(.+)$/.exec(h) : null;
    return m ? (m[1] ?? null) : null;
  };
  const componentRoutes = project.componentRoutes.map((r) => ({
    method: r.method,
    pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: bearerOf(request) }),
  }));
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", componentRoutes });
  servers.push(server);
  return { server, wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

describe("auth A3 external identity — E2E through the real dev server", () => {
  it("(1) OAuth round trip: /start -> /callback -> fragment handoff -> completeOAuthSignIn -> a live whoami subscription sees the new userId", async () => {
    const mock = await startMockProvider();
    try {
      const { server, wsUrl } = await startServer(mock);
      const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      try {
        // Live subscription opened BEFORE the sign-in — starts unauthenticated (null).
        const seen: Array<string | null> = [];
        c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
        await waitFor(() => seen.length >= 1, 5000, "initial");
        expect(seen.at(-1)).toBeNull();

        const redirectTo = "http://localhost:5173/app";
        const startRes = await fetch(
          `${server.url}/api/auth/oauth/mock/start?redirectTo=${encodeURIComponent(redirectTo)}`,
          { redirect: "manual" },
        );
        expect(startRes.status).toBe(302);
        const loc = new URL(startRes.headers.get("location")!);
        const state = loc.searchParams.get("state")!;
        const nonce = loc.searchParams.get("nonce")!;
        expect(state).toBeTruthy();
        expect(nonce).toBeTruthy();

        // The nonce-echo trick: the mock's NEXT /token response mints an id_token carrying this
        // exact nonce — the server's own oauth4webapi hits the mock over loopback http when it
        // drives /callback below, no real browser/authorize step needed.
        mock.setNextToken({ nonce, sub: "gsub", email: "e2e@ext.com", emailVerified: true });

        const cb = await fetch(
          `${server.url}/api/auth/oauth/mock/callback?code=mockcode&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        expect(cb.status).toBe(302);
        const cbLoc = new URL(cb.headers.get("location")!);
        expect(cbLoc.origin + cbLoc.pathname).toBe(redirectTo);
        expect(cbLoc.search).toBe(""); // the handoff MUST be in the fragment, never the query
        expect(cbLoc.hash).toMatch(/^#code=/);
        const handoffCode = cbLoc.hash.replace(/^#code=/, "");
        expect(handoffCode.length).toBeGreaterThan(0);

        const mint = (await c.action(api.auth.completeOAuthSignIn, { handoffCode })) as unknown as MintResult;
        expect(typeof mint.userId).toBe("string");
        expect(mint.token).toBeTruthy();
        c.setAuth(mint.token);

        await waitFor(() => seen.at(-1) === mint.userId, 5000, "reactive oauth sign-in");
        expect(seen.at(-1)).toBe(mint.userId);

        // Single-use: a second exchange of the SAME handoff code rejects (consume-before-validate).
        await expect(c.action(api.auth.completeOAuthSignIn, { handoffCode })).rejects.toThrow();

        // A tampered/unknown state -> /callback 400 (no matching row, no enumeration).
        const tampered = await fetch(
          `${server.url}/api/auth/oauth/mock/callback?code=mockcode&state=totally-bogus-state`,
          { redirect: "manual" },
        );
        expect(tampered.status).toBe(400);
      } finally {
        c.close();
      }
    } finally {
      await mock.close();
    }
  });

  it("(2) signInWithIdToken round trip: a mock-signed JWT mints a session and a live whoami subscription sees the JIT-provisioned userId", async () => {
    const mock = await startMockProvider();
    try {
      const { wsUrl } = await startServer(mock);
      const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      try {
        const seen: Array<string | null> = [];
        c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
        await waitFor(() => seen.length >= 1, 5000, "initial");
        expect(seen.at(-1)).toBeNull();

        const idToken = await mock.signIdToken({ sub: "jwtsub", email: "jwt@ext.com", emailVerified: true });
        const mint = (await c.action(api.auth.signInWithIdToken, { idToken })) as unknown as MintResult;
        expect(typeof mint.userId).toBe("string");
        c.setAuth(mint.token);

        await waitFor(() => seen.at(-1) === mint.userId, 5000, "reactive jwt sign-in");
        expect(seen.at(-1)).toBe(mint.userId);
      } finally {
        c.close();
      }
    } finally {
      await mock.close();
    }
  });

  it("(3) verified-email autolink through the real server: OAuth sign-in with the SAME verified email links to the pre-existing password account and revokes its session reactively", async () => {
    const mock = await startMockProvider();
    try {
      const { server, wsUrl } = await startServer(mock);
      const a = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      const b = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      try {
        const email = "link@ext.com";
        // Password sign-up, no email-verification flow driven — the user is UNVERIFIED, the exact
        // pre-registration-takeover shape the flip-gated revocation defends against.
        const s = (await a.mutation(api.auth.signUp, { email, password: "pw", deviceLabel: "Chrome" })) as unknown as MintResult;
        a.setAuth(s.token);
        const seen: Array<string | null> = [];
        a.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
        await waitFor(() => seen.some((v) => v === s.userId), 5000, "password authed");

        // A SEPARATE connection (b) drives the OAuth flow with the SAME verified email.
        const redirectTo = "http://localhost:5173/app";
        const startRes = await fetch(
          `${server.url}/api/auth/oauth/mock/start?redirectTo=${encodeURIComponent(redirectTo)}`,
          { redirect: "manual" },
        );
        const loc = new URL(startRes.headers.get("location")!);
        const state = loc.searchParams.get("state")!;
        const nonce = loc.searchParams.get("nonce")!;
        mock.setNextToken({ nonce, sub: "linksub", email, emailVerified: true });
        const cb = await fetch(
          `${server.url}/api/auth/oauth/mock/callback?code=mockcode&state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        const handoffCode = new URL(cb.headers.get("location")!).hash.replace(/^#code=/, "");
        const mint = (await b.action(api.auth.completeOAuthSignIn, { handoffCode })) as unknown as MintResult;

        // SAME userId — the OAuth identity was LINKED to the pre-existing password user (verified-
        // email-required autolink), never a fresh one.
        expect(mint.userId).toBe(s.userId);

        // The password session's subscription reactively flips to null — the flip-gated
        // first-mailbox-proof revocation (markVerifiedRevokingIfFirstProof) fanning out through A's
        // read-set, exactly like A1/A2's reactive-revoke idiom.
        await waitFor(() => seen.at(-1) === null, 5000, "reactive link-revoke");
        expect(seen.at(-1)).toBeNull();
      } finally {
        a.close();
        b.close();
      }
    } finally {
      await mock.close();
    }
  });
});
