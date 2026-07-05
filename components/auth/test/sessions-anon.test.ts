import { describe, it, expect } from "vitest";
import { query } from "@helipod/executor";
import { createTestHelipod, type TestHelipod } from "@helipod/test";
import { defineAuth, type MintResult, type SessionSummary } from "../src";

const appModules = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  whoami: { get: query(async (ctx: any) => ctx.auth.getUserId() as Promise<string | null>) },
};

async function harness(opts?: Parameters<typeof defineAuth>[0]): Promise<TestHelipod> {
  return createTestHelipod({ modules: appModules, components: [defineAuth(opts)], schema: false });
}

describe("auth A1: session management + anonymous", () => {
  it("listSessions returns the user's sessions with a `current` flag and NO hash material", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw", deviceLabel: "Chrome" })) as MintResult;
      // A second device: sign in again → a second session for the same user.
      const b = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw", deviceLabel: "Firefox" })) as MintResult;
      const list = (await t.withIdentity(a.token).query("auth:listSessions")) as SessionSummary[];
      expect(list.length).toBe(2);
      expect(list.every((s) => !("tokenHash" in s) && !("refreshTokenHash" in s) && !("token" in s))).toBe(true);
      const cur = list.find((s) => s.current);
      expect(cur?.sessionId).toBe(a.sessionId);
      expect(list.find((s) => s.sessionId === b.sessionId)?.current).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("revokeSession ownership: cannot revoke another user's session; can revoke own", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:signUp", { email: "b@b.co", password: "pw" })) as MintResult;
      // A tries to revoke B's session → rejected.
      await expect(t.withIdentity(a.token).mutation("auth:revokeSession", { sessionId: b.sessionId })).rejects.toThrow(/not found/i);
      // B revokes its own → the session stops resolving.
      await t.withIdentity(b.token).mutation("auth:revokeSession", { sessionId: b.sessionId });
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("revokeOtherSessions keeps the current session, kills the rest", async () => {
    const t = await harness();
    try {
      const a = (await t.mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      const b = (await t.mutation("auth:signIn", { email: "a@b.co", password: "pw" })) as MintResult;
      await t.withIdentity(a.token).mutation("auth:revokeOtherSessions");
      expect(await t.query("auth:getUserId", { token: a.token })).toBe(a.userId); // current survives
      expect(await t.query("auth:getUserId", { token: b.token })).toBeNull();     // other gone
    } finally {
      await t.close();
    }
  });

  it("signInAnonymously creates a real anonymous user; rejects a caller who is already authed (adapted from better-auth anon.test.ts:394)", async () => {
    const t = await harness();
    try {
      const anon = (await t.mutation("auth:signInAnonymously", { deviceLabel: "Safari" })) as MintResult;
      expect(await t.query("auth:getUserId", { token: anon.token })).toBe(anon.userId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (await t.run(async (ctx: any) => ctx.db.get(anon.userId))) as Record<string, unknown> | null;
      expect(user?.anonymous).toBe(true);
      expect(user?.email).toBeUndefined();
      // Already authed → reject.
      await expect(t.withIdentity(anon.token).mutation("auth:signInAnonymously", {})).rejects.toThrow(/already authenticated/i);
    } finally {
      await t.close();
    }
  });

  it("anonymous global throttle trips at the cap and recovers after the window (spec §12)", async () => {
    const t = await harness({ anonymousSignInsPerMinute: 2 });
    try {
      await t.mutation("auth:signInAnonymously", {});
      await t.mutation("auth:signInAnonymously", {});
      await expect(t.mutation("auth:signInAnonymously", {})).rejects.toThrow(/ANONYMOUS_THROTTLED/);
      await t.advanceTimers(61_000);                 // next window
      const ok = (await t.mutation("auth:signInAnonymously", {})) as MintResult;
      expect(typeof ok.token).toBe("string");
    } finally {
      await t.close();
    }
  });

  it("upgrade: signUp while holding an anonymous session preserves userId, clears the flag, replaces sessions", async () => {
    const t = await harness();
    try {
      const anon = (await t.mutation("auth:signInAnonymously", {})) as MintResult;
      // A row written while anonymous — proven to survive via userId continuity below.
      const upgraded = (await t.withIdentity(anon.token).mutation("auth:signUp", { email: "a@b.co", password: "pw" })) as MintResult;
      expect(upgraded.userId).toBe(anon.userId);      // SAME user id
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const user = (await t.run(async (ctx: any) => ctx.db.get(anon.userId))) as Record<string, unknown> | null;
      expect(user?.anonymous).toBeUndefined();        // flag cleared
      expect(user?.email).toBe("a@b.co");
      // The anonymous session was deleted (credential boundary); the fresh one resolves.
      expect(await t.query("auth:getUserId", { token: anon.token })).toBeNull();
      expect(await t.query("auth:getUserId", { token: upgraded.token })).toBe(anon.userId);
    } finally {
      await t.close();
    }
  });
});
