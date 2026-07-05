import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { composeComponents, defineComponent } from "@helipod/component";
import { EmbeddedRuntime } from "@helipod/runtime-embedded";
import { defineSchema } from "@helipod/values";
import { query, type QueryCtx } from "@helipod/executor";
import { authSchema } from "../src/schema";
import { authContext } from "../src/context";
import { makeAuthModules } from "../src/functions";
import { makeMfaModules } from "../src/mfa/functions";
import { totpCodeAt, currentStep } from "../src/mfa/totp";
import { normalizeRecoveryCode } from "../src/mfa/recovery";
import { resolveAuthConfig, type AuthOptions } from "../src/config";
import { sha256base64url, type MintResult } from "../src";

// A 32-byte key encoded as base64 — same shape as mfa-config.test.ts's valid single-key source.
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/**
 * Task 5 will wire this EXACT composition (`makeAuthModules` + `makeMfaModules`, iff
 * `config.mfa`) into `component.ts`'s `defineAuth` — until then, this test builds it directly so
 * Task 4's enrollment/management surface can be exercised through the real engine. The component
 * name MUST stay "auth": the mfa tables (`mfaEnrollments`/`mfaChallenges`/`mfaRecoveryCodes`)
 * already live in `authSchema` (Task 3), so `ctx.db.query("mfaEnrollments", ...)` inside
 * `mfa/functions.ts` only resolves against the physical `auth/mfaEnrollments` table if the
 * functions run IN the "auth" component's own namespace.
 */
function defineAuthWithMfa(options: AuthOptions) {
  const config = resolveAuthConfig(options);
  return defineComponent({
    name: "auth",
    schema: authSchema,
    modules: { ...makeAuthModules(config), ...(config.mfa ? makeMfaModules(config) : {}) },
    context: authContext,
    contextType: { import: "@helipod/auth", type: "AuthContext" },
  });
}

// Privileged test-only reads (raw physical table names) — same idiom as email-redeem.test.ts's
// `_readAuthCode`/`_readUser`: trusted-caller-only system modules, no `isInternalPath` gate.
const _readEnrollment = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  const [row] = await ctx.db.query("auth/mfaEnrollments", "byUserId").eq("userId", userId).collect();
  return row ?? null;
});
const _readRecoveryCodes = query(async (ctx: QueryCtx, { userId }: { userId: string }) => {
  return ctx.db.query("auth/mfaRecoveryCodes", "byUserId").eq("userId", userId).collect();
});

async function makeRuntime(authOpts: AuthOptions, now: () => number) {
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: {} },
    [defineAuthWithMfa(authOpts)],
  );
  return EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    contextProviders,
    systemModules: { "_test:readEnrollment": _readEnrollment, "_test:readRecoveryCodes": _readRecoveryCodes },
    now,
  });
}

