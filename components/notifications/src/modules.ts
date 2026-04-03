import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";
import type { Value } from "@stackbase/values";
import type { NotificationsConfig, SendArgs, Channel } from "./config";
import type { EmailContent, SmsPayload, SendResult } from "./provider";
import { compact, stableHash, renderEmail, renderSms, renderInApp, deliverOutbound, type DeliverEntry } from "./render";

/** Cap on queued rows a single driver pass drains (bounded work per iteration). */
export const BATCH_CAP = 64;

/** A queued email/SMS row the driver delivers (returned by `_peekQueued`). */
export interface QueuedMessage {
  _id: string;
  channel: "email" | "sms";
  to: string;
  payload: EmailContent | SmsPayload;
  idempotencyKey?: string;
}

function resolveAddress(channel: Channel, to: SendArgs["to"]): string {
  if (channel === "email") { if (!to.email) throw new Error(`send: channel "email" requires to.email`); return to.email; }
  if (channel === "sms") { if (!to.phone) throw new Error(`send: channel "sms" requires to.phone`); return to.phone; }
  if (!to.userId) throw new Error(`send: channel "in_app" requires to.userId`);
  return to.userId;
}

function assertConfigured(config: NotificationsConfig, channel: Channel): void {
  if (channel === "email" && !config.channels.email) throw new Error(`send: "email" channel is not configured on defineNotifications`);
  if (channel === "sms" && !config.channels.sms) throw new Error(`send: "sms" channel is not configured on defineNotifications`);
  if (channel === "in_app" && !config.channels.in_app) throw new Error(`send: "in_app" channel is not configured on defineNotifications`);
}

/**
 * THE shared record path — used by `ctx.notifications.send` (the mutation facade, `facade.ts`), the
 * `_enqueueSend` internal mutation (the action facade's `send`), AND the action facade's `sendNow`.
 * Writes one `messages` row per channel; for `in_app` also the `notifications` inbox row (status
 * `sent`, instant); for email/SMS the row is `queued` (+ rendered `payload`). Records a
 * `sendReceipts` row keyed by `idempotencyKey` in the SAME transaction — a replay short-circuits to
 * the recorded ids. Returns the just-written email/SMS rows as `queued` so `sendNow` can deliver them
 * synchronously (draining them through the SAME `_claimForSend`/`_markResult` guard the driver uses);
 * `send` ignores `queued` and lets the driver sweep them. Because these rows are always durable
 * `queued` state (never in-memory), a `sendNow` process crash after this commit can NEVER silently
 * drop a channel — the driver still delivers the queued row. The claim guard makes driver-vs-inline
 * delivery mutually exclusive, so no double-send.
 *
 * Runs NAMESPACED (bare table names resolve to `notifications/*`) — this is called from the
 * calling mutation's own transaction (the facade's `contextWrite: true` db) or a namespaced internal
 * mutation, never privileged. The `db.query("sendReceipts", "byKey")` read is what makes single-
 * writer OCC catch a concurrent duplicate: the second committer re-validates a now-stale empty read
 * and retries, seeing the winner's receipt (the scheduler `by_idempotency` insert-or-noop discipline).
 */
export async function recordSend(db: GuestDatabaseWriter, now: number, config: NotificationsConfig, args: SendArgs): Promise<{ messageIds: string[]; deduped: boolean; queued: QueuedMessage[] }> {
  if (args.idempotencyKey !== undefined) {
    const [existing] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", args.idempotencyKey).take(1).collect();
    if (existing) return { messageIds: existing.messageIds as string[], deduped: true, queued: [] };
  }
  const dataHash = stableHash(args.data);
  const templateKey = typeof args.template === "string" ? args.template : undefined;
  const messageIds: string[] = [];
  const queued: QueuedMessage[] = [];

  // Dedupe channels so `["email","email"]` is one logical send (one row, one delivery), never two.
  for (const channel of [...new Set(args.channels)]) {
    assertConfigured(config, channel);
    const to = resolveAddress(channel, args.to);
    if (channel === "in_app") {
      const content = renderInApp(config, args.template, args.data);
      const { title, body, ...structured } = content;
      const messageId = (await db.insert("messages", compact({
        channel: "in_app", to, status: "sent", createdAt: now, sentAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash,
      }))) as string;
      await db.insert("notifications", compact({
        userId: to, title, body,
        data: (Object.keys(structured).length > 0 ? structured : args.data) as Value,
        read: false, createdAt: now, messageId,
      }));
      messageIds.push(messageId);
    } else {
      const payload: EmailContent | SmsPayload = channel === "email" ? renderEmail(config, args.template, args.data) : renderSms(config, args.template, args.data);
      const messageId = (await db.insert("messages", compact({
        channel, to, status: "queued", createdAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash, payload: payload as unknown as Value,
      }))) as string;
      messageIds.push(messageId);
      queued.push({ _id: messageId, channel, to, payload, idempotencyKey: args.idempotencyKey });
    }
  }

  if (args.idempotencyKey !== undefined) {
    await db.insert("sendReceipts", { idempotencyKey: args.idempotencyKey, messageIds, createdAt: now });
  }
  return { messageIds, deduped: false, queued };
}

