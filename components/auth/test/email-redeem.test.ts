import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema } from "@helipod/values";
import { query, mutation, type QueryCtx, type MutationCtx } from "@helipod/executor";
import { defineAuth } from "../src/component";
import { sha256base64url, type AuthOptions, type EmailMessage, type EmailProvider, type MintResult } from "../src";

/** A capture provider (per the Task 2 brief, reused here): records every send, never delivers
 *  anything. Tests extract the raw code/token from `sent[i].text` — exactly what a real user would
 *  read out of their inbox. */
function captureProvider(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { async send(m) { sent.push(m); } } };
}

function extractOtp(text: string): string {
  const m = text.match(/code is:\n\n(\d{8})\n/);
  if (!m) throw new Error(`no OTP found in email text: ${text}`);
  return m[1]!;
}
function extractToken(text: string): string {
  const m = text.match(/token=([^&\s]+)/);
  if (!m) throw new Error(`no token found in email text: ${text}`);
  return m[1]!;
}

// Privileged test-only reads, same idiom as email-issue.test.ts's `_readAuthCode` (raw physical
// table name, registered as a `systemModules` entry — trusted-caller-only, no `isInternalPath` gate).
const _readAuthCode = query(async (ctx: QueryCtx, { email, flow }: { email: string; flow: string }) => {
  const [row] = await ctx.db.query("auth/authCodes", "byEmailFlow").eq("email", email).eq("flow", flow).collect();
  return row ?? null;
});
const _readUser = query(async (ctx: QueryCtx, { email }: { email: string }) => {
  const [row] = await ctx.db.query("auth/users", "byEmail").eq("email", email).collect();
  return row ?? null;
});
const _readAccountsByEmail = query(async (ctx: QueryCtx, { email }: { email: string }) => {
  return ctx.db.query("auth/accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
});

// Test-only privileged WRITE (same raw-physical-table idiom as the reads above): directly seeds a
// real, redeemable `authCodes` row for (email, flow), bypassing `_issueCode`/`shouldIssue` entirely.
// Used by the resetPassword regression pin below: fix #2 (shouldIssue now gates reset issuance on a
// PASSWORD account, not just a `users` row) means the request/issue path can no longer produce a
// redeemable reset code against a passwordless account — so the only way left to exercise
// resetPassword's own redeem-side handling of that exact row shape (fix #1) is to seed it directly.
// This pins fix #1 independent of fix #2 ever holding (a future shouldIssue regression, a race, etc.)
const _writeRawAuthCode = mutation(async (
  ctx: MutationCtx,
  { email, flow, code, ttlMs }: { email: string; flow: string; code: string; ttlMs: number },
) => {
  const now = ctx.now();
  await ctx.db.insert("auth/authCodes", { email, flow, codeHash: sha256base64url(code), expiresAt: now + ttlMs, attempts: 0, createdAt: now });
  return null;
});

async function makeRuntime(authOpts: AuthOptions, now: () => number) {
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [defineAuth(authOpts)],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    systemModules: {
      "_test:readAuthCode": _readAuthCode,
      "_test:readUser": _readUser,
      "_test:readAccountsByEmail": _readAccountsByEmail,
      "_test:writeRawAuthCode": _writeRawAuthCode,
    },
    now,
  });
}

async function readAuthCode(r: EmbeddedRuntime, email: string, flow: string): Promise<Record<string, unknown> | null> {
  return (await r.runSystem<Record<string, unknown> | null>("_test:readAuthCode", { email, flow })).value;
}
async function readUser(r: EmbeddedRuntime, email: string): Promise<Record<string, unknown> | null> {
  return (await r.runSystem<Record<string, unknown> | null>("_test:readUser", { email })).value;
}
async function readAccountsByEmail(r: EmbeddedRuntime, email: string): Promise<Record<string, unknown>[]> {
  return (await r.runSystem<Record<string, unknown>[]>("_test:readAccountsByEmail", { email })).value;
}

