/**
 * Auth A2 (email flows) — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint
 * rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with `@stackbase/auth`
 * composed WITH an `email` config block, mirroring `auth-session-e2e.test.ts` exactly
 * (`loadProject` + `createEmbeddedRuntime` + `startDevServer` + real client/WebSocket transport,
 * event-driven `waitFor` — no bare sleeps for correctness-critical waits).
 *
 *  (1) magic-link round trip: `client.action(requestMagicLink)` → read the token out of the capture
 *      provider's `sent` array (exactly what a user reads from their inbox) → `signInWithMagicLink`
 *      → `setAuth` → a live `whoami.get` subscription (opened BEFORE) sees the new userId;
 *  (2) reset revocation fans out: an authed connection A with a live `whoami` subscription; another
 *      connection B runs `requestPasswordReset` + `resetPassword` → all of the user's sessions are
 *      revoked (the credential boundary — decision 8) → A's session-row delete fans out through the
 *      read-set and its subscription flips to null (mirrors A1 E2E test (1)'s reactive-revoke idiom);
 *  (3) console-provider smoke: compose `consoleEmail()`, spy `console.log`, run `requestOtp` → the
 *      server logs the code and the action returns `{ sent: true }` — the zero-config path works E2E.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import {
  defineAuth,
  consoleEmail,
  type EmailMessage,
  type EmailProvider,
  type MintResult,
} from "@stackbase/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** In-memory CAPTURE provider (test-only): records every send, never delivers anything. The test
 *  reads the raw code/link out of `sent.at(-1).text` — exactly what a real user reads from an inbox. */
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}

/** Pull the 32-char base64url token out of a magic/reset/verify email's `text` (the `?token=…` link). */
function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

const appSchema = defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
  },
  notes: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    add: mutation(async (ctx: any, { body }: { body: string }) => {
      const uid = await ctx.auth.getUserId();
      if (!uid) throw new Error("not authenticated");
      return ctx.db.insert("notes", { userId: uid, body });
    }),
  },
};

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    requestMagicLink: { __path: string };
    signInWithMagicLink: { __path: string };
    requestPasswordReset: { __path: string };
    resetPassword: { __path: string };
    requestOtp: { __path: string };
  };
  whoami: { get: { __path: string } };
};

const servers: DevServer[] = [];
async function startServer(email: { provider: EmailProvider }): Promise<{ wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules }, [
    defineAuth({
      email: { provider: email.provider, from: "no-reply@test", baseUrl: "https://app.test", appName: "Demo" },
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
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  servers.push(server);
  return { wsUrl: `ws://127.0.0.1:${server.port}/api/sync` };
}

afterAll(async () => { for (const s of servers) await s.close(); });

describe("auth A2 email flows — E2E through the real dev server", () => {
  it("(1) magic-link round trip: request → redeem → a live whoami subscription sees the new userId", async () => {
    const capture = captureProvider();
    const { wsUrl } = await startServer({ provider: capture.provider });
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      // Live subscription opened BEFORE the sign-in — starts unauthenticated (null).
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.length >= 1, 5000, "initial");
      expect(seen.at(-1)).toBeNull();

      const email = "magic@user.test";
      // request* is an ACTION over the WS sync connection.
      const r = (await c.action(api.auth.requestMagicLink, { email })) as { sent: boolean };
      expect(r.sent).toBe(true);
      await waitFor(() => capture.sent.length >= 1, 5000, "email captured");
      const token = extractToken(capture.sent.at(-1)!.text);

      // Redeem the link (a mutation minting a session for the newly-created user).
      const mint = (await c.mutation(api.auth.signInWithMagicLink, { email, token })) as unknown as MintResult;
      expect(typeof mint.userId).toBe("string");
      c.setAuth(mint.token);

      await waitFor(() => seen.at(-1) === mint.userId, 5000, "reactive sign-in");
      expect(seen.at(-1)).toBe(mint.userId);
    } finally {
      c.close();
    }
  });

  it("(2) reset revocation fans out reactively to a live whoami subscription", async () => {
    const capture = captureProvider();
    const { wsUrl } = await startServer({ provider: capture.provider });
    const a = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    const b = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const email = "reset@user.test";
      const s = (await a.mutation(api.auth.signUp, { email, password: "pw", deviceLabel: "Chrome" })) as unknown as MintResult;
      a.setAuth(s.token);
      const seen: Array<string | null> = [];
      a.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.some((x) => x === s.userId), 5000, "authed");

      // A SEPARATE connection (B, unauthenticated) drives the reset. requestPasswordReset is an
      // action; resetPassword revokes ALL of the user's sessions (decision 8) and mints a fresh one.
      const r = (await b.action(api.auth.requestPasswordReset, { email })) as { sent: boolean };
      expect(r.sent).toBe(true);
      await waitFor(() => capture.sent.length >= 1, 5000, "reset email captured");
      const code = extractToken(capture.sent.at(-1)!.text);
      await b.mutation(api.auth.resetPassword, { email, code, newPassword: "newpw" });

      // A's old session row was deleted by the credential-boundary wipe → its live subscription flips
      // to null (the same reactive-revoke fan-out A1 E2E test (1) pins).
      await waitFor(() => seen.at(-1) === null, 5000, "reactive reset-revoke");
      expect(seen.at(-1)).toBeNull();
    } finally {
      a.close();
      b.close();
    }
  });

  it("(3) console-provider smoke: requestOtp logs the code and returns { sent: true }", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { wsUrl } = await startServer({ provider: consoleEmail() });
      const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
      try {
        // A known account so the OTP flow issues a real, redeemable code (and thus a real send).
        await c.mutation(api.auth.signUp, { email: "otp@user.test", password: "pw" });
        const r = (await c.action(api.auth.requestOtp, { email: "otp@user.test" })) as { sent: boolean };
        expect(r.sent).toBe(true);
        // The zero-config console provider logged the email (incl. the code) to the server console.
        await waitFor(
          () => logSpy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("stackbase auth"))),
          5000,
          "console log",
        );
        expect(
          logSpy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("stackbase auth"))),
        ).toBe(true);
      } finally {
        c.close();
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});
