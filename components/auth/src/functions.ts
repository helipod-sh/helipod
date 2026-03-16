import { mutation, query, action, commitThenThrow, type ActionCtx, type ComponentContext, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";
import { generateOtp, generateLinkToken, isTokenFlow } from "./email/codes";
import type { Flow } from "./email/templates";
import {
  RefreshStaleError,
  RefreshExpiredError,
  AnonymousThrottledError,
  EmailNotConfiguredError,
  EmailCooldownError,
  EmailThrottledError,
} from "./errors";

export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

interface Creds { email: string; password: string; deviceLabel?: string }

/** The mint result every sign-in path returns (spec "Internal chokepoint"). A superset of the pre-A1
 *  `{ token, userId }`, so existing callers keep working. */
export interface MintResult {
  token: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
  expiresAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Drop keys whose value is `undefined` — the syscall codec (`convexToJson`, see
 *  `GuestDatabaseWriter.insert/replace`) rejects `undefined`; omit rather than null it out.
 *  Same shape as `components/scheduler/src/facade.ts`'s `compact` (typed identically so the result
 *  stays assignable wherever the input was). */
function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Any ctx with a writable `db` and deterministic `now()` — a mutation ctx or the component cctx.
 *  Kept structural so `mintSession` is callable from both the app-facing `MutationCtx` and internal
 *  helpers. */
type WriteCtx = { db: MutationCtx["db"]; now(): number };

/** THE single internal chokepoint (spec decision + "Internal chokepoint"): generate both raw tokens,
 *  store ONLY hashes, return the raw pair to the caller. `signUp`/`signIn`/`signInAnonymously`/
 *  `refresh` (and A2/A3 flows) all mint through here. NOT a public module. */
export async function mintSession(
  ctx: WriteCtx,
  config: AuthConfig,
  userId: string,
  deviceLabel?: string,
): Promise<MintResult> {
  const token = generateToken();
  const refreshToken = generateToken();
  const now = ctx.now();
  const expiresAt = now + config.accessTtlMs;
  const sessionId = (await ctx.db.insert(
    "sessions",
    compact({
      userId,
      tokenHash: sha256base64url(token),
      expiresAt,
      refreshTokenHash: sha256base64url(refreshToken),
      refreshExpiresAt: now + config.refreshTtlMs,
      absoluteExpiresAt: now + config.sessionTotalTtlMs,
      deviceLabel,
      createdAt: now,
      lastRefreshAt: now,
    }),
  )) as string;
  return { token, refreshToken, sessionId, userId, expiresAt };
}

/** Resolve a presented ACCESS token to its live session row: `byTokenHash` first, legacy `byToken`
 *  fallback for pre-A1 rows (spec "Legacy compatibility"). Returns the row (regardless of expiry —
 *  callers check `expiresAt`) or null. Reads land in the read-set, so revocation stays reactive. */
export async function resolveSession(
  db: ComponentContext["db"],
  token: string,
): Promise<Record<string, unknown> | null> {
  const tokenHash = sha256base64url(token);
  const [byHash] = await db.query("sessions", "byTokenHash").eq("tokenHash", tokenHash).collect();
  if (byHash) return byHash as Record<string, unknown>;
  const [legacy] = await db.query("sessions", "byToken").eq("token", token).collect();
  return (legacy as Record<string, unknown>) ?? null;
}

/** A session as surfaced to `listSessions` — NEVER any hash/token material (spec "Component surface"). */
export interface SessionSummary {
  sessionId: string;
  deviceLabel: string | null;
  createdAt: number | null;
  lastRefreshAt: number | null;
  current: boolean;
}

/** The `ctx.auth` facade as visible from inside auth's own modules (context providers are attached
 *  to every function's ctx — including a component's own). Absent when no providers were composed
 *  (bare EmbeddedRuntime unit setups) → treated as unauthenticated. */
type FacadeCtx = { db: MutationCtx["db"] | QueryCtx["db"]; auth?: { getSessionId(): Promise<string | null> } };

/** The ambient caller's own session row, or null when unauthenticated/expired. Resolves the id via
 *  the `ctx.auth` facade (the only channel the ambient identity reaches user code), then reads the
 *  row through the module's own db so the read lands in the calling function's read-set. */
async function currentSessionOf(ctx: FacadeCtx): Promise<Record<string, unknown> | null> {
  const sessionId = await ctx.auth?.getSessionId();
  if (!sessionId) return null;
  return ((await ctx.db.get(sessionId)) as Record<string, unknown> | null) ?? null;
}

/** Build the auth module set closing over `config`. `defineAuth` calls this (spec decision 10). */
export function makeAuthModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult> => {
    const normEmail = normalizeEmail(email);
    // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
    const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (existing.length > 0) throw new Error("an account with that email already exists");

    // Upgrade path (spec §8 / "Component surface"): if the caller currently holds an ANONYMOUS
    // session, attach the email+password account to that SAME userId, clear `anonymous`, and delete
    // ALL of that user's sessions (an upgrade is a credential boundary), then mint fresh. Every row
    // the anonymous user created survives (same userId). This is the in-place upgrade convex-auth
    // leaves to userland and better-auth implements by minting a NEW userId + copy-callback.
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    let userId: string;
    if (current) {
      const user = await ctx.db.get(current.userId as string);
      if (user && user.anonymous === true) {
        userId = current.userId as string;
        // `compact` strips `anonymous: undefined` — omitting the key is what clears the flag
        // (the syscall codec rejects `undefined` values).
        await ctx.db.replace(userId, compact({ ...user, email: normEmail, anonymous: undefined }));
        // Delete ALL of the user's sessions via the `byUserId` range (an upgrade is a credential
        // boundary) — never a table scan.
        const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
        for (const s of rows) await ctx.db.delete(s._id as string);
      } else {
        userId = (await ctx.db.insert("users", { email: normEmail })) as string; // authed non-anon caller: new account
      }
    } else {
      userId = (await ctx.db.insert("users", { email: normEmail })) as string;
    }

    await ctx.db.insert("accounts", {
      userId, provider: "password", accountId: normEmail,
      secret: await hashSecret(password),
      failedAttempts: 0, lockedUntil: 0,
    });
    return mintSession(ctx, config, userId, deviceLabel);
  });

  const signIn = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const normEmail = normalizeEmail(email);
    const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (!account) throw new Error("invalid credentials");

    // Lockout gate — checked before password verification so timing does not leak validity.
    if (ctx.now() < (account.lockedUntil as number)) {
      throw new Error("too many attempts — account temporarily locked");
    }

    if (typeof account.secret !== "string" || !(await verifySecret(password, account.secret))) {
      // Persist the failure counter via commit-then-throw (writes only commit on a normal return).
      const failedAttempts = (account.failedAttempts as number) + 1;
      const lockedUntil = failedAttempts >= MAX_ATTEMPTS ? ctx.now() + LOCK_MS : (account.lockedUntil as number);
      await ctx.db.replace(account._id as string, { ...account, failedAttempts, lockedUntil });
      return commitThenThrow("invalid credentials");
    }

    // Success: reset counters, rehashing a legacy secret in the same replace.
    const next = { ...account, failedAttempts: 0, lockedUntil: 0 } as typeof account;
    if (needsRehash(account.secret as string)) next.secret = await hashSecret(password);
    await ctx.db.replace(account._id as string, next);

    return mintSession(ctx, config, account.userId as string, deviceLabel);
  });

  const signOut = mutation(async (ctx, { token }: { token: string }) => {
    const session = await resolveSession(ctx.db, token);
    if (session) await ctx.db.delete(session._id as string);
    return null;
  });

  const getUserId = query(async (ctx, { token }: { token: string }): Promise<string | null> => {
    const session = await resolveSession(ctx.db, token);
    if (!session || ctx.now() > (session.expiresAt as number)) return null;
    return session.userId as string;
  });

  const refresh = mutation(async (ctx, { refreshToken }: { refreshToken: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    const presentedHash = sha256base64url(refreshToken);
    const now = ctx.now();

    // Fast path: the presented token is the session's CURRENT refresh token → rotate in place.
    const [current] = await ctx.db.query("sessions", "byRefreshTokenHash").eq("refreshTokenHash", presentedHash).collect();
    if (current) {
      // Ceiling (spec decision 11): the absolute cap never slides — an actively-refreshing session
      // still dies at it. Legacy rows (no absoluteExpiresAt) skip the ceiling check.
      const absolute = current.absoluteExpiresAt as number | undefined;
      const refreshExpires = current.refreshExpiresAt as number | undefined;
      if (absolute !== undefined && now > absolute) throw new RefreshExpiredError();
      if (refreshExpires !== undefined && now > refreshExpires) throw new RefreshExpiredError();

      const newToken = generateToken();
      const newRefresh = generateToken();
      // `compact` strips the `token: undefined` key: the syscall codec rejects `undefined`, and
      // omitting the key is what actually DROPS a legacy raw token on first rotation.
      await ctx.db.replace(current._id as string, compact({
        ...current,
        tokenHash: sha256base64url(newToken),
        expiresAt: now + config.accessTtlMs,
        prevRefreshTokenHash: current.refreshTokenHash,   // remember old hash for reuse detection
        refreshTokenHash: sha256base64url(newRefresh),
        refreshExpiresAt: now + config.refreshTtlMs,       // slide
        lastRefreshAt: now,
        // absoluteExpiresAt intentionally NOT touched — fixed at mint.
        token: undefined,                                   // legacy raw token dropped (key stripped)
      }));
      return {
        token: newToken,
        refreshToken: newRefresh,
        sessionId: current._id as string,
        userId: current.userId as string,
        expiresAt: now + config.accessTtlMs,
      };
    }

    // Not the current token: is it the PREVIOUS refresh token of some session? (reuse detection)
    // A single `byPrevRefreshTokenHash` INDEX equality lookup — never a table scan. A full scan
    // would make every garbage-refresh presentation an O(all-sessions) read inside the single-writer
    // mutation AND widen its OCC conflict range to the entire table — a DoS lever. The index lookup
    // has the identical timing surface as the `byRefreshTokenHash` lookup above, so spec decision
    // 13's constant-time mandate (which covered "the one token comparison in app code") is
    // satisfied by construction: with the index there IS no app-code compare.
    const [reused] = await ctx.db.query("sessions", "byPrevRefreshTokenHash").eq("prevRefreshTokenHash", presentedHash).collect();
    if (reused) {
      const lastRefreshAt = (reused.lastRefreshAt as number | undefined) ?? 0;
      if (now - lastRefreshAt <= config.refreshGraceMs) {
        // Honest racing tab lost to its sibling: soft error, NO revocation (spec decision 4). The
        // client waits for the winner's broadcast pair.
        throw new RefreshStaleError();
      }
      // Outside the grace window: theft signal. DELETE the whole session row (spec decision 3/6) and
      // commit-then-throw so the revocation COMMITS even though this call fails (the same mechanism
      // the lockout counter uses). `REFRESH_REUSED` rides the wire as the error MESSAGE (commit-then-
      // throw carries no `.code`).
      await ctx.db.delete(reused._id as string);
      return commitThenThrow("REFRESH_REUSED");
    }

    // Matches neither current nor previous hash → plain invalid.
    throw new Error("invalid refresh token");
  });

  const signInAnonymously = mutation(async (ctx, { deviceLabel }: { deviceLabel?: string }): Promise<MintResult> => {
    // Reject if the caller already resolves to ANY user (spec §12 — prevents anon churn from
    // signed-in callers). Adapted from better-auth anon.test.ts "should reject subsequent anonymous
    // sign-in attempts once signed in".
    const existing = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (existing) throw new Error("already authenticated — sign out before signing in anonymously");

    // Deployment-global throttle via a single counter row (spec §12). `0` disables.
    if (config.anonymousSignInsPerMinute > 0) {
      const now = ctx.now();
      const [counter] = await ctx.db.query("authCounters", "byName").eq("name", "anonymousSignIns").collect();
      const windowMs = 60_000;
      if (!counter) {
        await ctx.db.insert("authCounters", { name: "anonymousSignIns", windowStart: now, count: 1 });
      } else {
        const windowStart = counter.windowStart as number;
        const count = counter.count as number;
        if (now - windowStart >= windowMs) {
          await ctx.db.replace(counter._id as string, { ...counter, windowStart: now, count: 1 }); // new window
        } else if (count >= config.anonymousSignInsPerMinute) {
          throw new AnonymousThrottledError();                                                     // over cap
        } else {
          await ctx.db.replace(counter._id as string, { ...counter, count: count + 1 });
        }
      }
    }

    const userId = (await ctx.db.insert("users", { anonymous: true })) as string; // real user, no email
    return mintSession(ctx, config, userId, deviceLabel);
  });

  const listSessions = query(async (ctx): Promise<SessionSummary[]> => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) return [];
    const userId = current.userId as string;
    // `byUserId` range, never a table scan: this is a reactive QUERY — a full-table read-set would
    // make every subscribed device list re-run on EVERY sign-in in the deployment; the index range
    // keeps invalidation scoped to this one user's sessions.
    const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
    return rows
      .map((s) => ({
        sessionId: s._id as string,
        deviceLabel: (s.deviceLabel as string | undefined) ?? null,
        createdAt: (s.createdAt as number | undefined) ?? null,
        lastRefreshAt: (s.lastRefreshAt as number | undefined) ?? null,
        current: (s._id as string) === (current._id as string),
      }));
  });

  const revokeSession = mutation(async (ctx, { sessionId }: { sessionId: string }) => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) throw new Error("not authenticated");
    const target = await ctx.db.get(sessionId);
    // Ownership check: only the owner may revoke; a missing/foreign row is a silent no-op-ish reject.
    if (!target || (target.userId as string) !== (current.userId as string)) throw new Error("session not found");
    await ctx.db.delete(sessionId);
    return null;
  });

  const revokeOtherSessions = mutation(async (ctx) => {
    const current = await currentSessionOf(ctx as unknown as FacadeCtx);
    if (!current) throw new Error("not authenticated");
    const userId = current.userId as string;
    // `byUserId` range, never a table scan — reads (and OCC conflict range) stay scoped to this
    // one user's sessions.
    const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
    for (const s of rows) {
      if ((s._id as string) !== (current._id as string)) {
        await ctx.db.delete(s._id as string);
      }
    }
    return null;
  });

  const base = { signUp, signIn, signOut, getUserId, refresh, signInAnonymously, listSessions, revokeSession, revokeOtherSessions };
  if (!config.email) return base;                       // email absent ⇒ surface stays EXACTLY A1's
  return { ...base, ...makeEmailModules(config) };       // Tasks 2–4 provide makeEmailModules
}