async function issueOtp(r: EmbeddedRuntime, sent: EmailMessage[], email: string): Promise<string> {
  await r.run("auth:requestOtp", { email });
  return extractOtp(sent[sent.length - 1]!.text);
}
async function issueLink(r: EmbeddedRuntime, sent: EmailMessage[], email: string, flow: "verify" | "reset" | "magic"): Promise<string> {
  const action = flow === "verify" ? "auth:requestEmailVerification" : flow === "reset" ? "auth:requestPasswordReset" : "auth:requestMagicLink";
  await r.run(action, { email });
  return extractToken(sent[sent.length - 1]!.text);
}

describe("auth A2: redeem mutations (verifyEmail / signInWithOtp / signInWithMagicLink / resetPassword)", () => {
  it("verifyEmail mints and sets users.emailVerified true", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "a@b.co", password: "pw" });
    expect((await readUser(r, "a@b.co"))!.emailVerified).not.toBe(true);

    const token = await issueLink(r, sent, "a@b.co", "verify");
    const result = (await r.run<MintResult>("auth:verifyEmail", { email: "a@b.co", code: token })).value;
    expect(typeof result.token).toBe("string");
    expect(await readUser(r, "a@b.co")).toMatchObject({ emailVerified: true });
  });

  it("single-use / replay: a consumed code fails on a second redeem with the generic invalid-code error", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const token = await issueLink(r, sent, "unknown@x.co", "magic");

    await r.run("auth:signInWithMagicLink", { email: "unknown@x.co", token });
    await expect(r.run("auth:signInWithMagicLink", { email: "unknown@x.co", token })).rejects.toThrow(/invalid code/);
  });

  it("concurrent redeem of the same code → exactly one winner (single-writer OCC)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const token = await issueLink(r, sent, "race@x.co", "magic");

    const results = await Promise.allSettled([
      r.run("auth:signInWithMagicLink", { email: "race@x.co", token }),
      r.run("auth:signInWithMagicLink", { email: "race@x.co", token }),
    ]);
    const fulfilled = results.filter((res) => res.status === "fulfilled");
    const rejected = results.filter((res) => res.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/invalid code/);
  });

  it("expiry: a redeem past the code's TTL is generic invalid; the row is left in place, not deleted (final-review fix — token-flow non-match no longer consumes the row; an already-expired row is harmless left in place, and overwritten by the next issuance)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const token = await issueLink(r, sent, "exp@x.co", "magic");

    nowMs += 60 * 60 * 1000 + 1; // past the 1h default magicLinkTtlMs
    await expect(r.run("auth:signInWithMagicLink", { email: "exp@x.co", token })).rejects.toThrow(/invalid code/);
    // Post-fix: the non-match path never deletes a token-flow row. The row survives, still expired
    // (so still unredeemable — see the next assertion), until TTL/overwrite naturally retires it.
    expect(await readAuthCode(r, "exp@x.co", "magic")).not.toBeNull();
    // The same (already-expired) token still fails identically on a second try — no functional
    // regression, just no eager cleanup.
    await expect(r.run("auth:signInWithMagicLink", { email: "exp@x.co", token })).rejects.toThrow(/invalid code/);
  });

  it("OTP brute force: otpAttempts wrong guesses deletes the row; attempts survives each failed call (commit-then-throw); the (previously correct) code then also fails (attribution: better-auth email-otp.test.ts; theirs 3, ours 5)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "brute@x.co", password: "pw" });
    const realCode = await issueOtp(r, sent, "brute@x.co");

    // 5 wrong guesses (default otpAttempts). After each of the first 4, `attempts` survives the
    // failed call (commit-then-throw durability) — privileged-read the row between guesses.
    for (let i = 0; i < 4; i++) {
      await expect(r.run("auth:signInWithOtp", { email: "brute@x.co", code: "00000000" })).rejects.toThrow(/invalid code/);
      const row = await readAuthCode(r, "brute@x.co", "otp");
      expect(row).not.toBeNull();
      expect(row!.attempts).toBe(i + 1);
    }
    // 5th wrong guess reaches the cap → the row is DELETED (lockout, re-request required).
    await expect(r.run("auth:signInWithOtp", { email: "brute@x.co", code: "00000000" })).rejects.toThrow(/invalid code/);
    expect(await readAuthCode(r, "brute@x.co", "otp")).toBeNull();

    // The previously-correct code now ALSO fails (row is gone) — same generic error.
    await expect(r.run("auth:signInWithOtp", { email: "brute@x.co", code: realCode })).rejects.toThrow(/invalid code/);
  });

  it("OTP matching-email requirement / cross-account: a code issued for A cannot redeem as B (attribution: convex-auth otp.test.ts:25)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "userA@x.co", password: "pw" });
    await r.run("auth:signUp", { email: "userB@x.co", password: "pw" });
    const codeA = await issueOtp(r, sent, "userA@x.co");
    const codeB = await issueOtp(r, sent, "userB@x.co");
    expect(codeA).not.toBe(codeB);

    // Presenting A's code under B's email must fail generically — B's row's own hash never matches.
    await expect(r.run("auth:signInWithOtp", { email: "userB@x.co", code: codeA })).rejects.toThrow(/invalid code/);
    // B's own code still works afterward — the cross-account guess didn't consume/corrupt B's row.
    const bResult = (await r.run<MintResult>("auth:signInWithOtp", { email: "userB@x.co", code: codeB })).value;
    expect(typeof bResult.token).toBe("string");
  });

  it("resetPassword: old password dies, new password works, ALL other sessions revoked, fresh session minted; cross-account guard", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const signUpResult = (await r.run<MintResult>("auth:signUp", { email: "reset@x.co", password: "old-pw" })).value;
    const secondSignIn = (await r.run<MintResult>("auth:signIn", { email: "reset@x.co", password: "old-pw" })).value;
    await r.run("auth:signUp", { email: "other@x.co", password: "pw" }); // unrelated account for the cross-account guard

    const resetCode = await issueLink(r, sent, "reset@x.co", "reset");

    // Cross-account guard: A's reset code cannot reset B (decision 9).
    await expect(r.run("auth:resetPassword", { email: "other@x.co", code: resetCode, newPassword: "hijack" })).rejects.toThrow(/invalid code/);

    const fresh = (await r.run<MintResult>("auth:resetPassword", { email: "reset@x.co", code: resetCode, newPassword: "new-pw" })).value;
    expect(typeof fresh.token).toBe("string");

    // Old password is dead; new password works.
    await expect(r.run("auth:signIn", { email: "reset@x.co", password: "old-pw" })).rejects.toThrow(/invalid credentials/);
    const signedInAgain = (await r.run<MintResult>("auth:signIn", { email: "reset@x.co", password: "new-pw" })).value;
    expect(typeof signedInAgain.token).toBe("string");

    // ALL prior sessions revoked (credential boundary) — both the signUp and the extra signIn session.
    expect((await r.run("auth:getUserId", { token: signUpResult.token })).value).toBeNull();
    expect((await r.run("auth:getUserId", { token: secondSignIn.token })).value).toBeNull();
    // The reset-minted session is alive.
    expect((await r.run("auth:getUserId", { token: fresh.token })).value).toBe(fresh.userId);
  });

  it("magic/otp create-on-first-use: unknown email (default flags) creates a user with emailVerified true; createUsersOnEmailSignIn:false → generic invalid, no user created", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const rDefault = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const token = await issueLink(rDefault, sent, "brandnew@x.co", "magic");
    const result = (await rDefault.run<MintResult>("auth:signInWithMagicLink", { email: "brandnew@x.co", token })).value;
    expect(typeof result.userId).toBe("string");
    expect(await readUser(rDefault, "brandnew@x.co")).toMatchObject({ emailVerified: true });

    const { sent: sent2, provider: provider2 } = captureProvider();
    const rNoCreate = await makeRuntime({ email: { provider: provider2, from: "noreply@app.co", baseUrl: "https://app.example.com", createUsersOnEmailSignIn: false } }, () => nowMs);
    await rNoCreate.run("auth:requestMagicLink", { email: "neverexisted@x.co" }); // { sent: true }, sentinel row only
    expect(sent2.length).toBe(0);
    await expect(rNoCreate.run("auth:signInWithMagicLink", { email: "neverexisted@x.co", token: "whatever-guess" })).rejects.toThrow(/invalid code/);
    expect(await readUser(rNoCreate, "neverexisted@x.co")).toBeNull();
  });

  it("unverified-adoption-clears-password: magic-link sign-in on an unverified password account deletes the accounts row and adopts the SAME userId (attribution: better-auth magic-link.test.ts:268)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    const signUpResult = (await r.run<MintResult>("auth:signUp", { email: "adopt@x.co", password: "pw" })).value;
    expect((await readAccountsByEmail(r, "adopt@x.co")).length).toBe(1);

    const token = await issueLink(r, sent, "adopt@x.co", "magic");
    const adopted = (await r.run<MintResult>("auth:signInWithMagicLink", { email: "adopt@x.co", token })).value;

    expect(adopted.userId).toBe(signUpResult.userId); // same account, not a new user
    expect((await readAccountsByEmail(r, "adopt@x.co")).length).toBe(0); // password credential gone
    await expect(r.run("auth:signIn", { email: "adopt@x.co", password: "pw" })).rejects.toThrow(/invalid credentials/);
  });

  it("first-proof revokes the parked session: an attacker's pre-registered session on an unverified account dies the moment the victim proves mailbox control (via magic link) — attribution: better-auth revokeUnprovenAccountAccess", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    const attackerSession = (await r.run<MintResult>("auth:signUp", { email: "victim@x.co", password: "attacker-chosen-pw" })).value;
    expect((await r.run("auth:getUserId", { token: attackerSession.token })).value).toBe(attackerSession.userId);

    const token = await issueLink(r, sent, "victim@x.co", "magic");
    const victimSession = (await r.run<MintResult>("auth:signInWithMagicLink", { email: "victim@x.co", token })).value;

    expect((await r.run("auth:getUserId", { token: attackerSession.token })).value).toBeNull(); // parked session dead
    expect((await r.run("auth:getUserId", { token: victimSession.token })).value).toBe(victimSession.userId); // victim's fresh mint works
  });

  it("first-proof revokes the parked session — via verifyEmail", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    const attackerSession = (await r.run<MintResult>("auth:signUp", { email: "victim2@x.co", password: "attacker-chosen-pw" })).value;
    const token = await issueLink(r, sent, "victim2@x.co", "verify");
    const victimSession = (await r.run<MintResult>("auth:verifyEmail", { email: "victim2@x.co", code: token })).value;

    expect((await r.run("auth:getUserId", { token: attackerSession.token })).value).toBeNull();
    expect((await r.run("auth:getUserId", { token: victimSession.token })).value).toBe(victimSession.userId);
  });

  it("first-proof revokes the parked session — via signInWithOtp", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    const attackerSession = (await r.run<MintResult>("auth:signUp", { email: "victim3@x.co", password: "attacker-chosen-pw" })).value;
    const code = await issueOtp(r, sent, "victim3@x.co");
    const victimSession = (await r.run<MintResult>("auth:signInWithOtp", { email: "victim3@x.co", code })).value;

    expect((await r.run("auth:getUserId", { token: attackerSession.token })).value).toBeNull();
    expect((await r.run("auth:getUserId", { token: victimSession.token })).value).toBe(victimSession.userId);
  });

  it("benign inverse — already-verified multi-device sign-in survives: a second-device magic-link sign-in does NOT wipe the first device's session", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    // First device: unknown-email magic-link sign-in creates an ALREADY-verified user.
    const tokenD1 = await issueLink(r, sent, "multi@x.co", "magic");
    const device1 = (await r.run<MintResult>("auth:signInWithMagicLink", { email: "multi@x.co", token: tokenD1 })).value;
    expect(await readUser(r, "multi@x.co")).toMatchObject({ emailVerified: true });

    // Second device: another magic-link sign-in for the SAME (already-verified) user.
    const tokenD2 = await issueLink(r, sent, "multi@x.co", "magic");
    const device2 = (await r.run<MintResult>("auth:signInWithMagicLink", { email: "multi@x.co", token: tokenD2 })).value;

    // Device 1's session STILL resolves — no wipe on an already-true emailVerified flip.
    expect((await r.run("auth:getUserId", { token: device1.token })).value).toBe(device1.userId);
    expect((await r.run("auth:getUserId", { token: device2.token })).value).toBe(device2.userId);
  });

  it("sentinel row cannot be redeemed: an unknown-email cooldown row (codeHash: \"\") never validates, for any flow or presented value", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    // reset/verify: no account ever exists for these emails → _issueCode writes a sentinel row
    // (codeHash: "") regardless of createUsersOnEmailSignIn (that flag only affects magic/otp).
    await r.run("auth:requestPasswordReset", { email: "ghost-reset@x.co" });
    await r.run("auth:requestEmailVerification", { email: "ghost-verify@x.co" });
    expect(await readAuthCode(r, "ghost-reset@x.co", "reset")).toMatchObject({ codeHash: "" });
    expect(await readAuthCode(r, "ghost-verify@x.co", "verify")).toMatchObject({ codeHash: "" });

    for (const candidate of ["", "a-plausible-looking-32-char-token-guess", "00000000"]) {
      await expect(r.run("auth:resetPassword", { email: "ghost-reset@x.co", code: candidate, newPassword: "pw" })).rejects.toThrow(/invalid code/);
      await expect(r.run("auth:verifyEmail", { email: "ghost-verify@x.co", code: candidate })).rejects.toThrow(/invalid code/);
    }
    // The sentinel row's mere presence never signals account existence: no user was ever created.
    expect(await readUser(r, "ghost-reset@x.co")).toBeNull();
    expect(await readUser(r, "ghost-verify@x.co")).toBeNull();

    // magic/otp: force the sentinel path for an unknown email via createUsersOnEmailSignIn:false.
    const { sent: sent2, provider: provider2 } = captureProvider();
    const rNoCreate = await makeRuntime({ email: { provider: provider2, from: "noreply@app.co", baseUrl: "https://app.example.com", createUsersOnEmailSignIn: false } }, () => nowMs);
    await rNoCreate.run("auth:requestMagicLink", { email: "ghost-magic@x.co" });
    await rNoCreate.run("auth:requestOtp", { email: "ghost-otp@x.co" });
    expect(await readAuthCode(rNoCreate, "ghost-magic@x.co", "magic")).toMatchObject({ codeHash: "" });
    expect(await readAuthCode(rNoCreate, "ghost-otp@x.co", "otp")).toMatchObject({ codeHash: "" });
    expect(sent.length + sent2.length).toBeGreaterThanOrEqual(0); // no real send ever required for this test's assertions

    for (const candidate of ["", "a-plausible-looking-32-char-token-guess"]) {
      await expect(rNoCreate.run("auth:signInWithMagicLink", { email: "ghost-magic@x.co", token: candidate })).rejects.toThrow(/invalid code/);
    }
    for (const candidate of ["00000000", ""]) {
      await expect(rNoCreate.run("auth:signInWithOtp", { email: "ghost-otp@x.co", code: candidate })).rejects.toThrow(/invalid code/);
    }
    expect(await readUser(rNoCreate, "ghost-magic@x.co")).toBeNull();
    expect(await readUser(rNoCreate, "ghost-otp@x.co")).toBeNull();
  });

  // REGRESSION PIN — the reproduced Critical. A user who signed up via magic-link/OTP (default
  // createUsersOnEmailSignIn:true) has a `users` row but NO password `accounts` row. Before this
  // fix wave, `shouldIssue` gated reset issuance on `!!user` alone, so such a user COULD get a
  // redeemable reset code; on redeem, resetPassword deleted the winning code row, THEN found no
  // `accounts` row and threw a PLAIN `throw new Error(INVALID)` — which discards ALL of the
  // mutation's staged writes (only a RETURNED `commitThenThrow` survives to commit), silently
  // undoing the delete. The reset code stayed live/replayable until its TTL, breaking the
  // single-use invariant. Fix #2 (see the enumeration-parity test below) now closes the only known
  // path that could ISSUE such a code, so this test seeds the row directly (bypassing
  // `_issueCode`/`shouldIssue` via the privileged `_test:writeRawAuthCode`) to pin resetPassword's
  // own redeem-side fix (#1) independent of that gate ever holding.
  it("REGRESSION PIN: resetPassword against a passwordless (magic-link-created) account fails generically AND consumes the code — the delete must survive the post-delete `!account` throw", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    // Create the user via signInWithMagicLink — no password `accounts` row is ever created.
    const token = await issueLink(r, sent, "passwordless@x.co", "magic");
    await r.run("auth:signInWithMagicLink", { email: "passwordless@x.co", token });
    expect(await readAccountsByEmail(r, "passwordless@x.co")).toEqual([]);
    expect(await readUser(r, "passwordless@x.co")).not.toBeNull();

    // Seed a REAL, redeemable reset code for this passwordless account directly (see the comment
    // on `_writeRawAuthCode` above for why this bypasses the normal request/issue path).
    const rawCode = "regression-pin-raw-reset-code-000";
    await r.runSystem("_test:writeRawAuthCode", { email: "passwordless@x.co", flow: "reset", code: rawCode, ttlMs: 60 * 60 * 1000 });
    expect(await readAuthCode(r, "passwordless@x.co", "reset")).not.toBeNull();

    // Redeem with the CORRECT code: matches → row deleted → `!account` → must commitThenThrow
    // (post-fix), not a plain throw, or the delete would be silently discarded.
    await expect(
      r.run("auth:resetPassword", { email: "passwordless@x.co", code: rawCode, newPassword: "new-pw" }),
    ).rejects.toThrow(/invalid code/);

    // THE pin: the delete SURVIVED the throw — privileged read shows ZERO rows for (email, "reset").
    expect(await readAuthCode(r, "passwordless@x.co", "reset")).toBeNull();

    // Single-use held: a second redeem with the SAME code also fails (nothing left to match against
    // — proving the code is truly consumed, not merely still valid-but-rejected-for-other-reasons).
    await expect(
      r.run("auth:resetPassword", { email: "passwordless@x.co", code: rawCode, newPassword: "new-pw-2" }),
    ).rejects.toThrow(/invalid code/);

    // No password account was ever created by this failed redeem sequence.
    expect(await readAccountsByEmail(r, "passwordless@x.co")).toEqual([]);
  });

  // Fix #2's own behavior test: requestPasswordReset for a passwordless (magic-link-created) user
  // must now be indistinguishable from an unknown email — the enabling condition for the Critical
  // above (shouldIssue gating reset on `!!user` alone) is closed at the SOURCE, not just patched at
  // the redeem site.
  it("fix #2: requestPasswordReset for a passwordless (magic-link-created) user behaves EXACTLY like an unknown email — { sent: true }, zero sends, sentinel row, EMAIL_COOLDOWN parity", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com", requestCooldownMs: 60_000 } }, () => nowMs);

    // A real (magic-link-created) user — NOT unknown — but with no password account.
    const token = await issueLink(r, sent, "nopw@x.co", "magic");
    await r.run("auth:signInWithMagicLink", { email: "nopw@x.co", token });
    expect(await readUser(r, "nopw@x.co")).not.toBeNull();
    expect(await readAccountsByEmail(r, "nopw@x.co")).toEqual([]);
    const sendsBeforeReset = sent.length;

    // requestPasswordReset for this passwordless user: { sent: true } (anti-enum), but no real send.
    const result = (await r.run<{ sent: true }>("auth:requestPasswordReset", { email: "nopw@x.co" })).value;
    expect(result).toEqual({ sent: true });
    expect(sent.length).toBe(sendsBeforeReset); // zero NEW sends from the reset request itself

    // Only a sentinel-shaped cooldown row exists — never a real redeemable code.
    const row = await readAuthCode(r, "nopw@x.co", "reset");
    expect(row).not.toBeNull();
    expect(row!.codeHash).toBe("");

    // Enumeration parity: a 2nd rapid request rejects EMAIL_COOLDOWN identically to a known-with-
    // password or unknown email (same cooldown-row mechanism, decision 6/7).
    await expect(r.run("auth:requestPasswordReset", { email: "nopw@x.co" })).rejects.toThrow(/EMAIL_COOLDOWN/);

    // Cross-check against a genuinely unknown email: byte-for-byte identical shape.
    const { sent: sent2, provider: provider2 } = captureProvider();
    const rUnknown = await makeRuntime({ email: { provider: provider2, from: "noreply@app.co", baseUrl: "https://app.example.com", requestCooldownMs: 60_000 } }, () => nowMs);
    const unknownResult = (await rUnknown.run<{ sent: true }>("auth:requestPasswordReset", { email: "totally-unknown@x.co" })).value;
    expect(unknownResult).toEqual({ sent: true });
    expect(sent2.length).toBe(0);
    expect((await readAuthCode(rUnknown, "totally-unknown@x.co", "reset"))!.codeHash).toBe("");
    await expect(rUnknown.run("auth:requestPasswordReset", { email: "totally-unknown@x.co" })).rejects.toThrow(/EMAIL_COOLDOWN/);
  });

  // ── FINAL-REVIEW FIX WAVE ──────────────────────────────────────────────────────────────────────
  // These pin the final whole-branch review's Important finding: the three TOKEN-flow redeems
  // (verifyEmail/resetPassword/signInWithMagicLink) used to call `failInvalidConsuming` on a
  // wrong/garbage presented code, which DELETED the single active `authCodes` row — the SAME row
  // `_issueCode` reads as the 60s-per-(email,flow) cooldown anchor. An attacker who knows only a
  // victim's email could (a) unthrottled-delete the victim's live code at wire speed (a
  // recovery-denial DoS: the victim's real emailed link intermittently reads back "invalid code"),
  // and (b) immediately re-request with no row left to cool down against (a per-email cooldown
  // bypass — email-bombing bounded only by the global send throttle). The fix: a token-flow
  // non-match no longer deletes the row (32-char/192-bit tokens can't be brute-forced, so there's
  // no security reason to consume on a miss); OTP is untouched (its 8-digit code IS guessable, so
  // its attempt-counter-then-delete-at-cap behavior stays exactly as-is).

  it("FINAL-REVIEW FIX pin — recovery-denial DoS closed: a wrong resetPassword guess against a live code does NOT destroy it; the victim's real code still works afterward", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "recoverdos@x.co", password: "old-pw" });

    const resetCode = await issueLink(r, sent, "recoverdos@x.co", "reset");

    // Attacker — knows only the victim's email, guesses garbage. Must fail generically...
    await expect(
      r.run("auth:resetPassword", { email: "recoverdos@x.co", code: "attacker-garbage-guess", newPassword: "hijack" }),
    ).rejects.toThrow(/invalid code/);

    // ...and must NOT have destroyed the victim's live code (the pre-fix bug): privileged read
    // shows the row survives the wrong guess.
    expect(await readAuthCode(r, "recoverdos@x.co", "reset")).not.toBeNull();

    // The victim's REAL code — the one actually emailed to them — still redeems successfully.
    // Recovery was never denied.
    const fresh = (await r.run<MintResult>("auth:resetPassword", { email: "recoverdos@x.co", code: resetCode, newPassword: "new-pw" })).value;
    expect(typeof fresh.token).toBe("string");
    await expect(r.run("auth:signIn", { email: "recoverdos@x.co", password: "old-pw" })).rejects.toThrow(/invalid credentials/);
    const signedIn = (await r.run<MintResult>("auth:signIn", { email: "recoverdos@x.co", password: "new-pw" })).value;
    expect(typeof signedIn.token).toBe("string");
  });

  it("FINAL-REVIEW FIX pin — cooldown-bypass DoS closed: a wrong signInWithMagicLink guess does NOT clear the cooldown anchor; an immediate re-request still hits EMAIL_COOLDOWN", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    await r.run("auth:requestMagicLink", { email: "cooldowndos@x.co" });
    expect(sent.length).toBe(1);

    // Attacker submits garbage against the live magic-link code.
    await expect(
      r.run("auth:signInWithMagicLink", { email: "cooldowndos@x.co", token: "attacker-garbage-guess" }),
    ).rejects.toThrow(/invalid code/);

    // The cooldown anchor (the row's `createdAt`) survived the wrong guess: an immediate re-request
    // still hits EMAIL_COOLDOWN instead of sailing through with a fresh code + a second send (the
    // pre-fix bypass — the row would have been deleted, so `_issueCode` would see no `existing` row
    // and skip the cooldown check entirely).
    await expect(r.run("auth:requestMagicLink", { email: "cooldowndos@x.co" })).rejects.toThrow(/EMAIL_COOLDOWN/);
    expect(sent.length).toBe(1); // no second send slipped through
  });

  it("FINAL-REVIEW FIX pin — wrong-then-correct survival via verifyEmail: a garbage guess doesn't destroy the live code; the real one still verifies afterward", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "verifydos@x.co", password: "pw" });

    const token = await issueLink(r, sent, "verifydos@x.co", "verify");

    await expect(r.run("auth:verifyEmail", { email: "verifydos@x.co", code: "attacker-garbage-guess" })).rejects.toThrow(/invalid code/);
    expect(await readAuthCode(r, "verifydos@x.co", "verify")).not.toBeNull(); // survives the wrong guess

    const result = (await r.run<MintResult>("auth:verifyEmail", { email: "verifydos@x.co", code: token })).value;
    expect(typeof result.token).toBe("string");
    expect(await readUser(r, "verifydos@x.co")).toMatchObject({ emailVerified: true });
  });

  it("FINAL-REVIEW FIX pin — wrong-then-correct survival via signInWithMagicLink: a garbage token guess doesn't destroy the live code; the real one still signs in afterward", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);

    const token = await issueLink(r, sent, "magicdos@x.co", "magic");

    await expect(r.run("auth:signInWithMagicLink", { email: "magicdos@x.co", token: "attacker-garbage-guess" })).rejects.toThrow(/invalid code/);
    expect(await readAuthCode(r, "magicdos@x.co", "magic")).not.toBeNull(); // survives the wrong guess

    const result = (await r.run<MintResult>("auth:signInWithMagicLink", { email: "magicdos@x.co", token })).value;
    expect(typeof result.token).toBe("string");
  });

  it("OTP unaffected by this fix wave: otpAttempts wrong guesses still deletes the row at the cap (attempt-counter path, not the token-flow non-match path)", async () => {
    let nowMs = 1_000_000_000_000;
    const { sent, provider } = captureProvider();
    const r = await makeRuntime({ email: { provider, from: "noreply@app.co", baseUrl: "https://app.example.com" } }, () => nowMs);
    await r.run("auth:signUp", { email: "otpunaffected@x.co", password: "pw" });
    const realCode = await issueOtp(r, sent, "otpunaffected@x.co");

    for (let i = 0; i < 4; i++) {
      await expect(r.run("auth:signInWithOtp", { email: "otpunaffected@x.co", code: "00000000" })).rejects.toThrow(/invalid code/);
    }
    // 5th wrong guess reaches the cap → the row IS deleted (OTP's attempt-counter lockout, untouched
    // by this fix wave — its 8-digit code is guessable, so consuming at the cap remains correct).
    await expect(r.run("auth:signInWithOtp", { email: "otpunaffected@x.co", code: "00000000" })).rejects.toThrow(/invalid code/);
    expect(await readAuthCode(r, "otpunaffected@x.co", "otp")).toBeNull();
    await expect(r.run("auth:signInWithOtp", { email: "otpunaffected@x.co", code: realCode })).rejects.toThrow(/invalid code/);
  });
});
