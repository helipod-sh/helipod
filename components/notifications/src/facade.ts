import type { ComponentContext, ActionApi, GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs, Channel } from "./config";
import type { SendResult } from "./provider";
import { recordSend, deliverOutbound } from "./modules";
import type { QueuedMessage } from "./modules";
import { applySetPreference } from "./preferences";
import { subscribeImpl, unsubscribeImpl, type RecordSendBatchResult } from "./topics";
import { compact } from "./render";

/**
 * Resolve the ambient caller's user id for a facade write, mirroring `inbox.ts`'s `callerId`: prefer
 * a composed `@stackbase/auth`'s verified `getUserId()` (available via `cctx.components.auth` when
 * auth is composed before notifications), else fall back to the raw ambient identity. A component
 * facade only ever sees `cctx`, never the full guest ctx `callerId` reads from — this is the
 * facade-side equivalent, kept in sync so `ctx.notifications.setPreference` (this file) and the
 * registered `notifications:setPreference` module (`preferences.ts`) can never resolve differently.
 */
async function facadeCallerId(cctx: ComponentContext): Promise<string | null> {
  const authFacade = cctx.components.auth as { getUserId?: () => Promise<string | null> } | undefined;
  const viaAuth = authFacade?.getUserId ? await authFacade.getUserId() : null;
  return viaAuth ?? cctx.identity;
}

/** `ctx.notifications` in a MUTATION (and query, for `identity()`). `send` writes the messages/inbox/
 *  receipt rows through the calling mutation's own transaction (contextWrite). `identity()` exposes
 *  the ambient caller token as the inbox fallback recipient id (see `inbox.ts`). `setPreference`
 *  upserts the CALLER's own preference row (server-resolved identity, never a client arg).
 *  `subscribe`/`unsubscribe` maintain a topic's subscriber set; `userId` is server-controlled (the
 *  app decides who), defaulting to the ambient caller when omitted. */
export interface NotificationsContext {
  send(args: SendArgs): Promise<{ messageIds: string[]; suppressed: Channel[] }>;
  setPreference(args: { category: string; channel?: Channel; enabled: boolean }): Promise<null>;
  subscribe(args: { topic: string; userId?: string }): Promise<null>;
  unsubscribe(args: { topic: string; userId?: string }): Promise<null>;
  identity(): string | null;
}

export function notificationsContext(cctx: ComponentContext, config: NotificationsConfig): NotificationsContext {
  return {
    async send(args) {
      const r = await recordSend(cctx.db as GuestDatabaseWriter, cctx.now, config, args);
      return { messageIds: r.messageIds, suppressed: r.suppressed };
    },
    async setPreference(args) {
      const userId = await facadeCallerId(cctx);
      if (!userId) throw new Error("not authenticated");
      return applySetPreference(cctx.db as GuestDatabaseWriter, cctx.now, config, userId, args);
    },
    async subscribe(args) {
      const userId = args.userId ?? (await facadeCallerId(cctx));
      if (!userId) throw new Error("not authenticated");
      return subscribeImpl(cctx.db as GuestDatabaseWriter, cctx.now, userId, args.topic);
    },
    async unsubscribe(args) {
      const userId = args.userId ?? (await facadeCallerId(cctx));
      if (!userId) throw new Error("not authenticated");
      return unsubscribeImpl(cctx.db as GuestDatabaseWriter, userId, args.topic);
    },
    identity: () => cctx.identity,
  };
}

/** `ctx.notifications` in an ACTION. `send` delegates to the internal `_enqueueSend` mutation (fresh
 *  top-level txn) — same fire-and-forget queued semantics as the mutation facade. `sendNow` also
 *  enqueues durably (one `_enqueueSend` txn: in_app rows sent instantly, email/SMS written `queued`
 *  + the receipt, atomically), then drains the just-queued email/SMS rows synchronously (network in
 *  an action is allowed) through the SAME `_claimForSend`/`_markResult` guard the driver uses, and
 *  returns the provider results. Crash-safe: because every email/SMS row is durable `queued` state
 *  before any delivery, a crash mid-drain leaves un-delivered rows `queued` and the DRIVER backstops
 *  them — no channel is ever silently dropped, and the claim guard makes driver-vs-inline delivery
 *  mutually exclusive (exactly-once). Portable method signatures mirror `NotificationsContext`. */
export interface NotificationsActionContext {
  send(args: SendArgs): Promise<{ messageIds: string[]; suppressed: Channel[] }>;
  sendNow(args: SendArgs): Promise<{ messageIds: string[]; results: SendResult[]; suppressed: Channel[] }>;
  /** Fan out a send to every `topic` subscriber, preference-aware for free (each subscriber routes
   *  through `recordSend`, the single gate). Paginates `_recordSendBatch` (`topics.ts`) to
   *  completion — one page per call — so an arbitrarily large subscriber set never blows one
   *  transaction. A supplied `idempotencyKey` is broadcast-scoped: `_recordSendBatch` derives a
   *  per-subscriber key from it, so a re-run with the same key is a no-op per subscriber. */
  sendToTopic(args: {
    topic: string;
    channels: Channel[];
    template: SendArgs["template"];
    data?: SendArgs["data"];
    category?: string;
    idempotencyKey?: string;
  }): Promise<{ recipientCount: number; sentCount: number; suppressedCount: number }>;
}

export function notificationsActionContext(api: ActionApi, config: NotificationsConfig): NotificationsActionContext {
  return {
    async send(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
      return { messageIds: r.messageIds, suppressed: r.suppressed };
    },
    async sendNow(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
      const results: SendResult[] = [];
      for (const m of r.queued) {
        // Claim BEFORE the network call (queued → sending). Lost the claim (the driver raced us and
        // already took it) → skip; the driver delivers it. This is what makes a crash mid-drain
        // non-double-delivering and non-dropping (un-drained rows stay `queued` for the driver).
        const claimed = await api.runMutation<boolean>("notifications:_claimForSend", { messageId: m._id });
        if (!claimed) continue;
        let ok = false;
        let providerMessageId: string | undefined;
        let error: string | undefined;
        try {
          // Same auto-derived provider Idempotency-Key the driver uses (`msg:<rowId>`), so an N2
          // driver retry of a sendNow-crashed row reuses it and a supporting provider dedups.
          const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: `msg:${m._id}` });
          ok = true;
          providerMessageId = res.providerMessageId;
          results.push(res);
        } catch (e) {
          error = String(e);
        }
        // Strip undefined keys — `runMutation`'s arg codec rejects an undefined-valued key (same
        // `jsonToConvex` the driver's `_markResult` call must `compact` around).
        await api.runMutation("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, error }) as unknown as Record<string, unknown>);
      }
      return { messageIds: r.messageIds, results, suppressed: r.suppressed };
    },
    async sendToTopic(args) {
      let cursor: string | null = null;
      let recipientCount = 0;
      let sentCount = 0;
      let suppressedCount = 0;
      do {
        const page: RecordSendBatchResult = await api.runMutation<RecordSendBatchResult>(
          "notifications:_recordSendBatch",
          compact({
            topic: args.topic, channels: args.channels, template: args.template, data: args.data,
            category: args.category, idempotencyKey: args.idempotencyKey, cursor, pageSize: 100,
          }) as unknown as Record<string, unknown>,
        );
        recipientCount += page.count;
        sentCount += page.sentCount;
        suppressedCount += page.suppressedCount;
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor !== null);
      return { recipientCount, sentCount, suppressedCount };
    },
  };
}
