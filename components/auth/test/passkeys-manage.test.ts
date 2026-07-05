import { describe, it, expect, afterEach } from "vitest";
import { query, type QueryCtx } from "@helipod/executor";
import type { Value } from "@helipod/values";
import { createTestHelipod, type TestHelipod } from "@helipod/test";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";
import { defineAuth, type MintResult, type PasskeyOptions } from "../src";
import { createMockAuthenticator, type MockAuthenticator } from "./support/mock-authenticator";

/**
 * Task 5 device-management tests: `listPasskeys` / `renamePasskey` / `revokePasskey` — the A1
 * `listSessions`/`revokeSession` mirror. Driven through `@helipod/test`'s real engine (identity via
 * `withIdentity`, reactivity via `subscribe`). Registration ceremonies run the genuine
 * `@simplewebauthn/server` path via the T2 software authenticator, never a mock of the ceremony.
 */

const RP_ID = "localhost";
const ORIGIN = "http://localhost:5173";
const VALID: PasskeyOptions = { rpID: RP_ID, rpName: "Test App", origins: [ORIGIN] };
const NOW = 1_700_000_000_000;

/** `@simplewebauthn/server` response types are plain JSON but don't structurally satisfy the harness's
 *  `Value` arg type. One cast site (mirrors passkeys-authenticate.test.ts's `actionArgs`). */
function actionArgs<T extends object>(args: T): Record<string, Value> {
  return args as unknown as Record<string, Value>;
}

/**
 * App query: the SAME `passkeys` `byUserId` read `listPasskeys` performs, but keyed on an explicit
 * `userId` ARG instead of the ambient session. The harness's `subscribe` always uses the base
 * (no-identity) client (documented v1 limitation), so a subscription can't resolve a session — this
 * lets the reactive test prove that `revokePasskey`'s delete invalidates exactly `listPasskeys`'
 * read-set (the `byUserId` range on `passkeys`). The identity resolution `listPasskeys` layers on top
 * is covered by the direct authed calls below.
 */
const listPasskeysFor = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  const rows = await ctx.db.query("auth/passkeys", "byUserId").eq("userId", userId).collect();
  return rows.map((r) => ({ passkeyId: r._id as string, deviceName: (r.deviceName as string | undefined) ?? null }));
});

let t: TestHelipod;

async function setup(): Promise<void> {
  t = await createTestHelipod({
    modules: { app: { listPasskeysFor } },
    components: [defineAuth({ passkeys: VALID })],
    schema: false,
    now: () => NOW,
  });
}

async function signUp(email = "a@b.co"): Promise<MintResult> {
  return t.mutation<MintResult>("auth:signUp", { email, password: "pw" });
}

/** Run a full registration ceremony for the authed `token`, returning the new passkey's credentialId
 *  and the software authenticator (so a test can later drive authentication against it). */
async function registerPasskey(
  token: string,
  authenticator: MockAuthenticator = createMockAuthenticator(),
): Promise<{ authenticator: MockAuthenticator; credentialId: string }> {
  const asUser = t.withIdentity(token);
  const options = await asUser.action<PublicKeyCredentialCreationOptionsJSON>("auth:beginPasskeyRegistration", {});
  const response = authenticator.createRegistration({ challenge: options.challenge, rpID: RP_ID, origin: ORIGIN });
  await asUser.action("auth:finishPasskeyRegistration", actionArgs<{ response: RegistrationResponseJSON }>({ response }));
  return { authenticator, credentialId: response.id };
}

interface PasskeySummary {
  passkeyId: string;
  deviceName: string | null;
  transports: string[] | null;
  backedUp: boolean | null;
  createdAt: number | null;
  lastUsedAt: number | null;
}

