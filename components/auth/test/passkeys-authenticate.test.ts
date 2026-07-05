import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema } from "@helipod/values";
import { query, type QueryCtx } from "@helipod/executor";
import type { JSONValue } from "@helipod/values";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { defineAuth, sha256base64url, type MintResult, type MfaRequired, type PasskeyOptions } from "../src";
import { totpCodeAt, currentStep } from "../src/mfa/totp";
import { createMockAuthenticator, type MockAuthenticator } from "./support/mock-authenticator";

/**
 * Task 4 component-level tests: `beginPasskeyAuthentication`/`finishPasskeyAuthentication` driven
 * through the REAL embedded runtime with the software authenticator — genuine assertions run
 * through the actual `@simplewebauthn/server` verify path (T2), never a mock of the ceremony.
 * Mirrors `passkeys-register.test.ts`'s harness shape.
 */

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";
const VALID: PasskeyOptions = { rpID: RP_ID, rpName: "Test App", origins: [ORIGIN] };
const NOW = 1_700_000_000_000;
// A 32-byte key encoded as base64 — same shape as mfa-gate.test.ts's key. Only used by the
// MFA-interaction runtime below.
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");

/** `EmbeddedRuntime.runAction`'s `args` is typed `JSONValue` — `@simplewebauthn/server`'s response
 *  types don't structurally satisfy that even though every field IS plain JSON. One cast site. */
function actionArgs<T>(args: T): JSONValue {
  return args as unknown as JSONValue;
}

// Privileged test-only reads (raw physical table names) — same idiom as
// `passkeys-register.test.ts`'s `_readPasskeysByUser` / `email-redeem.test.ts`'s `_readUser`.
const _readPasskeysByUser = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  return ctx.db.query("auth/passkeys", "byUserId").eq("userId", userId).collect();
});
const _readSessionsByUser = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  return ctx.db.query("auth/sessions", "byUserId").eq("userId", userId).collect();
});

async function makeRuntime(overrides?: Partial<PasskeyOptions>) {
  const comp = defineAuth({ passkeys: { ...VALID, ...overrides } });
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    systemModules: {
      "_test:passkeysByUser": _readPasskeysByUser,
      "_test:sessionsByUser": _readSessionsByUser,
    },
    now: () => NOW,
  });
}

/** Same harness as `makeRuntime`, plus a configured `mfa` gate — used to prove a passkey sign-in
 *  still honors an enrolled second factor (routes through `finishSignIn`, not `mintSession`). */
async function makeRuntimeWithMfa() {
  const comp = defineAuth({ passkeys: VALID, mfa: { encryptionKey: TEST_KEY } });
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [comp],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    systemModules: {
      "_test:passkeysByUser": _readPasskeysByUser,
      "_test:sessionsByUser": _readSessionsByUser,
    },
    now: () => NOW,
  });
}

/** Enroll + confirm TOTP MFA for an authed user (by their session token), via the real
 *  startMfaEnrollment/confirmMfaEnrollment mutations — mirrors mfa-gate.test.ts's `enrollMfa`. */
async function enrollMfa(r: EmbeddedRuntime, token: string): Promise<void> {
  const start = (
    await r.run<{ secret: string }>("auth:startMfaEnrollment", {}, { identity: token })
  ).value;
  await r.run("auth:confirmMfaEnrollment", { code: totpCodeAt(start.secret, currentStep(NOW)) }, { identity: token });
}

async function passkeysByUser(r: EmbeddedRuntime, userId: string): Promise<Array<Record<string, unknown>>> {
  return (await r.runSystem<Array<Record<string, unknown>>>("_test:passkeysByUser", { userId })).value;
}

async function sessionsByUser(r: EmbeddedRuntime, userId: string): Promise<Array<Record<string, unknown>>> {
  return (await r.runSystem<Array<Record<string, unknown>>>("_test:sessionsByUser", { userId })).value;
}

async function signUp(r: EmbeddedRuntime, email = "a@b.co"): Promise<MintResult> {
  return (await r.run<MintResult>("auth:signUp", { email, password: "pw" })).value;
}

