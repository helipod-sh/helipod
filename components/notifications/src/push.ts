import { mutation, type MutationCtx, type RegisteredFunction } from "@helipod/executor";
import type { GuestDatabaseWriter } from "@helipod/executor";
import type { NotificationsConfig, PushProviderKind } from "./config";
import { callerId } from "./inbox";
import { compact } from "./render";

export interface RegisterPushTokenArgs {
  token: string;
  provider: PushProviderKind;
  platform?: "ios" | "android" | "web";
}

/** Upsert BY TOKEN (not by (userId,token)) — a device token identifies one installation; whoever is
 *  currently logged into that device owns it. Shared by the registered `registerPushToken` module
 *  (self-only, caller resolved via `callerId`) and the mutation facade's `registerPushToken`
 *  (server-controlled `userId?`), the same two-transports-one-core split every other N1-N4 write
 *  path (`applySetPreference`, `subscribeImpl`) uses. */
export async function registerPushTokenImpl(db: GuestDatabaseWriter, now: number, userId: string, args: RegisterPushTokenArgs): Promise<null> {
  const [existing] = await db.query("pushTokens", "byToken").eq("token", args.token).take(1).collect();
  if (existing) {
    await db.replace(existing._id as string, compact({ userId, token: args.token, provider: args.provider, platform: args.platform, createdAt: existing.createdAt }));
  } else {
    await db.insert("pushTokens", compact({ userId, token: args.token, provider: args.provider, platform: args.platform, createdAt: now }));
  }
  return null;
}

/** Ownership-checked delete — a foreign or missing token is a silent no-op (mirrors `markRead`'s
 *  ownership check; avoids leaking whether a token string belongs to someone else). */
export async function unregisterPushTokenImpl(db: GuestDatabaseWriter, userId: string, args: { token: string }): Promise<null> {
  const [existing] = await db.query("pushTokens", "byToken").eq("token", args.token).take(1).collect();
  if (existing && (existing.userId as string) === userId) await db.delete(existing._id as string);
  return null;
}

/** `registerPushToken`/`unregisterPushToken` — CLIENT-CALLABLE, hence strictly SELF-ONLY: the
 *  subject is `callerId(ctx)`, never a client-supplied `userId` (the N3 IDOR lesson `subscribe`/
 *  `unsubscribe` already codified). The server-controlled `userId?` override lives ONLY on the
 *  facade (`ctx.notifications.registerPushToken`, `facade.ts`), reachable exclusively from
 *  server-authored mutations. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function makePushModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerPushToken = mutation(async (ctx: any, args: RegisterPushTokenArgs): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    return registerPushTokenImpl((ctx as MutationCtx).db as GuestDatabaseWriter, (ctx as MutationCtx).now(), userId, args);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unregisterPushToken = mutation(async (ctx: any, args: { token: string }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    return unregisterPushTokenImpl((ctx as MutationCtx).db as GuestDatabaseWriter, userId, args);
  });

  return { registerPushToken, unregisterPushToken };
}