/** The decision `_issueCode` returns to its calling action: whether to send at all, the raw code
 *  (generated inside the mutation — never elsewhere), and the normalized email to send to. */
type SendDecision = { send: boolean; code?: string; email: string };

function ttlFor(config: AuthConfig, flow: Flow): number {
  const e = config.email!;
  return flow === "otp" ? e.otpTtlMs : flow === "magic" ? e.magicLinkTtlMs : flow === "reset" ? e.resetTtlMs : e.verifyTtlMs;
}

// Whether a row is written at all for this (email, flow) given account existence + flags (decision 7/11).
async function shouldIssue(ctx: MutationCtx, config: AuthConfig, email: string, flow: Flow): Promise<boolean> {
  const [user] = await ctx.db.query("users", "byEmail").eq("email", email).collect();
  if (flow === "otp" || flow === "magic") {
    // Sign-in flows: issue for a known user always; for an unknown email only if createUsersOnEmailSignIn.
    return !!user || config.email!.createUsersOnEmailSignIn;
  }
  // verify/reset: only for an existing account (unknown email → silent no-send, decision 7).
  return !!user;
}

/** A2 email-flow modules (verify/reset/magic/otp). `_issueCode` is the internal mutation the four
 *  `request*` actions call via `ctx.runMutation("auth:_issueCode", …)` (the `scheduler:_enqueue`
 *  convention — `_`-prefixed, non-client-callable, but reachable from an action's runMutation). */
function makeEmailModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const _issueCode = mutation(async (ctx, { email, flow }: { email: string; flow: Flow }): Promise<SendDecision> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const normEmail = normalizeEmail(email);
    const now = ctx.now();

    // Global send throttle FIRST (protects the bill + caps enumeration even for no-send emails). Same
    // single-windowed-row pattern as A1's anonymousSignIns (spec decision 6). `0` disables.
    if (config.email.emailSendsPerMinute > 0) {
      const [counter] = await ctx.db.query("authCounters", "byName").eq("name", "emailSends").collect();
      const windowMs = 60_000;
      if (!counter) {
        await ctx.db.insert("authCounters", { name: "emailSends", windowStart: now, count: 1 });
      } else if (now - (counter.windowStart as number) >= windowMs) {
        await ctx.db.replace(counter._id as string, { ...counter, windowStart: now, count: 1 });
      } else if ((counter.count as number) >= config.email.emailSendsPerMinute) {
        throw new EmailThrottledError();
      } else {
        await ctx.db.replace(counter._id as string, { ...counter, count: (counter.count as number) + 1 });
      }
    }

    // Anti-enumeration: decide whether to write/send at all, per flow + flags.
    if (!(await shouldIssue(ctx, config, normEmail, flow))) return { send: false, email: normEmail };

    // Per-(email, flow) cooldown against the existing row's createdAt (decision 6).
    const [existing] = await ctx.db.query("authCodes", "byEmailFlow").eq("email", normEmail).eq("flow", flow).collect();
    if (existing && now - (existing.createdAt as number) < config.email.requestCooldownMs) {
      throw new EmailCooldownError();
    }

    // Generate raw code INSIDE the mutation (A1 mintSession precedent), hash, overwrite prior row.
    const code = isTokenFlow(flow) ? generateLinkToken() : generateOtp();
    const row = { email: normEmail, flow, codeHash: sha256base64url(code), expiresAt: now + ttlFor(config, flow), attempts: 0, createdAt: now };
    if (existing) await ctx.db.replace(existing._id as string, { ...row });   // one active row (decision 2)
    else await ctx.db.insert("authCodes", row);

    return { send: true, code, email: normEmail };   // raw code returned to the action, never logged/stored
  });

  // One action factory per flow — each: runMutation _issueCode → (if send) build template + provider.send → { sent: true }.
  // `ctx` arrives typed `unknown` by the `action()` overload (actions carry provider-attached fields
  // `mutation`/`query` ctx types don't) — cast to the base `ActionCtx` shape, same idiom as
  // `currentSessionOf`'s `ctx as unknown as FacadeCtx` above.
  function requestAction(flow: Flow) {
    return action(async (ctx, { email }: { email: string }): Promise<{ sent: true }> => {
      if (!config.email) throw new EmailNotConfiguredError();
      const decision = await (ctx as ActionCtx).runMutation<SendDecision>("auth:_issueCode", { email, flow });
      if (decision.send && decision.code) {
        const e = config.email;
        const url = isTokenFlow(flow) && e.baseUrl
          ? `${e.baseUrl.replace(/\/$/, "")}/auth/${flow}?token=${decision.code}&email=${encodeURIComponent(decision.email)}`
          : undefined;
        const rendered = e.templates[flow]({ appName: e.appName, email: decision.email, code: isTokenFlow(flow) ? undefined : decision.code, url, ttlMs: ttlFor(config, flow) });
        await e.provider.send({ to: decision.email, from: e.from, ...rendered });
      }
      return { sent: true };   // ALWAYS — anti-enumeration (decision 7)
    });
  }

  return {
    _issueCode,
    requestEmailVerification: requestAction("verify"),
    requestPasswordReset: requestAction("reset"),
    requestMagicLink: requestAction("magic"),
    requestOtp: requestAction("otp"),
    // Task 3 adds the redeem mutations to this object.
  };
}
