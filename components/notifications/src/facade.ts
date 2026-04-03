import type { ComponentContext, ActionApi, GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs } from "./config";
import type { SendResult } from "./provider";
import { recordSend, deliverOutbound } from "./modules";
import type { QueuedMessage } from "./modules";
import { compact } from "./render";

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
 *  top-level txn) — same fire-and-forget queued semantics as the mutation facade. `sendNow` also
 *  enqueues durably (one `_enqueueSend` txn: in_app rows sent instantly, email/SMS written `queued`
 *  + the receipt, atomically), then drains the just-queued email/SMS rows synchronously (network in
 *  an action is allowed) through the SAME `_claimForSend`/`_markResult` guard the driver uses, and
 *  returns the provider results. Crash-safe: because every email/SMS row is durable `queued` state
 *  before any delivery, a crash mid-drain leaves un-delivered rows `queued` and the DRIVER backstops
 *  them — no channel is ever silently dropped, and the claim guard makes driver-vs-inline delivery
 *  mutually exclusive (exactly-once). Portable method signatures mirror `NotificationsContext`. */
export interface NotificationsActionContext {
  send(args: SendArgs): Promise<{ messageIds: string[] }>;
  sendNow(args: SendArgs): Promise<{ messageIds: string[]; results: SendResult[] }>;
}

export function notificationsActionContext(api: ActionApi, config: NotificationsConfig): NotificationsActionContext {
  return {
    async send(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
      return { messageIds: r.messageIds };
    },
    async sendNow(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
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
      return { messageIds: r.messageIds, results };
    },
  };
}
