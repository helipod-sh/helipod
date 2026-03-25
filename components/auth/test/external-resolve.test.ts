import { describe, it, expect, afterEach } from "vitest";
import { action, type ActionCtx } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, googleProvider, type MintResult } from "../src";

const OAUTH = { oauth: { providers: { google: googleProvider({ clientId: "i", clientSecret: "s" }) }, redirectAllowlist: ["http://localhost:5173"] } };

/**
 * `_resolveExternalIdentity` is a `_`-prefixed component-internal mutation — the engine's public
 * dispatch gate (`isInternalPath`, `packages/runtime-embedded/src/runtime.ts`) rejects any client
 * call whose path has an underscore-prefixed segment, exactly like `auth:_issueCode`/
 * `auth:_startOAuth` before it. In production it's reached only via TRUSTED server re-entrancy — an
 * action's `ctx.runMutation` (Task 5's `completeOAuthSignIn`, Task 6's `signInWithIdToken`) — which
 * resolves `_`-prefixed paths on purpose (see that file's `invoke` doc comment). Since Tasks 5/6
 * haven't landed yet, this thin test-only action stands in for "the real caller": it does nothing
 * but forward straight through `ctx.runMutation`, so the test still drives the REAL registered
 * mutation (full argument shape, full namespacing, full transaction) — not a bypassed/reimplemented
 * copy of the logic.
 */
const testModules = {
  testHelpers: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    resolveExternal: action(async (ctx: unknown, args: any) => {
      return (ctx as ActionCtx).runMutation("auth:_resolveExternalIdentity", args);
    }),
  },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveExternal(args: any): Promise<MintResult | { userId: string }> {
  return t.action("testHelpers:resolveExternal", args) as Promise<MintResult | { userId: string }>;
}

let t: TestStackbase; afterEach(async () => { await t.close(); });

