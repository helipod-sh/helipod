import { describe, it, expect } from "vitest";
import { query } from "@stackbase/executor";
import { createTestStackbase, type TestStackbase } from "@stackbase/test";
import { defineAuth, type MintResult } from "../src";

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

// Harness with the harness-owned virtual clock (omit `now`) so `t.advanceTimers` moves auth time.
async function harness(opts?: Parameters<typeof defineAuth>[0]): Promise<TestStackbase> {
  return createTestStackbase({ modules: appModules, components: [defineAuth(opts)], schema: false });
}

const GRACE = 30_000;
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000;

describe("auth A1: refresh rotation + reuse detection", () => {
  it("rotates in place: same sessionId, fresh usable pair, old access token stops resolving", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.advanceTimers(1000);
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      expect(b.sessionId).toBe(a.sessionId);          // SAME session row (rotation in place)
      expect(b.token).not.toBe(a.token);
      expect(b.refreshToken).not.toBe(a.refreshToken);
      // The new access token resolves; identity continuity holds.
      expect(await t.query("auth:getUserId", { token: b.token })).toBe(a.userId);
      // The old access token no longer resolves (its hash was overwritten).
      expect(await t.query("auth:getUserId", { token: a.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("reuse INSIDE grace returns REFRESH_STALE without revoking (adapted-by-inversion from convex-auth sessions.test.ts \"refresh token reuse with racing requests\")", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      await t.advanceTimers(GRACE - 5000);            // within the 30s window
      // Presenting the OLD refresh token again (== prevRefreshTokenHash) inside grace → soft error.
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_STALE/);
      // NOT revoked: the winner's current pair (b) still works.
      const c = (await t.mutation("auth:refresh", { refreshToken: b.refreshToken })) as MintResult;
      expect(c.sessionId).toBe(a.sessionId);
    } finally {
      await t.close();
    }
  });

  it("DIVERGENCE PIN — reuse OUTSIDE grace kills the WHOLE session (opposite of convex-auth sessions.test.ts \"refresh token invalidate subtree\"): NO surviving usable token after theft", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:refresh", { refreshToken: a.refreshToken })) as MintResult;
      await t.advanceTimers(GRACE + 5000);            // past the window
      // Presenting the stolen OLD refresh token outside grace → REFRESH_REUSED, and the session row
      // is DELETED (commit-then-throw), so the throw is surfaced AFTER the revocation commits.
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_REUSED/);
      // Whole-session death: the winner's still-current token `b` is now ALSO dead — unlike convex-auth,
      // where the untouched sibling would survive. Nobody "fixes" this toward subtree survival.
      await expect(t.mutation("auth:refresh", { refreshToken: b.refreshToken })).rejects.toThrow(/invalid refresh token/);
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await t.run(async (ctx: any) => ctx.db.query("auth/sessions", "by_creation").collect())) as unknown[];
      expect(rows.length).toBe(0);                    // the family (the one row) is gone
    } finally {
      await t.close();
    }
  });

  it("DIVERGENCE PIN — the racing loser gets REFRESH_STALE, NEVER a fresh usable pair (opposite of convex-auth fork/replay; foreclosed by hashed-at-rest)", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.mutation("auth:refresh", { refreshToken: a.refreshToken });
      await t.advanceTimers(1000);                    // still within grace
      // The loser's replay resolves to a THROW, not a MintResult — assert the shape by catching.
      let threw: unknown;
      try {
        await t.mutation("auth:refresh", { refreshToken: a.refreshToken });
      } catch (e) {
        threw = e;
      }
      expect(threw).toBeInstanceOf(Error);
      expect(String((threw as Error).message)).toContain("REFRESH_STALE");
    } finally {
      await t.close();
    }
  });

  it("expired refresh past the sliding window → REFRESH_EXPIRED (adapted from convex-auth sessions.test.ts \"refresh token expiration\")", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.advanceTimers(REFRESH_TTL + 60_000);    // past refreshExpiresAt
      await expect(t.mutation("auth:refresh", { refreshToken: a.refreshToken })).rejects.toThrow(/REFRESH_EXPIRED/);
    } finally {
      await t.close();
    }
  });

  // Final-review fix wave: pins the whole-branch review's legacy-seam analysis — a legacy pre-A1
  // session row `{ userId, token, expiresAt }` carries no `refreshTokenHash`/`prevRefreshTokenHash`
  // at all, so presenting its raw (unhashed) `token` to `auth:refresh` can never match either the
  // current- or reuse-detection lookup; it must fall through to the plain "invalid refresh token"
  // rejection — never a minted pair (there is nothing hashed to rotate) and never a crash on a
  // missing field.
  it("a legacy pre-A1 row's raw token, presented to auth:refresh, plainly fails — never mints, never crashes", async () => {
    const t = await harness();
    try {
      const r = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const legacyToken = "legacy-raw-token-refresh-pin";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await t.run(async (ctx: any) => {
        await ctx.db.insert("auth/sessions", { userId: r.userId, token: legacyToken, expiresAt: ctx.now() + 60_000 });
      });
      await expect(t.mutation("auth:refresh", { refreshToken: legacyToken })).rejects.toThrow(/invalid refresh token/);
    } finally {
      await t.close();
    }
  });

  it("absolute ceiling: an actively-refreshing session still dies at absoluteExpiresAt (spec decision 11)", async () => {
    // 90d ceiling; keep refreshing every ~29d so the sliding window never lapses — the absolute cap
    // must still terminate the session.
    const t = await harness({ sessionTotalTtlMs: 90 * 24 * 60 * 60 * 1000 });
    try {
      let cur = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const step = 29 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < 3; i++) {                   // ~87d of active refreshing — under the ceiling
        await t.advanceTimers(step);
        cur = (await t.mutation("auth:refresh", { refreshToken: cur.refreshToken })) as MintResult;
      }
      await t.advanceTimers(step);                    // now ~116d total — PAST the 90d ceiling
      await expect(t.mutation("auth:refresh", { refreshToken: cur.refreshToken })).rejects.toThrow(/REFRESH_EXPIRED/);
    } finally {
      await t.close();
    }
  });
});
