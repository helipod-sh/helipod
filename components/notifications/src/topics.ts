import { mutation, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs } from "./config";
import { callerId } from "./inbox";
import { recordSend } from "./modules";
import { compact } from "./render";

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

/** One page's fan-out result — summed by the action facade's `sendToTopic` loop across pages. */
export interface RecordSendBatchResult {
  count: number;
  nextCursor: string | null;
  hasMore: boolean;
  sentCount: number;
  suppressedCount: number;
}

/**
 * `subscribe`/`unsubscribe` — maintain a topic's subscriber set. `userId` is server-controlled
 * (the app decides who gets subscribed), defaulting to the caller when omitted. `_recordSendBatch`
 * (T4) is the fan-out mutation: it paginates ONE page of a topic's subscribers (`byTopic`) and, for
 * each, calls `recordSend` — THE single preference-aware chokepoint (`modules.ts`) — so the fan-out
 * is preference-aware for free; no second gate is added here. It is reached ONLY from an action's
 * `api.runMutation` (the action facade's `sendToTopic`, `facade.ts`), never directly by a client —
 * hence the `_`-prefix — so it runs NAMESPACED: bare table names ("topicSubscriptions") resolve
 * under the component's own namespace, exactly like `recordSend` itself and the N2
 * `_applyWebhookEvent` lesson (a fully-qualified name here would double-prefix and 404).
 */
export function makeTopicModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
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

  const _recordSendBatch = mutation(async (ctx: MutationCtx, args: {
    topic: string;
    channels: SendArgs["channels"];
    template: SendArgs["template"];
    data?: SendArgs["data"];
    category?: string;
    idempotencyKey?: string;
    cursor: string | null;
    pageSize: number;
  }): Promise<RecordSendBatchResult> => {
    const db = ctx.db;
    const res = await db.query("topicSubscriptions", "byTopic").eq("topic", args.topic)
      .paginate({ cursor: args.cursor, pageSize: args.pageSize, maxScan: args.pageSize * 10 });
    let sentCount = 0;
    let suppressedCount = 0;
    for (const sub of res.page) {
      const userId = sub.userId as string;
      // Per-subscriber idempotency: `${idempotencyKey}:${userId}` — only derived when a broadcast
      // key is set (else `undefined`, dropped by `compact` below), so a `sendToTopic` re-run with the
      // same key dedups per-subscriber via `recordSend`'s own `sendReceipts` short-circuit — no new
      // rows on replay — while an un-keyed fan-out sends fresh every call, same as a plain `send`.
      const idempotencyKey = args.idempotencyKey !== undefined ? `${args.idempotencyKey}:${userId}` : undefined;
      const sendArgs = compact({
        to: { userId }, channels: args.channels, template: args.template, data: args.data,
        category: args.category, idempotencyKey,
      }) as unknown as SendArgs;
      const r = await recordSend(db, ctx.now(), config, sendArgs);
      sentCount += r.messageIds.length;
      suppressedCount += r.suppressed.length;
    }
    return {
      count: res.page.length,
      nextCursor: res.hasMore ? res.nextCursor : null,
      hasMore: res.hasMore,
      sentCount,
      suppressedCount,
    };
  });

  return { subscribe, unsubscribe, _recordSendBatch };
}
