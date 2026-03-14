import { mutation, query, commitThenThrow, type ComponentContext, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";
import { RefreshStaleError, RefreshExpiredError } from "./errors";

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

/** Build the auth module set closing over `config`. `defineAuth` calls this (spec decision 10). */
export function makeAuthModules(config: AuthConfig): Record<string, RegisteredFunction> {
  const signUp = mutation(async (ctx, { email, password, deviceLabel }: Creds): Promise<MintResult> => {
    const normEmail = normalizeEmail(email);
    // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
    const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
    if (existing.length > 0) throw new Error("an account with that email already exists");
    const userId = await ctx.db.insert("users", { email: normEmail }) as string;
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

  return { signUp, signIn, signOut, getUserId, refresh };
}
