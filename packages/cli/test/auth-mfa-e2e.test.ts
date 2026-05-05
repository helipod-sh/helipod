/**
 * Auth A4 (MFA/TOTP) — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint
 * rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with `@stackbase/auth`
 * composed WITH an `mfa` config block, mirroring `auth-session-e2e.test.ts`/`auth-email-e2e.test.ts`
 * exactly (`loadProject` + `createEmbeddedRuntime` + `startDevServer` + real client/WebSocket
 * transport, event-driven `waitFor` — no bare sleeps for correctness-critical waits).
 *
 * The live TOTP code is derived from the RAW secret `startMfaEnrollment` returns using the real
 * `totp.ts` primitive (`totpCodeAt`/`currentStep`) — not a mock — so the whole enroll → confirm →
 * gate → complete ceremony is proven end to end, exactly as a real authenticator app would compute it.
 *
 *  (1) enroll → confirm → sign out → sign in (gated: `{ mfaRequired: true }`, NO session) →
 *      `completeMfaSignIn` with a fresh live TOTP code → a working session, proven live via a
 *      subscription opened BEFORE `completeMfaSignIn` that resolves the signed-in identity;
 *  (2) a second, independently-enrolled user signs in with a RECOVERY code instead of a TOTP code
 *      (the code is consumed — `getMfaStatus.recoveryCodesRemaining` drops by one);
 *  (3) `disableMfa` (re-authed with a fresh TOTP) un-gates the account — a subsequent `signIn`
 *      mints a session directly, no `mfaRequired` step.
 */
import { describe, it, expect, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { query, mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineAuth, type MintResult, type MfaRequired } from "@stackbase/auth";
import { loadProject, startDevServer, type DevServer } from "../src/index";
// The real RFC 6238 primitive Tasks 1-5 shipped — used here (not mocked) to derive a LIVE code from
// the raw secret `startMfaEnrollment` hands back, proving the actual authenticator-app ceremony.
// `@stackbase/auth`'s package exports only its root entrypoint (this internal primitive is
// deliberately un-exported source, not part of the public surface), so this reaches across the
// package boundary by relative path — outside `packages/cli`'s own `rootDir`, hence the suppression
// below (a `tsc --noEmit` quirk: it computes a common source directory even without emitting).
// Vitest (esbuild) resolves and transpiles the file directly at test-run time regardless.
// @ts-ignore -- TS6059: cross-package relative import intentionally outside this project's rootDir
import { totpCodeAt, currentStep } from "../../../components/auth/src/mfa/totp";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

/** A fresh 32-byte test key per module load — `mfa.encryptionKey` accepts base64 or hex. */
function testEncryptionKey(): string {
  return randomBytes(32).toString("base64");
}

/** Derive the CURRENT live TOTP code from a raw base32 secret, exactly as an authenticator app
 *  would — the default digits/period (6/30) match the server's un-overridden `mfa` config. */
function liveTotpCode(secretBase32: string): string {
  return totpCodeAt(secretBase32, currentStep(Date.now()));
}

/** The TOTP replay guard (decision 9) rejects a matched step <= the enrollment's `lastUsedStep` —
 *  so two consecutive live-code verifications inside the SAME 30s step (e.g. `confirmMfaEnrollment`
 *  then `completeMfaSignIn` moments later) would have the second one legitimately rejected as a
 *  replay, not a bug. Sleep past the step boundary once so a subsequently-derived code is for a
 *  genuinely later step. Deterministic sleep duration (time until the next boundary + a small
 *  buffer), not a poll loop. */
async function waitForNextTotpStep(periodSec = 30): Promise<void> {
  const periodMs = periodSec * 1000;
  const ms = periodMs - (Date.now() % periodMs) + 50;
  await new Promise<void>((r) => setTimeout(r, ms));
}

const appSchema = defineSchema({
  notes: defineTable({ userId: v.string(), body: v.string() }).index("byUser", ["userId"]),
});

const appModules = {
  whoami: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: query(async (ctx: any) => (ctx.auth ? await ctx.auth.getUserId() : null)),
  },
};

