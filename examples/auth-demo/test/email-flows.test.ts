/**
 * Auth-demo — email flows (Task 5, auth-demo half).
 *
 * The real through-the-real-server E2E for these flows lives in
 * `packages/cli/test/auth-email-e2e.test.ts` (magic-link round trip, reset revocation fan-out,
 * console-provider smoke — all already passing 3/3). This sibling file exercises the SAME two
 * reactive scenarios at the embedded-runtime level, in this demo's own existing idiom
 * (`flow.test.ts`'s hand-built `composeComponents` + `createEmbeddedRuntime` + loopback
 * `HelipodClient`, no real dev server) — proving `helipod.config.ts`'s newly-composed
 * `defineAuth({ email: {...} })` block (this demo now uses `consoleEmail()`; here we swap in an
 * in-memory capture provider so the test can read the code/token back out, the same substitution
 * `auth-email-e2e.test.ts` makes):
 *
 *   1. magic-link round trip: `client.action(requestMagicLink)` → read the token out of the
 *      capture provider's `sent` array → `signInWithMagicLink` → `setAuth` → a live `whoami.get`
 *      subscription (opened BEFORE) reactively sees the new userId.
 *   2. reset revocation fans out: an authed connection A with a live `whoami` subscription; a
 *      separate connection B runs `requestPasswordReset` + `resetPassword` → A's session row is
 *      deleted (the credential boundary) → A's subscription reactively flips to null.
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { HelipodClient, loopbackTransport, anyApi } from "@helipod/client";
import { query } from "@helipod/executor";
import { defineSchema } from "@helipod/values";
import { composeComponents } from "@helipod/component";
import { defineAuth, type EmailMessage, type EmailProvider, type MintResult } from "@helipod/auth";
import { systemModules } from "@helipod/admin";

// ---------------------------------------------------------------------------
// Typed API references
// ---------------------------------------------------------------------------
const api = anyApi as {
  auth: {
    signUp: { __path: string };
    requestMagicLink: { __path: string };
    signInWithMagicLink: { __path: string };
    requestPasswordReset: { __path: string };
    resetPassword: { __path: string };
  };
  whoami: { get: { __path: string } };
};

// ---------------------------------------------------------------------------
// In-memory capture provider (test-only): records every send, never delivers anything — the same
// substitution `packages/cli/test/auth-email-e2e.test.ts` makes for the demo's `consoleEmail()`.
// ---------------------------------------------------------------------------
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}

/** Pull the base64url token out of a magic-link/reset email's `text` (the `?token=…` link). */
function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

// ---------------------------------------------------------------------------
// Build the same runtime shape as `flow.test.ts`, but composing `defineAuth` WITH an `email` block
// (the capture provider) instead of the bare default `auth`.
// ---------------------------------------------------------------------------
const appSchema = defineSchema({});

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "whoami:get": query(async (ctx: any) => {
    const authCtx = ctx.auth as { getUserId: () => Promise<string | null> } | undefined;
    return authCtx ? await authCtx.getUserId() : null;
  }),
};

async function makeRuntime(provider: EmailProvider): Promise<EmbeddedRuntime> {
  const composed = composeComponents(
    { schemaJson: appSchema.export(), moduleMap: appModules },
    [defineAuth({ email: { provider, from: "no-reply@test", baseUrl: "https://app.test", appName: "Demo" } })],
  );
  return createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    systemModules: systemModules(),
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auth-demo — email flows (magic-link + reset), embedded-runtime idiom", () => {
  it("magic-link round trip: request → redeem → whoami.get reactively sees the new userId", async () => {
    const capture = captureProvider();
    const runtime = await makeRuntime(capture.provider);
    const c = new HelipodClient(loopbackTransport(runtime.connect("magic-c")));

    // Live subscription opened BEFORE sign-in — starts unauthenticated.
    const seen: Array<string | null> = [];
    c.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.length >= 1);
    expect(seen[0]).toBeNull();

    const email = "magic@demo.test";
    const r = (await c.action(api.auth.requestMagicLink, { email })) as { sent: boolean };
    expect(r.sent).toBe(true);
    await waitFor(() => capture.sent.length >= 1);
    const token = extractToken(capture.sent.at(-1)!.text);

    const mint = (await c.mutation(api.auth.signInWithMagicLink, { email, token })) as unknown as MintResult;
    expect(typeof mint.userId).toBe("string");
    c.setAuth(mint.token);

    await waitFor(() => seen.at(-1) === mint.userId);
    expect(seen.at(-1)).toBe(mint.userId);
  });

  it("reset revocation fans out: connection A's live whoami subscription flips to null", async () => {
    const capture = captureProvider();
    const runtime = await makeRuntime(capture.provider);
    const a = new HelipodClient(loopbackTransport(runtime.connect("reset-a")));
    const b = new HelipodClient(loopbackTransport(runtime.connect("reset-b")));

    const email = "reset@demo.test";
    const s = (await a.mutation(api.auth.signUp, { email, password: "hunter2!" })) as unknown as MintResult;
    a.setAuth(s.token);
    const seen: Array<string | null> = [];
    a.subscribe(api.whoami.get, {}, (v) => seen.push(v as string | null));
    await waitFor(() => seen.some((v) => v === s.userId));

    // A separate connection drives the reset — requestPasswordReset is an action; resetPassword
    // revokes EVERY session on the account (credential boundary) and mints a fresh one for itself.
    const r = (await b.action(api.auth.requestPasswordReset, { email })) as { sent: boolean };
    expect(r.sent).toBe(true);
    await waitFor(() => capture.sent.length >= 1);
    const code = extractToken(capture.sent.at(-1)!.text);
    await b.mutation(api.auth.resetPassword, { email, code, newPassword: "newpw123!" });

    // A's session row was deleted by the wipe → its live subscription reactively flips to null.
    await waitFor(() => seen.at(-1) === null);
    expect(seen.at(-1)).toBeNull();
  });
});
