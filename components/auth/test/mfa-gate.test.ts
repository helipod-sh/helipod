import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { action, type ActionCtx } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, googleProvider, sha256base64url } from "../src";
import type { MintResult, MfaRequired, EmailMessage, EmailProvider } from "../src";
import { totpCodeAt, currentStep } from "../src/mfa/totp";

const __dirname = dirname(fileURLToPath(import.meta.url));

// A 32-byte key encoded as base64 — same shape as mfa-config.test.ts/mfa-enrollment.test.ts's key.
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
const OAUTH = { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] };

/** A capture provider (same idiom as email-redeem.test.ts): records every send, never delivers. */
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}
function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

/**
 * `_resolveExternalIdentity` / `_consumeHandoff` are `_`-prefixed component-internal mutations, only
 * reachable in production via trusted server re-entrancy (an action's `ctx.runMutation` —
 * `signInWithIdToken`/`completeOAuthSignIn`). Same test-only forwarding shim as
 * `external-resolve.test.ts` uses: it does nothing but forward straight through `ctx.runMutation`, so
 * the test still drives the REAL registered mutation, not a reimplemented copy.
 */
const testModules = {
  testHelpers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveExternal: action(async (ctx: unknown, args: any) => {
      return (ctx as ActionCtx).runMutation("auth:_resolveExternalIdentity", args);
    }),
  },
};

let t: TestStackbase;

async function setup(nowRef: { value: number }): Promise<{ sent: EmailMessage[] }> {
  const { sent, provider } = captureProvider();
  t = await createTestStackbase({
    modules: testModules,
    components: [
      defineAuth({
        email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" },
        oauth: OAUTH,
        mfa: { encryptionKey: TEST_KEY },
      }),
    ],
    schema: false,
    now: () => nowRef.value,
  });
  return { sent };
}

interface StartResult {
  secret: string;
  otpauthUri: string;
  digits: number;
  period: number;
  algorithm: string;
}
interface ConfirmResult {
  recoveryCodes: string[];
}

/** Enroll + confirm MFA for an authenticated user (via their session token). Returns the raw secret
 *  (for deriving live codes) and the raw recovery codes (for the recovery-code sign-in tests). */
async function enrollMfa(token: string, now: number): Promise<{ secret: string; recoveryCodes: string[] }> {
  const asUser = t.withIdentity(token);
  const start = await asUser.mutation<StartResult>("auth:startMfaEnrollment", {});
  const confirm = await asUser.mutation<ConfirmResult>("auth:confirmMfaEnrollment", {
    code: totpCodeAt(start.secret, currentStep(now)),
  });
  return { secret: start.secret, recoveryCodes: confirm.recoveryCodes };
}

function liveCodeFor(secret: string, now: number): string {
  return totpCodeAt(secret, currentStep(now));
}

/** Privileged full-table scan (the `by_creation` default index every table gets — same idiom as
 *  `@stackbase/test`'s own `scanSchedulerJobs`), filtered in JS by `userId`. Used to assert on the
 *  pending `mfaChallenges` row without a public read path (there isn't one — the challenge is
 *  invisible to everyone but `completeMfaSignIn`, by design). */
async function challengesFor(userId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await t.run(async (ctx: any) => ctx.db.query("auth/mfaChallenges", "by_creation").collect());
  return (rows as Array<Record<string, unknown>>).filter((r) => r.userId === userId);
}
async function recoveryCodeCount(userId: string): Promise<number> {
  const rows = await t.run(async (ctx: any) => ctx.db.query("auth/mfaRecoveryCodes", "byUserId").eq("userId", userId).collect());
  return rows.length;
}