const api = anyApi as {
  auth: {
    signUp: { __path: string };
    signIn: { __path: string };
    signOut: { __path: string };
    startMfaEnrollment: { __path: string };
    confirmMfaEnrollment: { __path: string };
    completeMfaSignIn: { __path: string };
    disableMfa: { __path: string };
    getMfaStatus: { __path: string };
  };
  whoami: { get: { __path: string } };
};

const servers: DevServer[] = [];
async function startServer(): Promise<{ wsUrl: string }> {
  const project = loadProject({ schema: appSchema, modules: appModules }, [
    defineAuth({ mfa: { encryptionKey: testEncryptionKey() } }),
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

describe("auth A4 MFA/TOTP — E2E through the real dev server", () => {
  it("(1) enroll → confirm → gate → complete with a live TOTP code → working session", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const email = "totp@user.test";
      const signUp = (await c.mutation(api.auth.signUp, { email, password: "pw", deviceLabel: "Chrome" })) as unknown as MintResult;
      c.setAuth(signUp.token);

      // Two-phase enrollment: start returns the raw secret ONCE.
      const enroll = (await c.mutation(api.auth.startMfaEnrollment, {})) as unknown as {
        secret: string; otpauthUri: string; digits: number; period: number; algorithm: string;
      };
      expect(enroll.secret.length).toBeGreaterThan(0);
      expect(enroll.otpauthUri).toMatch(/^otpauth:\/\/totp\//);

      const confirm = (await c.mutation(api.auth.confirmMfaEnrollment, { code: liveTotpCode(enroll.secret) })) as unknown as {
        recoveryCodes: string[];
      };
      expect(confirm.recoveryCodes.length).toBe(10); // default recoveryCodeCount

      // Sign out, then sign back in — the account is now CONFIRMED-enrolled, so first-factor
      // success must be GATED: no token, `mfaRequired: true`.
      await c.mutation(api.auth.signOut, { token: signUp.token });
      const gated = (await c.mutation(api.auth.signIn, { email, password: "pw", deviceLabel: "Chrome" })) as unknown as MfaRequired;
      expect(gated.mfaRequired).toBe(true);
      expect(gated.pendingToken).toBeTruthy();
      expect((gated as unknown as { token?: string }).token).toBeUndefined(); // no session minted yet

      // A live subscription opened BEFORE completing the second factor — proves the session it
      // reactively picks up is the one `completeMfaSignIn` mints, not a pre-existing one.
      const seen: Array<string | null> = [];
      c.subscribe(api.whoami.get, {}, (v2) => seen.push(v2 as string | null));
      await waitFor(() => seen.length >= 1, 5000, "initial (unauthed)");
      expect(seen.at(-1)).toBeNull();

      // The replay guard (decision 9) rejects a second use of the SAME step `confirmMfaEnrollment`
      // already consumed — wait for the step to genuinely advance before deriving the completion
      // code, exactly as a real user would (they'd glance back at their app a few seconds later).
      await waitForNextTotpStep();
      const session = (await c.mutation(api.auth.completeMfaSignIn, {
        pendingToken: gated.pendingToken,
        code: liveTotpCode(enroll.secret),
      })) as unknown as MintResult;
      expect(typeof session.token).toBe("string");
      expect(session.userId).toBe(signUp.userId);
      c.setAuth(session.token);

      await waitFor(() => seen.at(-1) === session.userId, 5000, "reactive post-mfa sign-in");
      expect(seen.at(-1)).toBe(session.userId);
    } finally {
      c.close();
    }
  }, 40_000);

  it("(2) sign-in gate completes with a RECOVERY code instead of a TOTP code (consumed once)", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const email = "recovery@user.test";
      const signUp = (await c.mutation(api.auth.signUp, { email, password: "pw" })) as unknown as MintResult;
      c.setAuth(signUp.token);

      const enroll = (await c.mutation(api.auth.startMfaEnrollment, {})) as unknown as { secret: string };
      const confirm = (await c.mutation(api.auth.confirmMfaEnrollment, { code: liveTotpCode(enroll.secret) })) as unknown as {
        recoveryCodes: string[];
      };
      const recoveryCode = confirm.recoveryCodes[0]!;

      const statusBefore = (await c.query(api.auth.getMfaStatus, {})) as unknown as {
        enrolled: boolean; confirmed: boolean; recoveryCodesRemaining: number;
      };
      expect(statusBefore.confirmed).toBe(true);
      expect(statusBefore.recoveryCodesRemaining).toBe(10);

      await c.mutation(api.auth.signOut, { token: signUp.token });
      const gated = (await c.mutation(api.auth.signIn, { email, password: "pw" })) as unknown as MfaRequired;
      expect(gated.mfaRequired).toBe(true);

      const session = (await c.mutation(api.auth.completeMfaSignIn, {
        pendingToken: gated.pendingToken,
        code: recoveryCode,
      })) as unknown as MintResult;
      expect(typeof session.token).toBe("string");
      expect(session.userId).toBe(signUp.userId);
      c.setAuth(session.token);

      // The consumed recovery code is now gone from the pool.
      const statusAfter = (await c.query(api.auth.getMfaStatus, {})) as unknown as { recoveryCodesRemaining: number };
      expect(statusAfter.recoveryCodesRemaining).toBe(9);

      // The SAME recovery code cannot complete a second sign-in gate (consume-once).
      await c.mutation(api.auth.signOut, { token: session.token });
      const gatedAgain = (await c.mutation(api.auth.signIn, { email, password: "pw" })) as unknown as MfaRequired;
      await expect(
        c.mutation(api.auth.completeMfaSignIn, { pendingToken: gatedAgain.pendingToken, code: recoveryCode }),
      ).rejects.toThrow();
    } finally {
      c.close();
    }
  });

  it("(3) disableMfa un-gates the account — a subsequent sign-in mints directly", async () => {
    const { wsUrl } = await startServer();
    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      const email = "disable@user.test";
      const signUp = (await c.mutation(api.auth.signUp, { email, password: "pw" })) as unknown as MintResult;
      c.setAuth(signUp.token);

      const enroll = (await c.mutation(api.auth.startMfaEnrollment, {})) as unknown as { secret: string };
      const confirm = (await c.mutation(api.auth.confirmMfaEnrollment, { code: liveTotpCode(enroll.secret) })) as unknown as {
        recoveryCodes: string[];
      };
      // Use two DISTINCT recovery codes for the two second-factor checks below (the TOTP replay
      // guard would otherwise force a real 30s wait between them; `disableMfa` explicitly accepts
      // either factor — decision 11 — so this is a legitimate, not a weakened, path).
      const recoveryForGate = confirm.recoveryCodes[0]!;
      const recoveryForDisable = confirm.recoveryCodes[1]!;

      // Confirm the gate is live before disabling.
      await c.mutation(api.auth.signOut, { token: signUp.token });
      const gated = (await c.mutation(api.auth.signIn, { email, password: "pw" })) as unknown as MfaRequired;
      expect(gated.mfaRequired).toBe(true);
      const session = (await c.mutation(api.auth.completeMfaSignIn, {
        pendingToken: gated.pendingToken,
        code: recoveryForGate,
      })) as unknown as MintResult;
      c.setAuth(session.token);

      // disableMfa requires a fresh valid second factor (decision 11) — a recovery code qualifies.
      await c.mutation(api.auth.disableMfa, { code: recoveryForDisable });
      const statusAfter = (await c.query(api.auth.getMfaStatus, {})) as unknown as { enrolled: boolean };
      expect(statusAfter.enrolled).toBe(false);

      // Sign out and sign back in: with no confirmed enrollment left, `finishSignIn` passes
      // straight through to `mintSession` — a normal MintResult, no `mfaRequired` step.
      await c.mutation(api.auth.signOut, { token: session.token });
      const direct = (await c.mutation(api.auth.signIn, { email, password: "pw" })) as unknown as MintResult;
      expect(typeof direct.token).toBe("string");
      expect(direct.userId).toBe(signUp.userId);
      expect((direct as unknown as { mfaRequired?: boolean }).mfaRequired).toBeUndefined();
    } finally {
      c.close();
    }
  });
});