describe("auth A3 Part 3: _resolveExternalIdentity — the account-resolution/linking matrix", () => {
  it("1) returning identity ⇒ mints for the bound user, no new account", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const a = await resolveExternal({ provider: "google", accountId: "sub1", emailVerified: true, email: "x@y.com", outcome: "mint" }) as MintResult;
    const b = await resolveExternal({ provider: "google", accountId: "sub1", emailVerified: true, email: "x@y.com", outcome: "mint" }) as MintResult;
    expect(b.userId).toBe(a.userId);
    const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "sub1").collect());
    expect(accts.length).toBe(1);
  });

  it("3) VERIFIED email matching a pre-registered UNVERIFIED password account ⇒ links + REVOKES the pre-registrant's parked sessions (takeover defense)", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth({ ...OAUTH, email: undefined })], schema: false });
    // Attacker pre-registers the victim's email (unverified) and parks a session:
    const parked = await t.mutation("auth:signUp", { email: "victim@corp.com", password: "attacker-pw" }) as MintResult;
    // True owner signs in with a VERIFIED Google identity for the same email:
    const owner = await resolveExternal({ provider: "google", accountId: "gsub", emailVerified: true, email: "victim@corp.com", outcome: "mint" }) as MintResult;
    // Same user (linked), the parked session is gone, and emailVerified flipped true.
    const live = await t.query("auth:getUserId", { token: parked.token });
    expect(live).toBeNull();                                   // attacker's parked session revoked
    expect(await t.query("auth:getUserId", { token: owner.token })).toBe(owner.userId);
    expect(owner.userId).toBe(parked.userId);                  // linked to the SAME (pre-existing) user
    const user = await t.run(async (ctx: any) => ctx.db.get(owner.userId));
    expect(user.emailVerified).toBe(true);
  });

  it("3b) already-verified user linking a second verified provider ⇒ NO flip → the user's other sessions SURVIVE (flip-gated UX pin)", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    // First verified sign-in creates the user + flips emailVerified true (its own session wiped-then-minted).
    const first = await resolveExternal({ provider: "google", accountId: "g1", emailVerified: true, email: "u@u.com", outcome: "mint" }) as MintResult;
    expect(await t.query("auth:getUserId", { token: first.token })).toBe(first.userId); // `first` is live (already verified)
    // A SECOND verified provider for the same (now already-verified) user links to the same account with
    // NO emailVerified flip — so `first`'s session is NOT revoked (this is exactly what distinguishes the
    // flip-gated helper from an unconditional wipe).
    const second = await resolveExternal({ provider: "oidc:https://clerk", accountId: "c1", emailVerified: true, email: "u@u.com", outcome: "mint" }) as MintResult;
    expect(second.userId).toBe(first.userId);
    expect(await t.query("auth:getUserId", { token: first.token })).toBe(first.userId); // SURVIVES — no flip
    const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "oidc:https://clerk").eq("accountId", "c1").collect());
    expect(accts.length).toBe(1); // the second provider IS linked
  });

  // Attribution: T4 review's Important — the case-3 autolink gate (`args.emailVerified` alone) was
  // truthy-loose, so a non-boolean truthy `emailVerified` (e.g. the STRING "false", emitted by some
  // IdPs' `email_verified` JWT claim) wrongly took case 3 (autolink + flip-gated session wipe) instead
  // of case 4. Reproduced by the reviewer against a pre-registered UNVERIFIED account; pinned here
  // permanently. The gate is now strict (`=== true`), matching case 4's own `=== true` storage check
  // and the `markVerifiedRevokingIfFirstProof` helper's own strict `!== true` read.
  it.each([
    ["the string \"false\"", "false"],
    ["the number 1", 1],
    ["the string \"0\"", "0"],
  ])("3-regression) non-boolean truthy emailVerified (%s) ⇒ STRICT gate takes case 4, no autolink, no session wipe", async (_label, badValue) => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth({ ...OAUTH, email: undefined })], schema: false });
    // Attacker pre-registers the victim's email (unverified) and parks a session:
    const parked = await t.mutation("auth:signUp", { email: "victim@corp.com", password: "attacker-pw" }) as MintResult;
    // A caller sends a non-boolean truthy emailVerified for the SAME email:
    const attempt = await resolveExternal({ provider: "google", accountId: "gsub-bad", emailVerified: badValue, email: "victim@corp.com", outcome: "mint" }) as MintResult;
    // Case 4, NOT case 3: a NEW separate user, never linked to the victim's pre-existing account.
    expect(attempt.userId).not.toBe(parked.userId);
    // The victim's account is untouched — no external account was linked to it.
    const acctsOnVictim = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "gsub-bad").collect());
    expect(acctsOnVictim[0].userId).not.toBe(parked.userId);
    // The victim's parked session is STILL LIVE — not wiped.
    expect(await t.query("auth:getUserId", { token: parked.token })).toBe(parked.userId);
    // The new user's emailVerified is NOT true (case 4's strict `=== true` storage check).
    const newUser = await t.run(async (ctx: any) => ctx.db.get(attempt.userId));
    expect(newUser.emailVerified).not.toBe(true);
  });

  it("4) UNVERIFIED external email ⇒ NEVER autolinks; creates a SEPARATE user", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const pw = await t.mutation("auth:signUp", { email: "shared@x.com", password: "pw123456" }) as MintResult;
    const ext = await resolveExternal({ provider: "google", accountId: "g9", emailVerified: false, email: "shared@x.com", outcome: "mint" }) as MintResult;
    expect(ext.userId).not.toBe(pw.userId);                    // separate user — the attack vector is closed
    expect(await t.query("auth:getUserId", { token: pw.token })).toBe(pw.userId); // password session untouched
    const extAcct = await t.run(async (ctx: any) => ctx.db.get(ext.userId));
    expect(extAcct.emailVerified).not.toBe(true);              // unverified provision stays unverified
  });

  it("4b) no email at all ⇒ JIT-provisions a brand-new user (no linking possible)", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const a = await resolveExternal({ provider: "google", accountId: "noemail1", emailVerified: false, outcome: "mint" }) as MintResult;
    const b = await resolveExternal({ provider: "google", accountId: "noemail2", emailVerified: false, outcome: "mint" }) as MintResult;
    expect(a.userId).not.toBe(b.userId);
    const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "noemail1").collect());
    expect(accts.length).toBe(1);
    expect(accts[0].secret).toBe("");                          // external accounts carry the sentinel secret
  });

  it("2) link-while-signed-in ⇒ attaches to the caller's current user", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const me = await t.mutation("auth:signInAnonymously", {}) as MintResult;
    const linked = await resolveExternal({ provider: "google", accountId: "gme", emailVerified: false, linkUserId: me.userId, outcome: "mint" }) as MintResult;
    expect(linked.userId).toBe(me.userId);
    const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "gme").collect());
    expect(accts.length).toBe(1);
    expect(accts[0].userId).toBe(me.userId);
  });

  it("outcome:handoff writes an oauthHandoff row (hashed) and mints NO session", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const r = await resolveExternal({ provider: "google", accountId: "h1", emailVerified: true, email: "h@h.com", outcome: "handoff", handoffHash: "HASH" }) as { userId: string };
    const rows = await t.run(async (ctx: any) => ctx.db.query("auth/oauthHandoff", "byHandoffHash").eq("handoffHash", "HASH").collect());
    expect(rows.length).toBe(1); expect(rows[0].userId).toBe(r.userId);
    const sessions = await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "byUserId").eq("userId", r.userId).collect());
    expect(sessions.length).toBe(0);   // no mint on the handoff path
  });

  it("stale linkUserId (well-formed id, user since deleted) ⇒ falls through to normal resolution (case 4), no throw", async () => {
    t = await createTestStackbase({ modules: testModules, components: [defineAuth(OAUTH)], schema: false });
    const anon = await t.mutation("auth:signInAnonymously", {}) as MintResult;
    await t.run(async (ctx: any) => ctx.db.delete(anon.userId)); // simulate a stale/deleted linkUserId
    const r = await resolveExternal({ provider: "google", accountId: "stalelink", emailVerified: false, linkUserId: anon.userId, outcome: "mint" }) as MintResult;
    expect(r.userId).not.toBe(anon.userId);   // never linked to the deleted user — a NEW user is provisioned
    const accts = await t.run(async (ctx: any) => ctx.db.query("auth/accounts", "byAccount").eq("provider", "google").eq("accountId", "stalelink").collect());
    expect(accts.length).toBe(1);
    expect(accts[0].userId).toBe(r.userId);
  });
});