describe("A4 Task 5: the gate — finishSignIn / completeMfaSignIn", () => {
  const NOW = 1_700_000_000_000;

  afterEach(async () => {
    await t.close();
  });

  it("a NON-enrolled user's signIn mints a normal MintResult — no mfaRequired key at all", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    await t.mutation("auth:signUp", { email: "plain@x.co", password: "pw" });
    const result = await t.mutation<MintResult>("auth:signIn", { email: "plain@x.co", password: "pw" });
    expect(typeof result.token).toBe("string");
    expect(typeof result.refreshToken).toBe("string");
    expect("mfaRequired" in result).toBe(false);
  });

  it("signIn: an enrolled+CONFIRMED user gets { mfaRequired: true, pendingToken, expiresAt } — NO token; completeMfaSignIn with the live TOTP then mints a working session", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "gate@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    const gated = await t.mutation<MfaRequired>("auth:signIn", { email: "gate@x.co", password: "pw" });
    expect(gated.mfaRequired).toBe(true);
    expect(typeof gated.pendingToken).toBe("string");
    expect(typeof gated.expiresAt).toBe("number");
    expect("token" in gated).toBe(false);

    // A hashed, single-use challenge row exists for this user — never the raw pendingToken.
    const rows = await challengesFor(up.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.challengeHash).toBe(sha256base64url(gated.pendingToken));
    expect(rows[0]!.challengeHash).not.toBe(gated.pendingToken);

    // Advance one full TOTP period past enrollment's already-consumed step (replay guard).
    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(typeof minted.token).toBe("string");
    expect(minted.userId).toBe(up.userId);
    expect(await t.query("auth:getUserId", { token: minted.token })).toBe(up.userId);

    // The challenge is consumed — gone after a successful complete.
    expect(await challengesFor(up.userId)).toHaveLength(0);
  });

  it("completeMfaSignIn also accepts a RECOVERY code, and consumes it (single-use)", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "recovery@x.co", password: "pw" });
    const { recoveryCodes } = await enrollMfa(up.token, nowRef.value);
    const usedCode = recoveryCodes[0]!;
    expect(await recoveryCodeCount(up.userId)).toBe(10);

    const gated = await t.mutation<MfaRequired>("auth:signIn", { email: "recovery@x.co", password: "pw" });
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", { pendingToken: gated.pendingToken, code: usedCode });
    expect(typeof minted.token).toBe("string");
    expect(await recoveryCodeCount(up.userId)).toBe(9); // consumed

    // The same recovery code cannot be reused on a fresh challenge.
    const gated2 = await t.mutation<MfaRequired>("auth:signIn", { email: "recovery@x.co", password: "pw" });
    await expect(
      t.mutation("auth:completeMfaSignIn", { pendingToken: gated2.pendingToken, code: usedCode }),
    ).rejects.toThrow(/invalid code/i);
  });

  it("wrong code rejects generically; mfaAttempts (default 5) wrong guesses deletes the challenge — the pending window is destroyed, even the correct code fails afterward", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "bruteforce@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);
    nowRef.value += 30_000; // fresh TOTP step past enrollment's consumed one

    const gated = await t.mutation<MfaRequired>("auth:signIn", { email: "bruteforce@x.co", password: "pw" });
    const realCode = liveCodeFor(secret, nowRef.value);

    for (let i = 0; i < 4; i++) {
      await expect(
        t.mutation("auth:completeMfaSignIn", { pendingToken: gated.pendingToken, code: "000000" }),
      ).rejects.toThrow(/invalid code/i);
      const rows = await challengesFor(up.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.failedAttempts).toBe(i + 1);
    }
    // 5th wrong guess reaches the cap → the challenge is DELETED (rate limit / lockout).
    await expect(
      t.mutation("auth:completeMfaSignIn", { pendingToken: gated.pendingToken, code: "000000" }),
    ).rejects.toThrow(/invalid code/i);
    expect(await challengesFor(up.userId)).toHaveLength(0);

    // The PREVIOUSLY-CORRECT code now ALSO fails — the pending window is gone, not merely the guess.
    await expect(
      t.mutation("auth:completeMfaSignIn", { pendingToken: gated.pendingToken, code: realCode }),
    ).rejects.toThrow(/invalid code/i);
  });

  it("an expired challenge is generic-invalid WITHOUT ever validating the code — a recovery code presented against it is NOT consumed", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "expiry@x.co", password: "pw" });
    const { recoveryCodes } = await enrollMfa(up.token, nowRef.value);
    const gated = await t.mutation<MfaRequired>("auth:signIn", { email: "expiry@x.co", password: "pw" });
    expect(await recoveryCodeCount(up.userId)).toBe(10);

    nowRef.value += 5 * 60 * 1000 + 1; // past the 5-minute default challengeTtlMs
    await expect(
      t.mutation("auth:completeMfaSignIn", { pendingToken: gated.pendingToken, code: recoveryCodes[0]! }),
    ).rejects.toThrow(/invalid code/i);

    // The recovery code was NEVER consumed — proving the expiry check runs BEFORE
    // `verifyUserSecondFactor`, not merely that the overall call failed.
    expect(await recoveryCodeCount(up.userId)).toBe(10);
  });

  it("a missing/garbage pendingToken is generic-invalid (no challenge row, nothing to consume)", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    await expect(
      t.mutation("auth:completeMfaSignIn", { pendingToken: "not-a-real-token", code: "123456" }),
    ).rejects.toThrow(/invalid code/i);
  });

  it("verifyEmail: an enrolled+confirmed user gets mfaRequired on the first-mailbox-proof mint too (the MFA row survives the credential-boundary session wipe)", async () => {
    const nowRef = { value: NOW };
    const { sent } = await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "verify-gate@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    await t.mutation("auth:requestEmailVerification", { email: "verify-gate@x.co" });
    const token = extractToken(sent[sent.length - 1]!.text);
    const gated = await t.mutation<MfaRequired>("auth:verifyEmail", { email: "verify-gate@x.co", code: token });
    expect(gated.mfaRequired).toBe(true);
    expect("token" in gated).toBe(false);

    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(minted.userId).toBe(up.userId);
  });

  it("signInWithMagicLink (adoptOrCreateThenMint's existing-user branch): an enrolled user gets mfaRequired instead of a direct mint", async () => {
    const nowRef = { value: NOW };
    const { sent } = await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "magic-gate@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    await t.mutation("auth:requestMagicLink", { email: "magic-gate@x.co" });
    const token = extractToken(sent[sent.length - 1]!.text);
    const gated = await t.mutation<MfaRequired>("auth:signInWithMagicLink", { email: "magic-gate@x.co", token });
    expect(gated.mfaRequired).toBe(true);

    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(minted.userId).toBe(up.userId);
  });

  it("resetPassword: reset-still-challenges (decision 12) — an enrolled user still gets mfaRequired after a successful password reset, not a direct mint", async () => {
    const nowRef = { value: NOW };
    const { sent } = await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "reset-gate@x.co", password: "old-pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    await t.mutation("auth:requestPasswordReset", { email: "reset-gate@x.co" });
    const token = extractToken(sent[sent.length - 1]!.text);
    const gated = await t.mutation<MfaRequired>("auth:resetPassword", { email: "reset-gate@x.co", code: token, newPassword: "new-pw" });
    expect(gated.mfaRequired).toBe(true);
    expect("token" in gated).toBe(false);

    // The new password IS live (the reset itself committed) — just no session yet without the 2nd factor.
    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(minted.userId).toBe(up.userId);
  });

  it("external identity (_resolveExternalIdentity outcome:\"mint\"): linking a verified Google identity to an enrolled user's account gets mfaRequired, not a direct mint", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "oauth-gate@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    // A first-sight external identity for a BRAND NEW user is unaffected (no enrollment exists yet).
    const fresh = await t.action<MintResult>("testHelpers:resolveExternal", {
      provider: "google", accountId: "fresh-sub", emailVerified: true, email: "unrelated@x.co", outcome: "mint",
    });
    expect(typeof fresh.token).toBe("string");

    // A VERIFIED Google identity matching the enrolled user's email links + first-proofs — and now
    // gates, exactly like every other first-factor mint site.
    const gated = await t.action<MfaRequired>("testHelpers:resolveExternal", {
      provider: "google", accountId: "gsub-1", emailVerified: true, email: "oauth-gate@x.co", outcome: "mint",
    });
    expect(gated.mfaRequired).toBe(true);
    expect("token" in gated).toBe(false);

    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(minted.userId).toBe(up.userId);
  });

  it("_consumeHandoff (completeOAuthSignIn): an enrolled user's handoff redemption gets mfaRequired, not a direct mint", async () => {
    const nowRef = { value: NOW };
    await setup(nowRef);
    const up = await t.mutation<MintResult>("auth:signUp", { email: "handoff-gate@x.co", password: "pw" });
    const { secret } = await enrollMfa(up.token, nowRef.value);

    // Seed a real oauthHandoff row directly (privileged write) — bypassing the full OAuth
    // authorize/exchange dance, which `oauth-callback.test.ts` already covers end to end; this test's
    // job is only to pin THIS task's change (the mint arm now routes through `finishSignIn`).
    const handoffCode = "test-handoff-raw-code";
    await t.run(async (ctx: any) => {
      await ctx.db.insert("auth/oauthHandoff", {
        handoffHash: sha256base64url(handoffCode),
        userId: up.userId,
        expiresAt: ctx.now() + 60_000,
        createdAt: ctx.now(),
      });
    });

    const gated = await t.action<MfaRequired>("auth:completeOAuthSignIn", { handoffCode });
    expect(gated.mfaRequired).toBe(true);
    expect("token" in gated).toBe(false);

    nowRef.value += 30_000;
    const minted = await t.mutation<MintResult>("auth:completeMfaSignIn", {
      pendingToken: gated.pendingToken,
      code: liveCodeFor(secret, nowRef.value),
    });
    expect(minted.userId).toBe(up.userId);
  });

  it("no `mfa` config at all ⇒ finishSignIn is a pure passthrough — every gated site mints directly, byte-identical to a pre-MFA deployment", async () => {
    const nowRef = { value: NOW };
    const { sent, provider } = captureProvider();
    t = await createTestStackbase({
      modules: {},
      components: [defineAuth({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } })],
      schema: false,
      now: () => nowRef.value,
    });

    const signUpResult = await t.mutation<MintResult>("auth:signUp", { email: "nomfa@x.co", password: "pw" });
    expect(typeof signUpResult.token).toBe("string");
    expect("mfaRequired" in signUpResult).toBe(false);

    const signInResult = await t.mutation<MintResult>("auth:signIn", { email: "nomfa@x.co", password: "pw" });
    expect(Object.keys(signInResult).sort()).toEqual(["expiresAt", "refreshToken", "sessionId", "token", "userId"]);

    await t.mutation("auth:requestPasswordReset", { email: "nomfa@x.co" });
    const token = extractToken(sent[sent.length - 1]!.text);
    const resetResult = await t.mutation<MintResult>("auth:resetPassword", { email: "nomfa@x.co", code: token, newPassword: "new-pw" });
    expect(typeof resetResult.token).toBe("string");

    // The A4 surface itself is fully unregistered — calling it 404s/throws (not silently a no-op).
    await expect(t.mutation("auth:startMfaEnrollment", {})).rejects.toThrow();
  });
});

