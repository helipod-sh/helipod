import { mutation, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig } from "./config";
import { callerId } from "./inbox";

/**
 * Subscribe `userId` to `topic` — IDEMPOTENT: checks `byUserTopic` first, no-op if already
 * subscribed. Shared by the registered `subscribe` module (`makeTopicModules` below, caller
 * resolved via `callerId`) AND the mutation facade's `subscribe` (`ctx.notifications.subscribe`,
 * caller resolved via the ambient `cctx.identity`) so the two reachable paths can never drift —
 * the same "two-transports-one-core" discipline `applySetPreference` established for preferences.
 */
export async function subscribeImpl(db: GuestDatabaseWriter, now: number, userId: string, topic: string): Promise<null> {
  const [existing] = await db.query("topicSubscriptions", "byUserTopic").eq("userId", userId).eq("topic", topic).take(1).collect();
  if (!existing) await db.insert("topicSubscriptions", { topic, userId, createdAt: now });
  return null;
}

/** Unsubscribe `userId` from `topic` — a no-op if no matching row exists. Shared the same way. */
export async function unsubscribeImpl(db: GuestDatabaseWriter, userId: string, topic: string): Promise<null> {
  const [existing] = await db.query("topicSubscriptions", "byUserTopic").eq("userId", userId).eq("topic", topic).take(1).collect();
  if (existing) await db.delete(existing._id as string);
  return null;
}

/**
 * `subscribe`/`unsubscribe` — maintain a topic's subscriber set. `userId` is server-controlled
 * (the app decides who gets subscribed), defaulting to the caller when omitted. `config` is unused
 * by T3's subscription management; T4's `_recordSendBatch` fan-out mutation (added here) closes
 * over it to drive `recordSend`, so the signature is kept stable in advance.
 */
export function makeTopicModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  void config; // reserved for T4's `_recordSendBatch`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscribe = mutation(async (ctx: any, args: { topic: string; userId?: string }): Promise<null> => {
    const userId = args.userId ?? (await callerId(ctx));
    if (!userId) throw new Error("not authenticated");
    return subscribeImpl((ctx as MutationCtx).db as GuestDatabaseWriter, (ctx as MutationCtx).now(), userId, args.topic);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsubscribe = mutation(async (ctx: any, args: { topic: string; userId?: string }): Promise<null> => {
    const userId = args.userId ?? (await callerId(ctx));
    if (!userId) throw new Error("not authenticated");
    return unsubscribeImpl((ctx as MutationCtx).db as GuestDatabaseWriter, userId, args.topic);
  });

  return { subscribe, unsubscribe };
}
