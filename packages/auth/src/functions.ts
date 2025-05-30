import { mutation, query } from "@stackbase/executor";
import { hashSecret, verifySecret, needsRehash, generateToken } from "./crypto";

export const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

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
  await ctx.db.insert("accounts", { userId, provider: "password", accountId: normEmail, secret: await hashSecret(password) });
  const token = generateToken();
  await ctx.db.insert("sessions", { userId, token, expiresAt: ctx.now() + THIRTY_DAYS });
  return { token, userId };
});

export const signIn = mutation(async (ctx, { email, password }: Creds) => {
  const normEmail = normalizeEmail(email);
  const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", normEmail).collect();
  if (!account || typeof account.secret !== "string" || !await verifySecret(password, account.secret)) {
    throw new Error("invalid credentials");
  }
  if (needsRehash(account.secret)) {
    await ctx.db.replace(account._id as string, { ...account, secret: await hashSecret(password) });
  }
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