// ─────────────────────── THE INVARIANT: static source guard ───────────────────────
// A code review need only confirm (per the design spec's own "Security / correctness" section) that
// (a) no gated first-factor handler calls `mintSession` directly anymore — all route through
// `finishSignIn` — and (b) `completeMfaSignIn` is the ONE new direct `mintSession` caller. This
// mechanically re-checks that invariant against the actual shipped source, so a future edit that
// re-introduces a direct `mintSession(` call at a gated site fails CI instead of silently reopening
// an MFA bypass.
describe("A4 Task 5 — the gate invariant (static source guard)", () => {
  const functionsSrc = readFileSync(join(__dirname, "../src/functions.ts"), "utf8");
  const externalSrc = readFileSync(join(__dirname, "../src/external.ts"), "utf8");
  const mfaFunctionsSrc = readFileSync(join(__dirname, "../src/mfa/functions.ts"), "utf8");

  // Every `mintSession(` occurrence that is NOT the function's own declaration (`function mintSession(`).
  function directCallCount(src: string): number {
    return (src.match(/(?<!function )\bmintSession\(/g) ?? []).length;
  }
  function finishSignInCallCount(src: string): number {
    return (src.match(/(?<!function )\bfinishSignIn\(/g) ?? []).length;
  }

  it("external.ts: zero direct mintSession( calls — both external mint sites (_resolveExternalIdentity outcome:\"mint\" and _consumeHandoff) route through finishSignIn", () => {
    expect(directCallCount(externalSrc)).toBe(0);
    expect(finishSignInCallCount(externalSrc)).toBe(2);
  });

  it("functions.ts: the ONLY direct mintSession( callers left are finishSignIn's own two passthrough arms and signInAnonymously (never gated, by design) — every gated first-factor site (signUp, signIn, verifyEmail, resetPassword, and adoptOrCreateThenMint's two branches backing signInWithMagicLink/signInWithOtp) calls finishSignIn", () => {
    expect(directCallCount(functionsSrc)).toBe(3); // 2 inside finishSignIn + 1 inside signInAnonymously
    expect(finishSignInCallCount(functionsSrc)).toBe(6); // signUp, signIn, verifyEmail, resetPassword, adoptOrCreateThenMint x2
  });

  it("mfa/functions.ts: completeMfaSignIn is the ONLY new direct mintSession( caller in the whole component", () => {
    expect(directCallCount(mfaFunctionsSrc)).toBe(1);
  });
});