/**
 * The send-side module set (registered `notifications:_enqueueSend`/`_peekQueued`/`_claimForSend`/
 * `_markResult`). All `_`-prefixed → not client-callable; reachable from the action facade via
 * `api.runMutation` and from the driver via `runFunction` (privileged).
 */
export function makeSendModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // Action-facade `send`/`sendNow` delegate — namespaced, bare tables (recordSend). Returns the
  // just-written `queued` email/SMS rows so `sendNow` can drain them synchronously (via the shared
  // `_claimForSend`/`_markResult` guard); the action-facade `send` ignores `queued`.
  const _enqueueSend = mutation(async (ctx: MutationCtx, args: SendArgs): Promise<{ messageIds: string[]; queued: QueuedMessage[] }> => {
    const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, args);
    return { messageIds: r.messageIds, queued: r.queued };
  });

  // Driver-facing trio — PRIVILEGED (fully-qualified "notifications/messages"). See the scheduler's
  // modules.ts module doc comment: privileged calls bypass namespace prefixing.

  // Selects ONLY `status:"queued"` — never `"sending"`. That exclusion is what makes a single-node
  // crash mid-send non-re-sweepable (a row left `"sending"` by a crash is never returned here again).
  const _peekQueued = query(async (ctx: QueryCtx): Promise<QueuedMessage[]> => {
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "queued").take(BATCH_CAP).collect();
    return rows
      .filter((r) => r.channel === "email" || r.channel === "sms") // defensive: in_app is never queued
      .map((r) => ({ _id: r._id as string, channel: r.channel as "email" | "sms", to: r.to as string, payload: r.payload as unknown as EmailContent | SmsPayload, idempotencyKey: r.idempotencyKey as string | undefined }));
  });

  // Claim-before-send: flip `queued → sending` in its OWN transaction BEFORE the network call. The
  // exact `status==="queued"` check under single-writer OCC is the authoritative once-only guard —
  // returns false if the row is gone or already claimed (another pass), so the driver skips it. A
  // crash after this commits but before `_markResult` leaves the row `"sending"` (terminal in N1).
  const _claimForSend = mutation(async (ctx: MutationCtx, args: { messageId: string }): Promise<boolean> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "queued") return false;
    await ctx.db.replace(args.messageId, { ...row, status: "sending" });
    return true;
  });

  // Finalize a claimed (`"sending"`) row: `sending → sent`/`failed`. Clears the transient `payload`
  // (rendered body, possibly OTP/PII) either way — delivered or dead, no reason to retain it.
  const _markResult = mutation(async (ctx: MutationCtx, args: { messageId: string; ok: boolean; providerMessageId?: string; error?: string }): Promise<null> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "sending") return null; // must be mid-send — defensive
    const now = ctx.now();
    if (args.ok) {
      // `compact` drops the `undefined` keys, so `db.replace` writes a doc with NO `payload`/`error`
      // key — that absence IS the clear (both are `v.optional`).
      await ctx.db.replace(args.messageId, compact({ ...row, status: "sent", sentAt: now, providerMessageId: args.providerMessageId, error: undefined, payload: undefined }));
    } else {
      await ctx.db.replace(args.messageId, compact({ ...row, status: "failed", error: args.error ?? "send failed", payload: undefined }));
    }
    return null;
  });

  return { _enqueueSend, _peekQueued, _claimForSend, _markResult };
}

// Re-export the delivery dispatcher + result type so the facade's `sendNow` and the driver share the
// single provider-resolution path.
export { deliverOutbound };
export type { SendResult, DeliverEntry };
