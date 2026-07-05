import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema } from "@helipod/values";
import { query, type QueryCtx } from "@helipod/executor";
import type { JSONValue } from "@helipod/values";
import type { PublicKeyCredentialCreationOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { defineAuth, type MintResult, type PasskeyOptions } from "../src";
import { createMockAuthenticator, type MockAuthenticator } from "./support/mock-authenticator";

/**
 * Task 3 component-level tests: `beginPasskeyRegistration`/`finishPasskeyRegistration` driven
 * through the REAL embedded runtime with the software authenticator (`mock-authenticator.ts`) — a
 * genuine WebCrypto P-256 keypair producing genuine `none`-attestation registration responses, run
 * through the actual `@simplewebauthn/server` verify path (T2), never a mock of the ceremony itself.
 */

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";
const VALID: PasskeyOptions = { rpID: RP_ID, rpName: "Test App", origins: [ORIGIN] };
const NOW = 1_700_000_000_000;

function b64u(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** `EmbeddedRuntime.runAction`'s `args` is typed `JSONValue`, which requires an index signature —
 *  `@simplewebauthn/server`'s `RegistrationResponseJSON` (a concrete, non-indexed interface) doesn't
 *  structurally satisfy that even though every field IS plain JSON. A single cast at the one place
 *  every test constructs a `finishPasskeyRegistration` call, rather than sprinkling `as unknown as
 *  JSONValue` at each call site. */
function finishArgs(response: RegistrationResponseJSON): JSONValue {
  return { response } as unknown as JSONValue;
}

// Privileged test-only read (raw physical table name), same idiom as email-redeem.test.ts's
// `_readAuthCode`/`_readUser`: trusted-caller-only system module, no `isInternalPath` gate (that
// gate only blocks the PUBLIC run/runAction paths from reaching a component's own `_`-prefixed
// internal functions — it has nothing to do with this test-local systemModules entry).
const _readPasskeysByUser = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  return ctx.db.query("auth/passkeys", "byUserId").eq("userId", userId).collect();
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
    systemModules: { "_test:passkeysByUser": _readPasskeysByUser },
    now: () => NOW,
  });
}

async function passkeysByUser(r: EmbeddedRuntime, userId: string): Promise<Array<Record<string, unknown>>> {
  return (await r.runSystem<Array<Record<string, unknown>>>("_test:passkeysByUser", { userId })).value;
}

async function signUp(r: EmbeddedRuntime, email = "a@b.co"): Promise<MintResult> {
  return (await r.run<MintResult>("auth:signUp", { email, password: "pw" })).value;
}

/** Drive one full registration ceremony end-to-end (begin → authenticator → finish) and return
 *  every intermediate artifact a test might want to inspect. */
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
      finishArgs(response),
      { identity: token },
    )
  ).value;
  return { authenticator, options, response, result };
}

