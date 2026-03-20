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

/** Verification-gate sentinel (Task 4): `signUp`/`signIn` return this — NO tokens, NO I/O beyond
 *  what already ran — when `requireEmailVerification` is on and the account isn't verified yet. The
 *  client responds by calling `requestEmailVerification`; `verifyEmail` (Task 3) then mints. */
export type NeedsVerification = { needsVerification: true };

/** The gated `signUp`/`signIn` return type: additive over `MintResult` — existing callers (gate off,
 *  the default) keep getting a bare `MintResult`/`commitThenThrow` result, byte-identical to A1. */
export type SignInResult = MintResult | NeedsVerification | ReturnType<typeof commitThenThrow>;

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
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult | NeedsVerification> => {
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
        // Verification-gate composition (ADJUDICATED, decision 11 + the uniform first-proof rule):
        // when the gate is on and this upgrade will come out unverified (always true here — an anon
        // user never has `emailVerified`), do NOT wipe the anon session now. The user keeps working
        // anonymously (spec "signUp/signIn integration") until `verifyEmail`'s
        // `markVerifiedRevokingIfFirstProof` performs the deferred wipe at the mailbox-proof moment —
        // one shared credential-boundary code path, no separate bookkeeping. Ungated (or an
        // already-verified anon user, which cannot occur today) upgrades wipe immediately, unchanged.
        const deferWipe = config.email?.requireEmailVerification === true && user.emailVerified !== true;
        // `compact` strips `anonymous: undefined` — omitting the key is what clears the flag
        // (the syscall codec rejects `undefined` values).
        await ctx.db.replace(userId, compact({ ...user, email: normEmail, anonymous: undefined }));
        if (!deferWipe) {
          // Delete ALL of the user's sessions via the `byUserId` range (an upgrade is a credential
          // boundary) — never a table scan.
          const rows = await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect();
          for (const s of rows) await ctx.db.delete(s._id as string);
        }
      } else {
        userId = (await ctx.db.insert("users", { email: normEmail })) as string; // authed non-anon caller: new account
      }
    } else {
      userId = (await ctx.db.insert("users", { email: normEmail })) as string;
    }

    await ctx.db.insert("accounts", { userId, provider: "password", accountId: normEmail, secret: await hashSecret(password), failedAttempts: 0, lockedUntil: 0 });
    // Verification gate (decision 11): only when configured on AND the account isn't already verified.
    // No tokens, no send here — the CLIENT responds to needsVerification by calling requestEmailVerification.
    // Anonymous-upgrade composes: the upgrade above already ran (userId/rows preserved); the user keeps
    // working anonymously (their old anon session still lives) until verifyEmail mints.
    if (config.email?.requireEmailVerification) {
      const user = await ctx.db.get(userId);
      if (user?.emailVerified !== true) return { needsVerification: true } as NeedsVerification;
    }
    return mintSession(ctx, config, userId, deviceLabel);
  });

  const signIn = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<SignInResult> => {
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

    // Verification gate (decision 11): an unverified account gets no tokens — no I/O beyond the
    // counter reset/rehash above, which already happened. The already-verified case (or the gate
    // off) falls through to a normal mint.
    if (config.email?.requireEmailVerification) {
      const user = await ctx.db.get(account.userId as string);
      if (user?.emailVerified !== true) return { needsVerification: true } as NeedsVerification;
    }
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

// Whether this (email, flow) gets a REAL, redeemable code + an actual send, given account
// existence + flags (decision 7/11). `false` still results in a cooldown-tracking sentinel row
// being written (see `_issueCode`) — this only gates the SEND/real-code path, not row presence.
async function shouldIssue(ctx: MutationCtx, config: AuthConfig, email: string, flow: Flow): Promise<boolean> {
  const [user] = await ctx.db.query("users", "byEmail").eq("email", email).collect();
  if (flow === "otp" || flow === "magic") {
    // Sign-in flows: issue for a known user always; for an unknown email only if createUsersOnEmailSignIn.
    return !!user || config.email!.createUsersOnEmailSignIn;
  }
  if (flow === "reset") {
    // Reset targets a PASSWORD credential, not merely a `users` row: a passwordless user (created via
    // magic-link/OTP sign-in with the default createUsersOnEmailSignIn:true) has no password to reset.
    // Gating only on `!!user` was the enabling condition for a Critical: such a user WOULD get a
    // redeemable reset code, and resetPassword's `!account` branch ran AFTER the winning code row was
    // already deleted — a plain throw there discarded that delete, leaving the code live/replayable
    // until TTL (see resetPassword's `!account` handling below, now routed through `commitThenThrow`
    // as defense-in-depth too). Anti-enumeration is preserved here: a user-with-no-password-account
    // falls through to `return false` exactly like an unknown email does — same sentinel/no-send path,
    // same `{ sent: true }`, no distinguishable outcome (decision 7).
    if (!user) return false;
    const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
    return !!account;
  }
  // verify: only for an existing account (unknown email → silent no-send, decision 7).
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

    // Per-(email, flow) cooldown against the existing row's createdAt (decision 6) — checked
    // UNIFORMLY for every (email, flow), BEFORE the account-existence/send decision below, and
    // regardless of it (fix for the review's Critical account-enumeration leak). Previously this
    // check ran only after `shouldIssue` gated it to known accounts, so an unknown email never hit
    // it: a known email's rapid 2nd request threw EMAIL_COOLDOWN while an unknown email's 2nd
    // request sailed through to `{ sent: true }` — a deterministic two-request account-existence
    // oracle that defeats decision 7. Reading `existing` here (rather than after the send decision)
    // and throwing before ever branching on account existence makes the two cases indistinguishable
    // to the caller: 1st request → `{ sent: true }`; immediate 2nd request → `EMAIL_COOLDOWN`,
    // identically whether or not an account exists.
    const [existing] = await ctx.db.query("authCodes", "byEmailFlow").eq("email", normEmail).eq("flow", flow).collect();
    if (existing && now - (existing.createdAt as number) < config.email.requestCooldownMs) {
      throw new EmailCooldownError();
    }

    // Anti-enumeration: decide whether to actually SEND (and issue a real, redeemable code), per
    // flow + flags. This decision is unchanged from before the fix — only the cooldown check above
    // was moved ahead of it and made unconditional.
    if (!(await shouldIssue(ctx, config, normEmail, flow))) {
      // No account to issue a real code for (or createUsersOnEmailSignIn:false for an unknown
      // sign-in email). We still WRITE a cooldown-tracking row for this (email, flow) — with NO
      // usable code — so the NEXT request against this same (email, flow) finds it and cools down
      // exactly like a known email's would (this row's `createdAt` is what the check above reads).
      // `codeHash: ""` is a SENTINEL that can never match a redeem: a real code hash is always a
      // 43-char SHA-256-base64url string (see `sha256base64url`), never empty — Task 3's redeem
      // lookup MUST NOT treat an empty/falsy `codeHash` as a match against any presented code (an
      // empty presented code should already be rejected by input validation before ever reaching a
      // hash compare, but the invariant here is: this row is structurally unmatchable). We also pin
      // `expiresAt: now` (already-expired) as defense in depth. No email is sent — the send
      // decision on the SEND path is unchanged by this fix.
      const sentinelRow = { email: normEmail, flow, codeHash: "", expiresAt: now, attempts: 0, createdAt: now };
      if (existing) await ctx.db.replace(existing._id as string, sentinelRow);
      else await ctx.db.insert("authCodes", sentinelRow);
      return { send: false, email: normEmail };
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

  const INVALID = "invalid code"; // generic, used for wrong/expired/consumed/no-such-account alike (decision 7)

  /** Shared read+guard (no delete yet — the redeem decides consume vs. count, Task 3 brief). Looks up
   *  the ONE active `(email, flow)` row and reports whether the presented raw code matches it.
   *
   *  SENTINEL INVARIANT (T2, functions.ts's `_issueCode` "no account" branch, ~line 410): an unknown
   *  email still gets a cooldown-tracking row with `codeHash: ""` so cooldown can't be used as an
   *  account-existence oracle. `""` is never a real SHA-256/base64url hash (always 43 chars), so
   *  `sha256base64url(presented)` — always non-empty for any non-empty presented code — can never
   *  equal it: the sentinel is unmatchable BY CONSTRUCTION. The explicit `row.codeHash !== ""` guard
   *  below is defense-in-depth on top of that structural guarantee (Task 3 brief invariant (b)) —
   *  belt-and-suspenders against a future refactor accidentally weakening the equality check (e.g. to
   *  a prefix/fuzzy match) into something a `""` could pass. A redeem against a sentinel row (or any
   *  nonexistent-account row) therefore always falls through to the same generic `INVALID` every other
   *  failure mode uses — the row's presence never signals account existence to the caller.
   */
  async function peekCode(
    ctx: MutationCtx,
    email: string,
    flow: Flow,
    presented: string,
  ): Promise<{ row: Record<string, unknown> | null; normEmail: string; matches: boolean }> {
    const normEmail = normalizeEmail(email);
    const [row] = await ctx.db.query("authCodes", "byEmailFlow").eq("email", normEmail).eq("flow", flow).collect();
    const codeHash = row ? (row.codeHash as string) : "";
    const matches = !!row
      && (row.email as string) === normEmail                        // cross-account guard (belt: key already scopes)
      && ctx.now() <= (row.expiresAt as number)
      && codeHash !== ""                                             // sentinel guard (b): never treat "" as a match
      && codeHash === sha256base64url(presented);                    // index-equality-grade constant-time
    return { row: (row as Record<string, unknown> | undefined) ?? null, normEmail, matches };
  }

  /** FINAL-REVIEW FIX (Important — token-flow delete-on-non-match cooldown/DoS): the non-match path
   *  for the three TOKEN-flow redeems below (`verifyEmail`/`resetPassword`/`signInWithMagicLink`) no
   *  longer deletes the active `authCodes` row. Those flows present a 32-char/192-bit unguessable
   *  token — a wrong presented value can NEVER be brute-forced or replayed, so there is no security
   *  reason to consume the row on a miss, and doing so was actively harmful: that SAME row is also
   *  `_issueCode`'s cooldown anchor (its `createdAt` is what the 60s-per-(email,flow) check reads,
   *  ~line 441). Deleting it on every wrong guess let an attacker who knows only a victim's email (a)
   *  unthrottled-delete the victim's live code at wire speed — the victim's real emailed link
   *  intermittently reads back "invalid code" while under attack (a recovery-denial DoS with no rate
   *  limit of its own), and (b) immediately re-request with no existing row left to cool down
   *  against — bypassing the per-email 60s cooldown entirely (email-bombing, bounded only by the
   *  global send throttle).
   *
   *  Previously this ran through a shared `failInvalidConsuming(ctx, row)` helper (delete the row +
   *  `commitThenThrow`, mirroring OTP's attempt-counter bump) — removed. A plain `throw new
   *  Error(INVALID)` is correct in its place: each of the three handlers' non-match check runs
   *  BEFORE any write, so there is nothing staged to lose. The row survives to its own TTL or a
   *  legitimate successful redeem, which still consumes it exactly as before (see each handler's
   *  `matches` branch, unchanged).
   *
   *  OTP (`signInWithOtp`, below) is UNCHANGED: its 8-digit code IS guessable, so its
   *  attempt-counter-then-delete-at-cap behavior remains correct and necessary. */

  /** First mailbox proof is a credential boundary: when `emailVerified` flips false→true, DELETE ALL
   *  the user's existing sessions (byUserId) — a pre-registrant's PARKED SESSION must not survive the
   *  true mailbox owner proving control (better-auth `revokeUnprovenAccountAccess` rationale). Gated
   *  on the FLIP: an already-verified user's magic/otp sign-in is normal multi-device and wipes
   *  nothing. */
  async function markVerifiedRevokingIfFirstProof(ctx: MutationCtx, user: Record<string, unknown>): Promise<void> {
    const userId = user._id as string;
    if (user.emailVerified !== true) {
      for (const s of await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect()) {
        await ctx.db.delete(s._id as string);
      }
    }
    await ctx.db.replace(userId, { ...user, emailVerified: true });
  }

  /** Shared by `signInWithMagicLink`/`signInWithOtp`: adopt an existing user or create one (per
   *  `createUsersOnEmailSignIn`), then mint. */
  async function adoptOrCreateThenMint(
    ctx: MutationCtx,
    normEmail: string,
    deviceLabel?: string,
  ): Promise<MintResult | ReturnType<typeof commitThenThrow>> {
    let [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
    if (!user) {
      // LATENT instance of the same consume-before-validate footgun the resetPassword Critical
      // reproduced: this runs from signInWithMagicLink/signInWithOtp, both AFTER the winning code
      // row has already been deleted by the caller. Currently unreachable in practice — shouldIssue
      // already gates magic/otp issuance on `createUsersOnEmailSignIn` for an unknown email, so a
      // redeemable code should never exist here with the flag off — but a plain `throw` would
      // silently discard that delete if this branch were ever reached (future shouldIssue drift,
      // flag flipped between issuance and redeem, etc.). commitThenThrow makes the consume durable
      // regardless of reachability.
      if (!config.email!.createUsersOnEmailSignIn) return commitThenThrow(INVALID); // unknown email, creation off → generic (decision 11)
      const id = (await ctx.db.insert("users", { email: normEmail, emailVerified: true })) as string;
      return mintSession(ctx, config, id, deviceLabel);
    }
    // Adopt an existing account. If it was NEVER verified, this is the FIRST mailbox proof — a
    // credential boundary: delete any PASSWORD credential (decision 10 — a pre-registrant's password
    // backdoor; attribution: better-auth magic-link.test.ts:268) AND, via the uniform rule, ALL
    // pre-existing sessions (the pre-registrant's PARKED-SESSION backdoor; better-auth
    // revokeUnprovenAccountAccess rationale). An already-verified user skips both — normal
    // multi-device sign-in.
    if (user.emailVerified !== true) {
      for (const a of await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect()) {
        await ctx.db.delete(a._id as string);
      }
    }
    await markVerifiedRevokingIfFirstProof(ctx, user as Record<string, unknown>); // session wipe on the flip + set true
    return mintSession(ctx, config, user._id as string, deviceLabel);
  }

  const verifyEmail = mutation(async (ctx, { email, code, deviceLabel }: { email: string; code: string; deviceLabel?: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const { row, normEmail, matches } = await peekCode(ctx, email, "verify", code);
    // Final-review fix (see the comment block above): expired/wrong/sentinel → generic, WITHOUT
    // consuming the row — nothing is staged yet, so a plain throw discards nothing.
    if (!matches) throw new Error(INVALID);
    await ctx.db.delete(row!._id as string);                      // consume-before-validate winner
    const [user] = await ctx.db.query("users", "byEmail").eq("email", normEmail).collect();
    // LATENT instance of the same consume-before-validate footgun the resetPassword Critical
    // reproduced: this runs AFTER the winning code row was already deleted above. Currently
    // unreachable — shouldIssue already gates verify issuance on `!!user`, so a redeemable verify
    // code should never exist for a nonexistent user — but commitThenThrow (not a plain throw) makes
    // the consume durable regardless of reachability, rather than relying on that invariant holding.
    if (!user) return commitThenThrow(INVALID);                   // verify targets an existing account
    await markVerifiedRevokingIfFirstProof(ctx, user as Record<string, unknown>); // flip + credential boundary
    return mintSession(ctx, config, user._id as string, deviceLabel);
  });

  const resetPassword = mutation(async (ctx, { email, code, newPassword }: { email: string; code: string; newPassword: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const { row, normEmail, matches } = await peekCode(ctx, email, "reset", code);
    // Final-review fix (see the comment block above `verifyEmail`): expired/wrong/sentinel →
    // generic, WITHOUT consuming the row — nothing is staged yet, so a plain throw discards nothing.
    if (!matches) throw new Error(INVALID);
    await ctx.db.delete(row!._id as string);
    const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    // THE Critical this fix wave closes: a user who signed up via magic-link/OTP (default
    // createUsersOnEmailSignIn:true) has a `users` row but NO password `accounts` row. Before this
    // fix wave, shouldIssue gated reset issuance on `!!user` alone, so such a user COULD get a
    // redeemable reset code; on redeem, `matches` was true, the winning code row was already deleted
    // above, and this branch's plain `throw new Error(INVALID)` discarded that delete — the code
    // stayed live/replayable until its TTL, breaking the single-use invariant. shouldIssue now also
    // gates reset on account existence (see above), so this branch should be unreachable — but
    // commitThenThrow makes the consume durable regardless, the same defense-in-depth reasoning as
    // the other two post-delete branches this wave fixed.
    if (!account) return commitThenThrow(INVALID);
    await ctx.db.replace(account._id as string, { ...account, secret: await hashSecret(newPassword), failedAttempts: 0, lockedUntil: 0 });
    const userId = account.userId as string;
    const user = await ctx.db.get(userId);
    if (user) await ctx.db.replace(userId, { ...user, emailVerified: true }); // a reset proves mailbox control too
    // Revoke ALL sessions (byUserId range, credential boundary — decision 8), then mint fresh. This
    // composes trivially with the uniform first-proof rule: the wipe below already satisfies the
    // credential boundary an emailVerified false→true flip would separately demand, so no additional
    // `markVerifiedRevokingIfFirstProof` call is needed here (see the design spec's amendment note).
    for (const s of await ctx.db.query("sessions", "byUserId").eq("userId", userId).collect()) await ctx.db.delete(s._id as string);
    return mintSession(ctx, config, userId);
  });

  const signInWithMagicLink = mutation(async (ctx, { email, token, deviceLabel }: { email: string; token: string; deviceLabel?: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const { row, normEmail, matches } = await peekCode(ctx, email, "magic", token);
    // Final-review fix (see the comment block above `verifyEmail`): expired/wrong/sentinel →
    // generic, WITHOUT consuming the row — nothing is staged yet, so a plain throw discards nothing.
    if (!matches) throw new Error(INVALID);
    await ctx.db.delete(row!._id as string);
    return adoptOrCreateThenMint(ctx, normEmail, deviceLabel); // shared with OTP
  });

  const signInWithOtp = mutation(async (ctx, { email, code, deviceLabel }: { email: string; code: string; deviceLabel?: string }): Promise<MintResult | ReturnType<typeof commitThenThrow>> => {
    if (!config.email) throw new EmailNotConfiguredError();
    const { row, normEmail, matches } = await peekCode(ctx, email, "otp", code);
    if (!row) throw new Error(INVALID); // no row at all → generic (no counter to bump)
    if (!matches) {
      // Wrong (or expired) guess: bump attempts; at the cap DELETE the row (lockout). commit-then-throw
      // so the increment/delete COMMITS despite the throw (same mechanism as A1's lockout).
      const attempts = (row.attempts as number) + 1;
      if (attempts >= config.email.otpAttempts) await ctx.db.delete(row._id as string);
      else await ctx.db.replace(row._id as string, { ...row, attempts });
      return commitThenThrow(INVALID);
    }
    await ctx.db.delete(row._id as string); // consume-before-validate winner
    return adoptOrCreateThenMint(ctx, normEmail, deviceLabel);
  });

  return {
    _issueCode,
    requestEmailVerification: requestAction("verify"),
    requestPasswordReset: requestAction("reset"),
    requestMagicLink: requestAction("magic"),
    requestOtp: requestAction("otp"),
    verifyEmail,
    resetPassword,
    signInWithMagicLink,
    signInWithOtp,
  };
}
