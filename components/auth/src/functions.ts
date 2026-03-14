import { mutation, query, commitThenThrow, type ComponentContext, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken, sha256base64url } from "./crypto";
import type { AuthConfig } from "./config";

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

  return { signUp, signIn, signOut, getUserId };
}