describe("N1 Task 3: beginPasskeyRegistration / finishPasskeyRegistration", () => {
  it("registers a passkey for an authed user; a passkeys row appears with the right fields", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { response, result } = await registerPasskey(r, up.token);

    expect(result.registered).toBe(true);
    expect(typeof result.passkeyId).toBe("string");

    const rows = await passkeysByUser(r, up.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(up.userId);
    expect(rows[0]!.credentialId).toBe(response.id);
    expect(rows[0]!.transports).toEqual(["internal"]);
    expect(rows[0]!.backedUp).toBe(false);
    expect(rows[0]!.counter).toBe(0);
    expect(typeof rows[0]!.publicKey).toBe("string");
    expect((rows[0]!.publicKey as string).length).toBeGreaterThan(0);
    expect(rows[0]!.createdAt).toBe(NOW);
  });

  it("an ANONYMOUS session can register a passkey (decision 9 — registration is authed-only, anon included)", async () => {
    const r = await makeRuntime();
    const anon = (await r.run<MintResult>("auth:signInAnonymously", {})).value;
    const { result } = await registerPasskey(r, anon.token);
    expect(result.registered).toBe(true);
    const rows = await passkeysByUser(r, anon.userId);
    expect(rows).toHaveLength(1);
  });

  it("beginPasskeyRegistration without an authenticated session is rejected generically", async () => {
    const r = await makeRuntime();
    await expect(r.runAction("auth:beginPasskeyRegistration", {})).rejects.toThrow(/not authenticated/);
  });

  it("REJECTS an attestation signed for the wrong origin — generic failure, no row written", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const authenticator = createMockAuthenticator();
    const options = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: "http://evil.example.com" });
    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(response), { identity: up.token }),
    ).rejects.toThrow(/passkey registration failed/);
    expect(await passkeysByUser(r, up.userId)).toHaveLength(0);
  });

  it("REJECTS an attestation signed for the wrong RP ID — generic failure, no row written", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const authenticator = createMockAuthenticator();
    const options = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    const response = authenticator.createRegistration({ challenge: options.challenge, rpID: "attacker.example", origin: ORIGIN });
    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(response), { identity: up.token }),
    ).rejects.toThrow(/passkey registration failed/);
    expect(await passkeysByUser(r, up.userId)).toHaveLength(0);
  });

  it("REJECTS a tampered (garbage) attestationObject — generic failure, no row written", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const authenticator = createMockAuthenticator();
    const options = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
    // Replace the attestationObject with random bytes — not valid CBOR, so `verifyRegistration`
    // must fail closed (a real attacker/corrupted-client attestation, not a valid-but-wrong one).
    const tampered: RegistrationResponseJSON = {
      ...response,
      response: { ...response.response, attestationObject: b64u(randomBytes(64)) },
    };
    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(tampered), { identity: up.token }),
    ).rejects.toThrow(/passkey registration failed/);
    expect(await passkeysByUser(r, up.userId)).toHaveLength(0);
  });

  it("a REPLAYED challenge is rejected — finishing the SAME response twice fails the second time", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { response } = await registerPasskey(r, up.token);

    // The challenge row was consumed by the first (successful) finish — replaying the identical
    // response must find no matching challenge and reject generically.
    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(response), { identity: up.token }),
    ).rejects.toThrow(/passkey registration failed/);
    expect(await passkeysByUser(r, up.userId)).toHaveLength(1); // still just the first success
  });

  it("a second registration presenting the SAME credentialId (attestationObject replayed under a fresh challenge) is rejected as a duplicate", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { response: first } = await registerPasskey(r, up.token);

    // A fresh begin/challenge, but `finish` is handed the FIRST attestation's response bytes (same
    // credentialId/COSE key) wrapped in a NEW clientDataJSON carrying the fresh challenge — RP-ID/
    // origin/flags all still check out (none of those depend on the challenge); only
    // `_savePasskey`'s storage-level duplicate-credentialId guard can catch this.
    const second = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    const clientDataJSON = b64u(
      Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: second.challenge, origin: ORIGIN, crossOrigin: false }), "utf8"),
    );
    const replayed: RegistrationResponseJSON = { ...first, response: { ...first.response, clientDataJSON } };

    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(replayed), { identity: up.token }),
    ).rejects.toThrow(/PASSKEY_ALREADY_REGISTERED/);
    expect(await passkeysByUser(r, up.userId)).toHaveLength(1); // still just the first
  });

  it("a SECOND, DIFFERENT passkey for the same user is added — multiple credentials coexist", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const first = await registerPasskey(r, up.token);
    const second = await registerPasskey(r, up.token, createMockAuthenticator());

    expect(first.result.passkeyId).not.toBe(second.result.passkeyId);
    expect(first.response.id).not.toBe(second.response.id);

    const rows = await passkeysByUser(r, up.userId);
    expect(rows).toHaveLength(2);
    const credIds = rows.map((row) => row.credentialId).sort();
    expect(credIds).toEqual([first.response.id, second.response.id].sort());
  });

  it("the (N+1)th registration past maxCredentialsPerUser is rejected — the cap holds", async () => {
    const r = await makeRuntime({ maxCredentialsPerUser: 1 });
    const up = await signUp(r);
    await registerPasskey(r, up.token); // fills the one slot

    const options = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    const response = createMockAuthenticator().createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
    await expect(
      r.runAction("auth:finishPasskeyRegistration", finishArgs(response), { identity: up.token }),
    ).rejects.toThrow(/PASSKEY_LIMIT_REACHED/);

    expect(await passkeysByUser(r, up.userId)).toHaveLength(1);
  });

  it("excludeCredentials in the begin options carries the caller's already-registered credential ids", async () => {
    const r = await makeRuntime();
    const up = await signUp(r);
    const { response: first } = await registerPasskey(r, up.token);

    const second = (
      await r.runAction<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {}, { identity: up.token })
    ).value;
    expect(second.excludeCredentials?.map((c) => c.id)).toEqual([first.id]);
  });
});
