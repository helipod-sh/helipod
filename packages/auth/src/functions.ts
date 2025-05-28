import { mutation, query } from "@stackbase/executor";
import { hashSecret, verifySecret, generateToken } from "./crypto";

interface Creds { email: string; password: string }

export const signUp = mutation(async (ctx, { email, password }: Creds) => {
  const existing = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
  if (existing.length > 0) throw new Error("an account with that email already exists");
  const userId = await ctx.db.insert("users", { email });
  await ctx.db.insert("accounts", { userId, provider: "password", accountId: email, secret: hashSecret(password) });
  const token = generateToken();
  await ctx.db.insert("sessions", { userId, token });
  return { token, userId };
});

export const signIn = mutation(async (ctx, { email, password }: Creds) => {
  const [account] = await ctx.db.query("accounts", "byAccount").eq("provider", "password").eq("accountId", email).collect();
  if (!account || typeof account.secret !== "string" || !verifySecret(password, account.secret)) {
    throw new Error("invalid credentials");
  }
  const token = generateToken();
  await ctx.db.insert("sessions", { userId: account.userId as string, token });
  return { token, userId: account.userId as string };
});

export const signOut = mutation(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  if (session) await ctx.db.delete(session._id as string);
  return null;
});

export const getUserId = query(async (ctx, { token }: { token: string }) => {
  const [session] = await ctx.db.query("sessions", "byToken").eq("token", token).collect();
  return session ? (session.userId as string) : null;
});