/** Drive a full registration ceremony (T3 path) and return the credential + authenticator so a
 *  test can drive authentication against it. */
async function registerPasskey(
  r: EmbeddedRuntime,
  token: string,
  authenticator: MockAuthenticator = createMockAuthenticator(),
) {
  const options = (
    await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: token })
  ).value;
  const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
  const result = (
    await r.runAction<{ registered: true; passkeyId: string }>(
      "auth:finishPasskeyRegistration",
      actionArgs<{ response: RegistrationResponseJSON }>({ response }),
      { identity: token },
    )
  ).value;
  return { authenticator, credentialId: response.id, result };
}

async function beginAuth(r: EmbeddedRuntime, args?: { email?: string }) {
  return (
    await r.runAction<PublicKeyCredentialRequestOptionsJSON>("auth:beginPasskeyAuthentication", args ?? {})
  ).value;
}

async function finishAuth(r: EmbeddedRuntime, response: AuthenticationResponseJSON): Promise<MintResult> {
  return (
    await r.runAction<MintResult>("auth:finishPasskeyAuthentication", actionArgs({ response }))
  ).value;
}

describe("N1 Task 4: beginPasskeyAuthentication / finishPasskeyAuthentication", () => {
  it("usernameless (discoverable) sign-in mints a session for the registered user's id", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    const options = await beginAuth(r); // no email — discoverable/usernameless
    expect(options.allowCredentials).toEqual([]);

    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId, // resident credential reports its owner via userHandle
    });
    const mint = await finishAuth(r, assertion);

    expect(mint.userId).toBe(up.userId);
    expect(typeof mint.token).toBe("string");
    expect(typeof mint.refreshToken).toBe("string");
    expect(mint.token).not.toBe(mint.refreshToken);

    // The counter advanced to what the authenticator reported.
    const [row] = await passkeysByUser(r, up.userId);
    expect(row!.counter).toBe(1);
    expect(row!.lastUsedAt).toBe(NOW);
  });

  it("mints through the A1 chokepoint — hashed pair at rest, no raw token in the sessions row", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);
    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    const mint = await finishAuth(r, assertion);

    const rows = await sessionsByUser(r, up.userId);
    // The signUp session plus the freshly-minted passkey session.
    const minted = rows.find((row) => row.tokenHash === sha256base64url(mint.token));
    expect(minted).toBeDefined();
    expect(minted!.token).toBeUndefined(); // never stored raw
    expect(minted!.refreshTokenHash).toBe(sha256base64url(mint.refreshToken));
  });

  it("non-discoverable (email-scoped) sign-in works — begin returns the caller's credential ids", async () => {
    const r = await makeRuntime();
    const up = await signUp(r, "known@example.com");
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    const options = await beginAuth(r, { email: "known@example.com" });
    expect(options.allowCredentials?.map((c) => c.id)).toEqual([credentialId]);

    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
    });
    const mint = await finishAuth(r, assertion);
    expect(mint.userId).toBe(up.userId);
  });

  it("anti-enumeration: an UNKNOWN email's begin returns empty allowCredentials — shape-identical to usernameless", async () => {
    const r = await makeRuntime();
    const usernameless = await beginAuth(r);
    const unknownEmail = await beginAuth(r, { email: "nobody@nowhere.example" });

    expect(unknownEmail.allowCredentials).toEqual([]);
    expect(unknownEmail.allowCredentials).toEqual(usernameless.allowCredentials);
    // Same shape modulo the per-call random challenge/timeout — rpId/userVerification match.
    expect(unknownEmail.rpId).toEqual(usernameless.rpId);
    expect(unknownEmail.userVerification).toEqual(usernameless.userVerification);
  });

  it("a known user with NO passkeys registered also gets empty allowCredentials (not an oracle for 'has an account')", async () => {
    const r = await makeRuntime();
    await signUp(r, "nopasskeys@example.com");
    const options = await beginAuth(r, { email: "nopasskeys@example.com" });
    expect(options.allowCredentials).toEqual([]);
  });

  it("REJECTS an unknown credentialId generically — no matching passkeys row", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    await registerPasskey(r, up.token);
    const foreignAuthenticator = createMockAuthenticator();
    // Register a credential on a DIFFERENT (throwaway) authenticator/runtime-less flow so we have a
    // valid-looking assertion whose credentialId was never saved to THIS runtime's `passkeys` table.
    const bogusOptions = await beginAuth(r);
    const bogusResponse = foreignAuthenticator.createRegistration({
      challenge: "unused",
      rpID: RP_ID,
      origin: ORIGIN,
    });
    const assertion = foreignAuthenticator.createAssertion({
      challenge: bogusOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId: bogusResponse.id,
      counter: 1,
    });
    await expect(finishAuth(r, assertion)).rejects.toThrow(/passkey authentication failed/);
  });

  it("REJECTS a replayed/stale challenge — finishing twice with the same assertion fails the second time", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);
    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    await finishAuth(r, assertion); // consumes the challenge, advances counter to 1

    await expect(finishAuth(r, assertion)).rejects.toThrow(/passkey authentication failed/);
    const [row] = await passkeysByUser(r, up.userId);
    expect(row!.counter).toBe(1); // unchanged by the rejected replay
  });

  it("CLONE DETECTION: a counter regression is rejected — NO mint, NO state change (atomic)", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    // First, a genuine sign-in advances the stored counter to 5.
    const firstOptions = await beginAuth(r);
    const firstAssertion = authenticator.createAssertion({
      challenge: firstOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 5,
      userId: up.userId,
    });
    const firstMint = await finishAuth(r, firstAssertion);
    expect(firstMint.userId).toBe(up.userId);

    const [afterFirst] = await passkeysByUser(r, up.userId);
    expect(afterFirst!.counter).toBe(5);
    const sessionsAfterFirst = await sessionsByUser(r, up.userId);

    // Now a CLONED authenticator presents a stale counter (3 < 5) under a FRESH, valid challenge.
    const secondOptions = await beginAuth(r);
    const clonedAssertion = authenticator.createAssertion({
      challenge: secondOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 3, // regressed
      userId: up.userId,
    });
    await expect(finishAuth(r, clonedAssertion)).rejects.toThrow(/passkey authentication failed/);

    // No mint: the session set is unchanged.
    const sessionsAfterClone = await sessionsByUser(r, up.userId);
    expect(sessionsAfterClone.length).toBe(sessionsAfterFirst.length);

    // No state change: the stored counter is still 5, not overwritten by the rejected 3.
    const [afterClone] = await passkeysByUser(r, up.userId);
    expect(afterClone!.counter).toBe(5);
  });

  it("a REPEATED (not just regressed) nonzero counter is also rejected — equal counters are a replay/clone signal", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    const firstOptions = await beginAuth(r);
    const firstAssertion = authenticator.createAssertion({
      challenge: firstOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 5,
      userId: up.userId,
    });
    await finishAuth(r, firstAssertion);

    const secondOptions = await beginAuth(r);
    const repeatedAssertion = authenticator.createAssertion({
      challenge: secondOptions.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 5, // same value, not a regression per se, but not an advance either
      userId: up.userId,
    });
    await expect(finishAuth(r, repeatedAssertion)).rejects.toThrow(/passkey authentication failed/);
    const [row] = await passkeysByUser(r, up.userId);
    expect(row!.counter).toBe(5);
  });

  it("the 0/0 (counter-less authenticator) case is accepted repeatedly — modern synced passkeys report 0 forever", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    for (let i = 0; i < 3; i++) {
      const options = await beginAuth(r);
      const assertion = authenticator.createAssertion({
        challenge: options.challenge,
        rpID: RP_ID,
        origin: ORIGIN,
        credentialId,
        counter: 0,
        userId: up.userId,
      });
      const mint = await finishAuth(r, assertion);
      expect(mint.userId).toBe(up.userId);
    }
    const [row] = await passkeysByUser(r, up.userId);
    expect(row!.counter).toBe(0);
  });

  it("REJECTS a userHandle that doesn't match the credential's owner", async () => {
    const r = await makeRuntime();
    const alice = await signUp(r, "alice@example.com");
    const bob = await signUp(r, "bob@example.com");
    const { authenticator, credentialId } = await registerPasskey(r, alice.token);

    const options = await beginAuth(r);
    // A well-formed, correctly-signed assertion for alice's credential, but claiming to be bob.
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: bob.userId,
    });
    await expect(finishAuth(r, assertion)).rejects.toThrow(/passkey authentication failed/);
    const [row] = await passkeysByUser(r, alice.userId);
    expect(row!.counter).toBe(0); // unchanged — rejected before the mint transaction
  });

  it("REJECTS an assertion signed for the wrong origin — generic failure", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);
    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: "http://evil.example.com",
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    await expect(finishAuth(r, assertion)).rejects.toThrow(/passkey authentication failed/);
  });

  it("a client-supplied non-string userHandle (null) is treated as ABSENT — no raw Buffer.from(null) TypeError; a validly-signed assertion still mints for the credential's real owner", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);
    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    // `response.userHandle` is client-supplied; the wire codec permits JSON `null` (only `undefined`
    // is rejected), so the static `string | undefined` type is not a runtime guarantee. Before the
    // fix, `null` passed the `!== undefined` gate and hit `Buffer.from(null, ...)` — a RAW TypeError
    // that, thrown AFTER the credential lookup succeeded, distinguished "credential exists" by error
    // TYPE from the generic reject an unknown credential gets. The fix guards on `typeof === "string"`,
    // so a non-string userHandle is simply treated as absent (the non-discoverable path): the
    // signature is still verified against the stored publicKey and the mint uses the credential's own
    // `row.userId`, never the client's claim. Result: a genuine owner mints; an attacker who nulls
    // userHandle against a credential they don't own can't produce a valid signature, so they hit the
    // SAME generic reject at verify — no error-type oracle either way.
    const nulled = { ...assertion, response: { ...assertion.response, userHandle: null } } as unknown as AuthenticationResponseJSON;
    const mint = await finishAuth(r, nulled);
    expect(mint.userId).toBe(up.userId); // minted for the credential's real owner, no crash
  });

  it("MFA GATE: an MFA-enrolled user signing in with a passkey gets { mfaRequired } — the passkey is a FIRST factor, it does NOT bypass an explicitly-enrolled second factor", async () => {
    const r = await makeRuntimeWithMfa();
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);
    await enrollMfa(r, up.token); // password + TOTP + a passkey all on one account

    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    // A fully valid passkey assertion — but because the user has a confirmed TOTP enrollment, the
    // mint routes through finishSignIn and returns a pending challenge instead of a live session.
    const result = (await finishAuth(r, assertion)) as unknown as MfaRequired;
    expect(result.mfaRequired).toBe(true);
    expect(typeof result.pendingToken).toBe("string");
    expect("token" in result).toBe(false);

    // No session was minted by the passkey step: the only session row is the original signUp one.
    const sessions = await sessionsByUser(r, up.userId);
    expect(sessions.every((s) => (s.tokenHash as string) !== undefined)).toBe(true);
    // The counter DID advance (the assertion was genuine and the row updated in the same mutation
    // that produced the challenge) — the gate is post-verification, not a pre-verification refusal.
    const [row] = await passkeysByUser(r, up.userId);
    expect(row!.counter).toBe(1);
  });

  it("MFA GATE (control): the SAME passkey flow WITHOUT an MFA enrollment mints a session directly", async () => {
    const r = await makeRuntimeWithMfa(); // mfa configured, but this user never enrolls
    const up = await signUp(r);
    const { authenticator, credentialId } = await registerPasskey(r, up.token);

    const options = await beginAuth(r);
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    const mint = await finishAuth(r, assertion);
    expect(mint.userId).toBe(up.userId);
    expect(typeof mint.token).toBe("string");
    expect("mfaRequired" in mint).toBe(false);
  });

});