async function readEnrollment(r: EmbeddedRuntime, userId: string): Promise<Record<string, unknown> | null> {
  return (await r.runSystem<Record<string, unknown> | null>("_test:readEnrollment", { userId })).value;
}
async function readRecoveryCodes(r: EmbeddedRuntime, userId: string): Promise<Array<Record<string, unknown>>> {
  return (await r.runSystem<Array<Record<string, unknown>>>("_test:readRecoveryCodes", { userId })).value;
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

/** The exact live code for `secret` at the harness's fixed `now` (default digits/period). */
function liveCodeFor(secret: string, now: number): string {
  return totpCodeAt(secret, currentStep(now));
}

describe("A4 Task 4: makeMfaModules — enrollment + management + recovery", () => {
  const NOW = 1_700_000_000_000;

  it("startMfaEnrollment stores an ENCRYPTED envelope, never the raw base32 secret", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;

    expect(typeof start.secret).toBe("string");
    expect(start.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(start.digits).toBe(6);
    expect(start.period).toBe(30);
    expect(start.algorithm).toBe("SHA1");

    const row = await readEnrollment(r, up.userId);
    expect(row).not.toBeNull();
    expect(row!.secretEncrypted).not.toBe(start.secret); // never stored raw
    expect(String(row!.secretEncrypted)).toMatch(/^v1\.1\./); // envelope shape, keyId "1"
    expect(row!.confirmedAt).toBeUndefined(); // inert until confirmed
  });

  it("sign-in is NOT gated pre-confirm (Task 5 wires the gate) — an unconfirmed enrollment still mints normally", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token });

    const inRes = (await r.run<MintResult>("auth:signIn", { email: "a@b.co", password: "pw" })).value;
    expect(typeof inRes.token).toBe("string");
    expect(typeof inRes.userId).toBe("string");
  });

  it("a wrong confirm code leaves confirmedAt unset (enrollment stays inert)", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token });

    await expect(r.run("auth:confirmMfaEnrollment", { code: "000000" }, { identity: up.token })).rejects.toThrow(/invalid code/i);
    const row = await readEnrollment(r, up.userId);
    expect(row!.confirmedAt).toBeUndefined();
  });

  it("a valid confirm activates the enrollment and returns 10 recovery codes, hashed at rest", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;

    const confirm = (
      await r.run<ConfirmResult>("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, NOW) }, { identity: up.token })
    ).value;
    expect(confirm.recoveryCodes).toHaveLength(10);
    expect(new Set(confirm.recoveryCodes).size).toBe(10); // all distinct

    const row = await readEnrollment(r, up.userId);
    expect(row!.confirmedAt).toBe(NOW);
    expect(row!.lastUsedStep).toBe(currentStep(NOW));

    const codeRows = await readRecoveryCodes(r, up.userId);
    expect(codeRows).toHaveLength(10);
    for (const codeRow of codeRows) {
      expect(confirm.recoveryCodes).not.toContain(codeRow.codeHash); // never the raw code
      // Review fix: the persisted hash is over the NORMALIZED code (dashes stripped, uppercased),
      // not the raw dashed display string — see `normalizeRecoveryCode`'s doc comment.
      expect(confirm.recoveryCodes.some((raw) => sha256base64url(normalizeRecoveryCode(raw)) === codeRow.codeHash)).toBe(true);
    }
  });

  it("startMfaEnrollment on a CONFIRMED enrollment throws MFA_ALREADY_ENROLLED", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    await r.run("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, NOW) }, { identity: up.token });

    await expect(r.run("auth:startMfaEnrollment", {}, { identity: up.token })).rejects.toThrow("MFA_ALREADY_ENROLLED");
  });

  it("re-starting overwrites a prior UNCONFIRMED enrollment (a stale secret can never be confirmed)", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const first = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    const second = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    expect(second.secret).not.toBe(first.secret);

    // Only ONE enrollment row exists (byUserId), and it's the SECOND secret.
    const row = await readEnrollment(r, up.userId);
    expect(row).not.toBeNull();

    // The stale first secret's code can never confirm — only the second (current) row remains.
    await expect(
      r.run("auth:confirmMfaEnrollment", { code: liveCodeFor(first.secret, NOW) }, { identity: up.token }),
    ).rejects.toThrow(/invalid code/i);
    await r.run("auth:confirmMfaEnrollment", { code: liveCodeFor(second.secret, NOW) }, { identity: up.token });
    expect((await readEnrollment(r, up.userId))!.confirmedAt).toBe(NOW);
  });

  it("MFA_NOT_ENROLLED: confirm/disable/regenerate all reject with no enrollment present", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    await expect(r.run("auth:confirmMfaEnrollment", { code: "123456" }, { identity: up.token })).rejects.toThrow("MFA_NOT_ENROLLED");
    await expect(r.run("auth:disableMfa", { code: "123456" }, { identity: up.token })).rejects.toThrow("MFA_NOT_ENROLLED");
    await expect(r.run("auth:regenerateRecoveryCodes", { code: "123456" }, { identity: up.token })).rejects.toThrow(
      "MFA_NOT_ENROLLED",
    );
  });

  describe("once confirmed", () => {
    async function enrolled(r: EmbeddedRuntime, token: string, now: number): Promise<{ secret: string; recoveryCodes: string[] }> {
      const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: token })).value;
      const confirm = (await r.run<ConfirmResult>("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, now) }, { identity: token }))
        .value;
      return { secret: start.secret, recoveryCodes: confirm.recoveryCodes };
    }

    it("replay guard: the same TOTP code accepted once is rejected on immediate re-presentation", async () => {
      const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
      const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
      const { secret } = await enrolled(r, up.token, NOW);

      // confirmMfaEnrollment already consumed this step's code (advanced lastUsedStep) — the SAME
      // code presented again to regenerateRecoveryCodes (also TOTP-checked) must be rejected.
      await expect(
        r.run("auth:regenerateRecoveryCodes", { code: liveCodeFor(secret, NOW) }, { identity: up.token }),
      ).rejects.toThrow(/invalid code/i);
    });

    it("recovery codes are consume-once: a used code fails on replay", async () => {
      const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
      const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
      const { recoveryCodes } = await enrolled(r, up.token, NOW);
      const usedCode = recoveryCodes[0]!;

      // A recovery code passes disableMfa's re-auth gate exactly once.
      await r.run("auth:disableMfa", { code: usedCode }, { identity: up.token });
      expect(await readEnrollment(r, up.userId)).toBeNull();
    });

    it("recovery code consumed by one call cannot be reused by a second call", async () => {
      const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
      const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
      const { recoveryCodes } = await enrolled(r, up.token, NOW);
      const usedCode = recoveryCodes[0]!;
      const rowsBefore = await readRecoveryCodes(r, up.userId);
      expect(rowsBefore).toHaveLength(10);

      // regenerateRecoveryCodes requires a TOTP (not a recovery code) — so a recovery code presented
      // to it is simply an invalid credential, and MUST NOT be consumed as a side effect.
      await expect(r.run("auth:regenerateRecoveryCodes", { code: usedCode }, { identity: up.token })).rejects.toThrow(/invalid code/i);
      const rowsAfter = await readRecoveryCodes(r, up.userId);
      expect(rowsAfter).toHaveLength(10); // untouched — the recovery code was never consumed
    });

  });

  it("regenerateRecoveryCodes (a mutable-clock runtime): requires a valid TOTP, invalidates the old set", async () => {
    let now = 1_700_000_000_000;
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => now);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    const confirm = (
      await r.run<ConfirmResult>("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, now) }, { identity: up.token })
    ).value;
    const oldCodes = confirm.recoveryCodes;

    now += 30_000; // advance one full TOTP period so a fresh step is presentable (replay guard)
    const regen = (
      await r.run<ConfirmResult>("auth:regenerateRecoveryCodes", { code: liveCodeFor(start.secret, now) }, { identity: up.token })
    ).value;
    expect(regen.recoveryCodes).toHaveLength(10);
    expect(regen.recoveryCodes.some((c) => oldCodes.includes(c))).toBe(false); // wholly new set

    const rows = await readRecoveryCodes(r, up.userId);
    expect(rows).toHaveLength(10);
    const newHashes = new Set(rows.map((row) => row.codeHash));
    for (const oldCode of oldCodes) expect(newHashes.has(sha256base64url(oldCode))).toBe(false); // old set gone

    // An old (now-invalidated) recovery code no longer works as a second factor.
    await expect(r.run("auth:disableMfa", { code: oldCodes[0]! }, { identity: up.token })).rejects.toThrow(/invalid code/i);
  });

  it("disableMfa requires a valid factor, removes the enrollment + ALL recovery codes, and un-gates re-enrollment", async () => {
    let now = 1_700_000_000_000;
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => now);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    await r.run("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, now) }, { identity: up.token });

    // Wrong code rejects, without disabling anything.
    await expect(r.run("auth:disableMfa", { code: "000000" }, { identity: up.token })).rejects.toThrow(/invalid code/i);
    expect(await readEnrollment(r, up.userId)).not.toBeNull();

    now += 30_000; // fresh TOTP step (the confirm above already consumed `now`'s step)
    await r.run("auth:disableMfa", { code: liveCodeFor(start.secret, now) }, { identity: up.token });
    expect(await readEnrollment(r, up.userId)).toBeNull();
    expect(await readRecoveryCodes(r, up.userId)).toHaveLength(0);

    // Re-enrollment is possible again (no lingering ALREADY_ENROLLED).
    const restart = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    expect(typeof restart.secret).toBe("string");
  });

  it("getMfaStatus reports enrolled/confirmed/recoveryCodesRemaining and decrements on consume", async () => {
    let now = 1_700_000_000_000;
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => now);
    const up = (await r.run<MintResult>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const before = (await r.run("auth:getMfaStatus", {}, { identity: up.token })).value as {
      enrolled: boolean;
      confirmed: boolean;
      recoveryCodesRemaining: number;
    };
    expect(before).toEqual({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0 });

    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    const midway = (await r.run("auth:getMfaStatus", {}, { identity: up.token })).value as { enrolled: boolean; confirmed: boolean };
    expect(midway.enrolled).toBe(true);
    expect(midway.confirmed).toBe(false);

    await r.run("auth:confirmMfaEnrollment", { code: liveCodeFor(start.secret, now) }, { identity: up.token });
    const after = (await r.run("auth:getMfaStatus", {}, { identity: up.token })).value as {
      enrolled: boolean;
      confirmed: boolean;
      recoveryCodesRemaining: number;
    };
    expect(after).toEqual({ enrolled: true, confirmed: true, recoveryCodesRemaining: 10 });
  });

  it("every A4 function requires an authenticated caller", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    await expect(r.run("auth:startMfaEnrollment", {}, { identity: null })).rejects.toThrow(/not authenticated/i);
    await expect(r.run("auth:getMfaStatus", {}, { identity: null })).rejects.toThrow(/not authenticated/i);
  });

  it("review fix: an ANONYMOUS caller cannot enroll — startMfaEnrollment rejects MFA_ANONYMOUS_NOT_ALLOWED, no enrollment row is created", async () => {
    const r = await makeRuntime({ mfa: { encryptionKey: TEST_KEY } }, () => NOW);
    const anon = (await r.run<MintResult>("auth:signInAnonymously", {})).value;

    await expect(r.run("auth:startMfaEnrollment", {}, { identity: anon.token })).rejects.toThrow(
      "MFA_ANONYMOUS_NOT_ALLOWED",
    );
    expect(await readEnrollment(r, anon.userId)).toBeNull();

    // A non-anonymous (real, password) user is unaffected by the guard.
    const up = (await r.run<MintResult>("auth:signUp", { email: "not-anon@b.co", password: "pw" })).value;
    const start = (await r.run<StartResult>("auth:startMfaEnrollment", {}, { identity: up.token })).value;
    expect(typeof start.secret).toBe("string");
  });
});