describe("N1 Task 5: listPasskeys / renamePasskey / revokePasskey", () => {
  afterEach(async () => {
    await t.close();
  });

  it("listPasskeys returns the caller's credentials as display metadata ONLY — never publicKey/counter", async () => {
    await setup();
    const up = await signUp();
    await registerPasskey(up.token);

    const list = await t.withIdentity(up.token).query<PasskeySummary[]>("auth:listPasskeys", {});
    expect(list).toHaveLength(1);
    // The projected key set is EXACTLY the display fields — publicKey/counter/userId/credentialId absent.
    expect(Object.keys(list[0]!).sort()).toEqual(
      ["backedUp", "createdAt", "deviceName", "lastUsedAt", "passkeyId", "transports"],
    );
    expect("publicKey" in list[0]!).toBe(false);
    expect("counter" in list[0]!).toBe(false);
  });

  it("listPasskeys is scoped to the caller — one user never sees another's passkeys, and unauthed returns []", async () => {
    await setup();
    const alice = await signUp("alice@x.co");
    const bob = await signUp("bob@x.co");
    await registerPasskey(alice.token);
    await registerPasskey(bob.token);

    expect(await t.withIdentity(alice.token).query<PasskeySummary[]>("auth:listPasskeys", {})).toHaveLength(1);
    expect(await t.withIdentity(bob.token).query<PasskeySummary[]>("auth:listPasskeys", {})).toHaveLength(1);
    // No identity at all → empty, never a throw.
    expect(await t.query<PasskeySummary[]>("auth:listPasskeys", {})).toEqual([]);
  });

  it("renamePasskey updates the label for the owner; a live listPasskeys reflects it", async () => {
    await setup();
    const up = await signUp();
    await registerPasskey(up.token);
    const asUser = t.withIdentity(up.token);

    const [before] = await asUser.query<PasskeySummary[]>("auth:listPasskeys", {});
    expect(before!.deviceName).toBeNull();

    await asUser.mutation("auth:renamePasskey", { passkeyId: before!.passkeyId, deviceName: "My iPhone" });
    const [after] = await asUser.query<PasskeySummary[]>("auth:listPasskeys", {});
    expect(after!.deviceName).toBe("My iPhone");
  });

  it("renamePasskey / revokePasskey REJECT a foreign passkeyId — ownership (generic 'passkey not found', no cross-user leak)", async () => {
    await setup();
    const alice = await signUp("alice2@x.co");
    const bob = await signUp("bob2@x.co");
    await registerPasskey(alice.token);
    const [aliceKey] = await t.withIdentity(alice.token).query<PasskeySummary[]>("auth:listPasskeys", {});

    // Bob tries to rename/revoke Alice's passkey.
    await expect(
      t.withIdentity(bob.token).mutation("auth:renamePasskey", { passkeyId: aliceKey!.passkeyId, deviceName: "hijacked" }),
    ).rejects.toThrow(/passkey not found/);
    await expect(
      t.withIdentity(bob.token).mutation("auth:revokePasskey", { passkeyId: aliceKey!.passkeyId }),
    ).rejects.toThrow(/passkey not found/);

    // Alice's passkey is untouched — still present, still unnamed.
    const [stillThere] = await t.withIdentity(alice.token).query<PasskeySummary[]>("auth:listPasskeys", {});
    expect(stillThere!.passkeyId).toBe(aliceKey!.passkeyId);
    expect(stillThere!.deviceName).toBeNull();
  });

  it("a REVOKED passkey can no longer authenticate — the credential row is gone, finish generic-rejects", async () => {
    await setup();
    const up = await signUp();
    const { authenticator, credentialId } = await registerPasskey(up.token);

    // Revoke it.
    const [key] = await t.withIdentity(up.token).query<PasskeySummary[]>("auth:listPasskeys", {});
    await t.withIdentity(up.token).mutation("auth:revokePasskey", { passkeyId: key!.passkeyId });
    expect(await t.withIdentity(up.token).query<PasskeySummary[]>("auth:listPasskeys", {})).toEqual([]);

    // A genuine, well-formed assertion for the now-deleted credential is generic-rejected.
    const options = await t.action<PublicKeyCredentialRequestOptionsJSON>("auth:beginPasskeyAuthentication", {});
    const assertion = authenticator.createAssertion({
      challenge: options.challenge,
      rpID: RP_ID,
      origin: ORIGIN,
      credentialId,
      counter: 1,
      userId: up.userId,
    });
    await expect(
      t.action("auth:finishPasskeyAuthentication", actionArgs<{ response: AuthenticationResponseJSON }>({ response: assertion })),
    ).rejects.toThrow(/passkey authentication failed/);
  });

  it("REACTIVE: a subscribed passkey list (byUserId read-set) re-runs when revokePasskey deletes a row", async () => {
    await setup();
    const up = await signUp();
    await registerPasskey(up.token);
    // Register a second credential so the list starts at 2 and we can watch it drop to 1.
    await registerPasskey(up.token, createMockAuthenticator());

    const sub = t.subscribe<Array<{ passkeyId: string; deviceName: string | null }>>("app:listPasskeysFor", {
      userId: up.userId,
    });
    // Let the first compute land.
    await new Promise<void>((resolve) => {
      if (sub.value() !== undefined) return resolve();
      const off = sub.onChange(() => {
        off();
        resolve();
      });
    });
    expect(sub.value()).toHaveLength(2);

    // Revoke one — the subscription must re-run (write set intersects the byUserId read set).
    const [first] = await t.withIdentity(up.token).query<PasskeySummary[]>("auth:listPasskeys", {});
    await new Promise<void>((resolve) => {
      const off = sub.onChange(() => {
        off();
        resolve();
      });
      void t.withIdentity(up.token).mutation("auth:revokePasskey", { passkeyId: first!.passkeyId });
    });
    expect(sub.value()).toHaveLength(1);

    sub.unsubscribe();
  });
});
