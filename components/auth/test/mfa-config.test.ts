import { describe, it, expect } from "vitest";
import { resolveAuthConfig, resolveMfaConfig } from "../src/config";
import { authSchema } from "../src/schema";
import { defineSchema, defineTable, v } from "@stackbase/values";

// A 32-byte key encoded as base64 (standard) — a valid single-key source.
const VALID_KEY_B64 = Buffer.alloc(32, 7).toString("base64");
// The same 32 bytes encoded as hex — the other accepted encoding.
const VALID_KEY_HEX = Buffer.alloc(32, 7).toString("hex");
// A 16-byte key — deliberately the wrong length.
const SHORT_KEY_B64 = Buffer.alloc(16, 9).toString("base64");

describe("resolveMfaConfig", () => {
  it("builds a one-entry keyring + defaults from a single valid base64 encryptionKey", () => {
    const mfa = resolveMfaConfig({ encryptionKey: VALID_KEY_B64 });
    expect(mfa.keyring).toHaveLength(1);
    expect(mfa.keyring[0]!.id).toBe("1");
    expect(mfa.keyring[0]!.key.length).toBe(32);
    expect(mfa.keyring[0]!.key.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(mfa.issuer).toBe("Stackbase");
    expect(mfa.recoveryCodeCount).toBe(10);
    expect(mfa.challengeTtlMs).toBe(5 * 60 * 1000);
    expect(mfa.mfaAttempts).toBe(5);
    expect(mfa.window).toBe(1);
    expect(mfa.algorithm).toBe("SHA1");
    expect(mfa.digits).toBe(6);
    expect(mfa.period).toBe(30);
  });

  it("accepts a valid hex-encoded encryptionKey", () => {
    const mfa = resolveMfaConfig({ encryptionKey: VALID_KEY_HEX });
    expect(mfa.keyring[0]!.key.equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it("respects explicit overrides", () => {
    const mfa = resolveMfaConfig({
      encryptionKey: VALID_KEY_B64,
      issuer: "Acme",
      recoveryCodeCount: 12,
      challengeTtlMs: 60_000,
      mfaAttempts: 3,
      window: 2,
    });
    expect(mfa.issuer).toBe("Acme");
    expect(mfa.recoveryCodeCount).toBe(12);
    expect(mfa.challengeTtlMs).toBe(60_000);
    expect(mfa.mfaAttempts).toBe(3);
    expect(mfa.window).toBe(2);
  });

  it("builds an ordered keyring from encryptionKeys, preserving [0] as primary", () => {
    const keyA = Buffer.alloc(32, 1).toString("base64");
    const keyB = Buffer.alloc(32, 2).toString("base64");
    const mfa = resolveMfaConfig({
      encryptionKeys: [
        { id: "2", key: keyA },
        { id: "1", key: keyB },
      ],
    });
    expect(mfa.keyring.map((k) => k.id)).toEqual(["2", "1"]);
    expect(mfa.keyring[0]!.key.equals(Buffer.alloc(32, 1))).toBe(true);
    expect(mfa.keyring[1]!.key.equals(Buffer.alloc(32, 2))).toBe(true);
  });

  it("throws when neither encryptionKey nor encryptionKeys is present", () => {
    expect(() => resolveMfaConfig({})).toThrow(
      /defineAuth\(\{ mfa \}\) requires a 32-byte encryptionKey or encryptionKeys/,
    );
  });

  it("throws on a too-short key (fails fast, not at first use)", () => {
    expect(() => resolveMfaConfig({ encryptionKey: SHORT_KEY_B64 })).toThrow();
  });
});

describe("resolveAuthConfig({ mfa })", () => {
  it("mfa absent -> config.mfa is undefined (byte-identical to pre-MFA)", () => {
    const config = resolveAuthConfig({});
    expect(config.mfa).toBeUndefined();
  });

  it("mfa present with a valid key -> config.mfa is a resolved MfaConfig", () => {
    const config = resolveAuthConfig({ mfa: { encryptionKey: VALID_KEY_B64 } });
    expect(config.mfa).toBeDefined();
    expect(config.mfa!.keyring).toHaveLength(1);
    expect(config.mfa!.recoveryCodeCount).toBe(10);
  });

  it("FAILS FAST: mfa configured with no key throws out of resolveAuthConfig itself", () => {
    expect(() => resolveAuthConfig({ mfa: {} })).toThrow(
      /defineAuth\(\{ mfa \}\) requires a 32-byte encryptionKey or encryptionKeys/,
    );
  });

  it("FAILS FAST: mfa configured with a 16-byte key throws out of resolveAuthConfig itself", () => {
    expect(() => resolveAuthConfig({ mfa: { encryptionKey: SHORT_KEY_B64 } })).toThrow();
  });
});

// Task 3 TDD step 3: the three new tables must pass the additive-deploy gate — new tables are
// always accepted (no existing data to violate); the real invariant here is that adding them
// leaves every PRE-EXISTING table's shape (and therefore its would-be tableNumber assignment)
// completely untouched. This mirrors the rule in packages/cli/src/schema-diff.ts (`diffSchema`)
// without a cross-package dependency from a component onto the CLI: components never depend on
// packages/cli, so the check below reimplements just the "existing tables are unchanged" half of
// that gate directly against the real `authSchema`.
describe("MFA schema additivity", () => {
  // The pre-MFA table set, exactly as `authSchema` defined it before this task (spec "Schema":
  // "no changes to users, accounts, sessions, authCodes, authCounters, oauthState, oauthHandoff").
  const preMfaSchema = defineSchema({
    users: defineTable({
      email: v.optional(v.string()),
      anonymous: v.optional(v.boolean()),
      emailVerified: v.optional(v.boolean()),
    }).index("byEmail", ["email"]),
    accounts: defineTable({
      userId: v.id("users"),
      provider: v.string(),
      accountId: v.string(),
      secret: v.string(),
      failedAttempts: v.number(),
      lockedUntil: v.number(),
    }).index("byAccount", ["provider", "accountId"]),
    sessions: defineTable({
      userId: v.id("users"),
      token: v.optional(v.string()),
      tokenHash: v.optional(v.string()),
      expiresAt: v.number(),
      refreshTokenHash: v.optional(v.string()),
      prevRefreshTokenHash: v.optional(v.string()),
      refreshExpiresAt: v.optional(v.number()),
      absoluteExpiresAt: v.optional(v.number()),
      deviceLabel: v.optional(v.string()),
      createdAt: v.optional(v.number()),
      lastRefreshAt: v.optional(v.number()),
    })
      .index("byToken", ["token"])
      .index("byTokenHash", ["tokenHash"])
      .index("byRefreshTokenHash", ["refreshTokenHash"])
      .index("byPrevRefreshTokenHash", ["prevRefreshTokenHash"])
      .index("byUserId", ["userId"]),
    authCounters: defineTable({ name: v.string(), windowStart: v.number(), count: v.number() }).index("byName", [
      "name",
    ]),
    authCodes: defineTable({
      email: v.string(),
      flow: v.string(),
      codeHash: v.string(),
      expiresAt: v.number(),
      attempts: v.number(),
      createdAt: v.number(),
    }).index("byEmailFlow", ["email", "flow"]),
    oauthState: defineTable({
      stateHash: v.string(),
      provider: v.string(),
      codeVerifier: v.string(),
      nonce: v.optional(v.string()),
      redirectTo: v.string(),
      linkUserId: v.optional(v.id("users")),
      expiresAt: v.number(),
      createdAt: v.number(),
    }).index("byStateHash", ["stateHash"]),
    oauthHandoff: defineTable({
      handoffHash: v.string(),
      userId: v.id("users"),
      deviceLabelHint: v.optional(v.string()),
      expiresAt: v.number(),
      createdAt: v.number(),
    }).index("byHandoffHash", ["handoffHash"]),
  });

  it("adds exactly three new tables (mfaEnrollments, mfaChallenges, mfaRecoveryCodes)", () => {
    const before = new Set(Object.keys(preMfaSchema.export().tables));
    const after = new Set(Object.keys(authSchema.export().tables));
    const added = [...after].filter((name) => !before.has(name));
    expect(added.sort()).toEqual(["mfaChallenges", "mfaEnrollments", "mfaRecoveryCodes"]);
  });

  it("leaves every pre-existing table's document shape byte-identical (the additive-gate invariant)", () => {
    const before = preMfaSchema.export().tables;
    const after = authSchema.export().tables;
    for (const name of Object.keys(before)) {
      expect(after[name]).toBeDefined();
      expect(after[name]!.documentType).toEqual(before[name]!.documentType);
      expect(after[name]!.indexes).toEqual(before[name]!.indexes);
    }
  });
});
