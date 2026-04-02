import type { ComponentContext, ActionApi, GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs } from "./config";
import type { SendResult } from "./provider";
import { recordSend, deliverOutbound, type PrepareNowResult, type NowDelivery } from "./modules";

/** `ctx.notifications` in a MUTATION (and query, for `identity()`). `send` writes the messages/inbox/
 *  receipt rows through the calling mutation's own transaction (contextWrite). `identity()` exposes
 *  the ambient caller token as the inbox fallback recipient id (see `inbox.ts`). */
export interface NotificationsContext {
  send(args: SendArgs): Promise<{ messageIds: string[] }>;
  identity(): string | null;
}

export function notificationsContext(cctx: ComponentContext, config: NotificationsConfig): NotificationsContext {
  return {
    async send(args) {
      const r = await recordSend(cctx.db as GuestDatabaseWriter, cctx.now, config, args);
      return { messageIds: r.messageIds };
    },
    identity: () => cctx.identity,
  };
}

/** `ctx.notifications` in an ACTION. `send` delegates to the internal `_enqueueSend` mutation (fresh
 *  top-level txn) — same fire-and-forget queued semantics as the mutation facade. `sendNow` delivers
 *  email/SMS synchronously (network in an action is allowed), returning the provider results. The
 *  two-phase `_prepareNow`/`_finishNow` guarantees at-most-once (dedup precedes the live send) and
 *  never leaves a driver-visible queued row. Portable method signatures mirror `NotificationsContext`
 *  (a `send` call is portable between a mutation and an action). */
export interface NotificationsActionContext {
  send(args: SendArgs): Promise<{ messageIds: string[] }>;
  sendNow(args: SendArgs): Promise<{ messageIds: string[]; results: SendResult[] }>;
}

export function notificationsActionContext(api: ActionApi, config: NotificationsConfig): NotificationsActionContext {
  return {
    async send(args) {
      return api.runMutation<{ messageIds: string[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
    },
    async sendNow(args) {
      const prep = await api.runMutation<PrepareNowResult>("notifications:_prepareNow", args as unknown as Record<string, unknown>);
      if (prep.deduped) return { messageIds: prep.messageIds, results: [] };
      const results: SendResult[] = [];
      const deliveries: NowDelivery[] = [];
      for (const o of prep.outbound) {
        try {
          const res = await deliverOutbound(config, o);
          results.push(res);
          deliveries.push({ ...o, status: "sent", providerMessageId: res.providerMessageId });
        } catch (e) {
          deliveries.push({ ...o, status: "failed", error: String(e) });
        }
      }
      const fin = await api.runMutation<{ messageIds: string[] }>("notifications:_finishNow", { deliveries, idempotencyKey: args.idempotencyKey } as unknown as Record<string, unknown>);
      return { messageIds: [...prep.messageIds, ...fin.messageIds], results };
    },
  };
}
