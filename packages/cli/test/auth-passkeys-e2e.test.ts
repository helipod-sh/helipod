/**
 * Auth passkeys/WebAuthn — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint
 * rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with `@stackbase/auth`
 * composed WITH a `passkeys` config, mirroring `auth-session-e2e.test.ts`/`auth-external-e2e.test.ts`
 * (`loadProject` + `createEmbeddedRuntime` + `startDevServer` + real client/WebSocket transport,
 * event-driven `waitFor` — no bare sleeps for correctness-critical waits). The genuine
 * `@simplewebauthn/server` verify path runs server-side; the client drives a software authenticator
 * (`packages/cli/test/support/mock-authenticator.ts`, a synced copy of the component's) that produces
 * REAL P-256 attestations/assertions. Unlike the OAuth E2E, passkeys add NO `componentRoutes` (every
 * ceremony is a client-callable action over the sync connection), so there is no route-closure wiring.
 *
 *  (1) register-while-anon → usernameless sign-in on a FRESH connection reactively flips a live
 *      `whoami` subscription to the registered userId (the mint fanning out);
 *  (2) a counter-regression assertion is rejected and the subscription stays put (clone detection).
 */
import { describe, it, expect, afterAll } from "vitest";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineAuth, type MintResult } from "@stackbase/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";
import { createMockAuthenticator } from "./support/mock-authenticator";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
  },
};

const api = anyApi as {
  auth: {
    signInAnonymously: { __path: string };
    beginPasskeyRegistration: { __path: string };
    finishPasskeyRegistration: { __path: string };
    beginPasskeyAuthentication: { __path: string };
    finishPasskeyAuthentication: { __path: string };
  };
  whoami: { get: { __path: string } };
};

const servers: DevServer[] = [];
async function startServer(): Promise<{ wsUrl: string }> {
  const project = loadProject({ schema: defineSchema({}), modules: appModules }, [
    defineAuth({ passkeys: { rpID: RP_ID, rpName: "Test", origins: [ORIGIN] } }),
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
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  return { wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe("auth passkeys E2E through the real dev server", () => {
  it("(1) register-while-anon, then usernameless sign-in on a fresh connection flips a live whoami subscription to the registered user", async () => {
    const { wsUrl } = await startServer();
    // Connection A: sign in anonymously and register a passkey against that account.
    const a = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    const authenticator = createMockAuthenticator();
    let userId: string;
    let credentialId: string;
    try {
      const anon = (await a.mutation(api.auth.signInAnonymously, {})) as unknown as MintResult;
      a.setAuth(anon.token);
      userId = anon.userId;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (await a.action(api.auth.beginPasskeyRegistration, {})) as any;
      const regResponse = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
      credentialId = regResponse.id;
      const registered = (await a.action(api.auth.finishPasskeyRegistration, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: regResponse as any,
      })) as { registered: boolean };
      expect(registered.registered).toBe(true);
    } finally {
      a.close();
    }

    // Connection B (FRESH, unauthenticated): open a live whoami subscription (null), then drive a
    // usernameless passkey sign-in and hand the minted token to setAuth.
    const b = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const seen: Array<string | null> = [];
      b.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
      await waitFor(() => seen.length > 0, 5000, "initial null");
      expect(seen.at(-1)).toBeNull();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (await b.action(api.auth.beginPasskeyAuthentication, {})) as any;
      expect(options.allowCredentials).toEqual([]); // usernameless
      const assertion = authenticator.createAssertion({
        challenge: options.challenge,
        rpID: RP_ID,
        origin: ORIGIN,
        credentialId,
        counter: 1,
        userId, // discoverable credential reports its owner via userHandle
      });
      const mint = (await b.action(api.auth.finishPasskeyAuthentication, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: assertion as any,
      })) as unknown as MintResult;
      expect(mint.userId).toBe(userId);
      b.setAuth(mint.token);

      await waitFor(() => seen.at(-1) === userId, 5000, "reactive passkey sign-in");
      expect(seen.at(-1)).toBe(userId);
    } finally {
      b.close();
    }
  });

  it("(2) a counter-regression assertion is rejected — clone detection; the subscription stays authenticated", async () => {
    const { wsUrl } = await startServer();
    const a = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    const authenticator = createMockAuthenticator();
    let userId: string;
    let credentialId: string;
    try {
      const anon = (await a.mutation(api.auth.signInAnonymously, {})) as unknown as MintResult;
      a.setAuth(anon.token);
      userId = anon.userId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options = (await a.action(api.auth.beginPasskeyRegistration, {})) as any;
      const regResponse = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
      credentialId = regResponse.id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await a.action(api.auth.finishPasskeyRegistration, { response: regResponse as any });
    } finally {
      a.close();
    }

    const b = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      // First sign-in advances the stored counter to 5.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts1 = (await b.action(api.auth.beginPasskeyAuthentication, {})) as any;
      const first = authenticator.createAssertion({ challenge: opts1.challenge, rpID: RP_ID, origin: ORIGIN, credentialId, counter: 5, userId });
      const mint = (await b.action(api.auth.finishPasskeyAuthentication, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        response: first as any,
      })) as unknown as MintResult;
      b.setAuth(mint.token);
      const seen: Array<string | null> = [];
      b.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
      await waitFor(() => seen.at(-1) === userId, 5000, "authed after first sign-in");

      // A cloned authenticator presents a regressed counter (3 < 5) under a fresh challenge → reject.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts2 = (await b.action(api.auth.beginPasskeyAuthentication, {})) as any;
      const cloned = authenticator.createAssertion({ challenge: opts2.challenge, rpID: RP_ID, origin: ORIGIN, credentialId, counter: 3, userId });
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        b.action(api.auth.finishPasskeyAuthentication, { response: cloned as any }),
      ).rejects.toThrow(/passkey authentication failed/);

      // The existing session is untouched — the subscription is still the same user.
      expect(seen.at(-1)).toBe(userId);
    } finally {
      b.close();
    }
  });
});
