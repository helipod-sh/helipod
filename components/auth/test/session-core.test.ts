import { describe, it, expect } from "vitest";
import { query } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, sha256base64url, type MintResult } from "../src"; // auth's own tests import via src (existing idiom — no dist rebuild needed)

// A protected query proving `ctx.auth` resolves the ambient identity (used for the legacy-fallback
// resolution check). `ctx` is `any` here to avoid leaking internal ctx types.
const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

async function harness(): Promise<TestStackbase> {
  return createTestStackbase({ modules: appModules, components: [defineAuth()], schema: false });
}

describe("auth A1: session model core", () => {
  it("signUp mints a hashed pair (token/refreshToken/sessionId/expiresAt/userId)", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(typeof r.token).toBe("string");
      expect(typeof r.refreshToken).toBe("string");
      expect(typeof r.sessionId).toBe("string");
      expect(typeof r.userId).toBe("string");
      expect(r.token).not.toEqual(r.refreshToken);
      expect(typeof r.expiresAt).toBe("number");
    } finally {
      await t.close();
    }
  });

  it("stores tokens hashed at rest — no raw token appears in any session row", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "by_creation").collect())) as Array<Record<string, unknown>>;
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.token).toBeUndefined();                       // new mints never store the raw token
      expect(row.tokenHash).toBe(sha256base64url(r.token));    // stored as SHA-256/base64url
      expect(row.refreshTokenHash).toBe(sha256base64url(r.refreshToken));
      expect(row.tokenHash).not.toBe(r.token);                 // hash != raw
      expect(typeof row.absoluteExpiresAt).toBe("number");     // ceiling recorded at mint
      expect(row.lastRefreshAt).toBe(row.createdAt);           // set at mint
    } finally {
      await t.close();
    }
  });

  it("resolves a live token and null after signOut; accepts both new and legacy token shapes", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(await t.query("auth:getUserId", { token: r.token })).toBe(r.userId);
      await t.mutation("auth:signOut", { token: r.token });
      expect(await t.query("auth:getUserId", { token: r.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("legacy fallback: a pre-A1 row { userId, token, expiresAt } still resolves via byToken", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const legacyToken = "legacy-raw-token-xyz";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await t.run(async (ctx: any) => {
        await ctx.db.insert("auth/sessions", { userId: r.userId, token: legacyToken, expiresAt: ctx.now() + 60_000 });
      });
      // Resolves through ctx.auth (context.ts legacy path) AND the auth:getUserId module.
      expect(await t.withIdentity(legacyToken).query("whoami:get")).toBe(r.userId);
      expect(await t.query("auth:getUserId", { token: legacyToken })).toBe(r.userId);
    } finally {
      await t.close();
    }
  });

  it("signIn verifies the password (fresh pair, same userId) and rejects a wrong one", async () => {
    const t = await harness();
    try {
      const up = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const inR = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(inR.userId).toBe(up.userId);
      expect(inR.token).not.toBe(up.token);
      await expect(t.mutation("auth:signIn", { email: "a@b.co", password: "WRONG" })).rejects.toThrow(/invalid credentials/i);
    } finally {
      await t.close();
    }
  });
});
