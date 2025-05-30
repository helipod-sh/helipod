import { mutation, query, commitThenThrow } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken } from "./crypto";

export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

interface Creds { email: string; password: string }

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export const signUp = mutation(async (ctx, { email, password }: Creds) => {
  const normEmail = normalizeEmail(email);
  // Duplicate guard relies on single-writer OCC serialization — see schema.ts comment.
  const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
  if (existing.length > 0) throw new Error("an account with that email already exists");
  const userId = await ctx.db.insert("users", { email: normEmail });
  await ctx.db.insert("accounts", {
    userId, provider: "password", accountId: normEmail,
    secret: await hashSecret(password),
    failedAttempts: 0, lockedUntil: 0,
  });
  const token = generateToken();
  await ctx.db.insert("sessions", { userId, token, expiresAt: ctx.now() + THIRTY_DAYS });
  return { token, userId };
});

export const signIn = mutation(async (ctx, { email, password }: Creds) => {
  const normEmail = normalizeEmail(email);
  const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
  if (!account) throw new Error("invalid credentials");

  // Lockout gate — checked before password verification so timing does not leak validity.
  if (ctx.now() < (account.lockedUntil as number)) {
    throw new Error("too many attempts — account temporarily locked");
  }

  if (typeof account.secret !== "string" || !(await verifySecret(password, account.secret))) {
    // Increment the failure counter and persist it. We cannot throw here because this engine
    // rolls back all writes on an uncaught throw (writes only commit if the handler returns).
    // Instead we return a CommitThenThrow sentinel: the executor commits the transaction first,
    // then surfaces the error to the caller — so the counter survives the rejection.
    const failedAttempts = (account.failedAttempts as number) + 1;
    const lockedUntil = failedAttempts >= MAX_ATTEMPTS
      ? ctx.now() + LOCK_MS
      : (account.lockedUntil as number);
    await ctx.db.replace(account._id as string, { ...account, failedAttempts, lockedUntil });
    return commitThenThrow("invalid credentials");
  }

  // Success: reset counters. Merge with Task 1's rehash so there is exactly one replace call.
  const next = { ...account, failedAttempts: 0, lockedUntil: 0 } as typeof account;
  if (needsRehash(account.secret as string)) next.secret = await hashSecret(password);
  await ctx.db.replace(account._id as string, next);

  const token = generateToken();
  await ctx.db.insert("sessions", { userId: account.userId as string, token, expiresAt: ctx.now() + THIRTY_DAYS });
  return { token, userId: account.userId as string };
});

export const signOut = mutation(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  if (session) await ctx.db.delete(session._id as string);
  return null;
});

export const getUserId = query(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  if (!session || ctx.now() > (session.expiresAt as number)) return null;
  return session.userId as string;
});
