import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";
import type { Value } from "@stackbase/values";
import type { NotificationsConfig, SendArgs, Channel, PushProviderKind } from "./config";
import { digestWindowMs } from "./config";
import type { EmailContent, SmsPayload, SendResult, PushContent } from "./provider";
import { compact, stableHash, renderEmail, renderSms, renderInApp, renderPush, deliverOutbound, type DeliverEntry, type PushTokenEntry } from "./render";
import { computeBackoff } from "./backoff";
import { resolvePreference, isCritical } from "./preferences";

/** Cap on queued rows a single driver pass drains (bounded work per iteration). */
export const BATCH_CAP = 64;

/** A queued email/SMS/push row the driver / `sendNow` delivers (returned by `_peekQueued` /
 *  `recordSend`). The provider Idempotency-Key is derived from `_id` (`msg:<_id>`) at delivery, not
 *  carried here. `tokens` is push-only (the snapshotted device tokens at send time). */
export interface QueuedMessage {
  _id: string;
  channel: "email" | "sms" | "push";
  to: string;
  payload: EmailContent | SmsPayload | PushContent;
  tokens?: PushTokenEntry[];
}

function resolveAddress(channel: Channel, to: SendArgs["to"]): string {
  if (channel === "email") { if (!to.email) throw new Error(`send: channel "email" requires to.email`); return to.email; }
  if (channel === "sms") { if (!to.phone) throw new Error(`send: channel "sms" requires to.phone`); return to.phone; }
  // in_app / push both address by userId — the recipient's identity, not a contact address.
  if (!to.userId) throw new Error(`send: channel "${channel}" requires to.userId`);
  return to.userId;
}

function assertConfigured(config: NotificationsConfig, channel: Channel): void {
  if (channel === "email" && !config.channels.email) throw new Error(`send: "email" channel is not configured on defineNotifications`);
  if (channel === "sms" && !config.channels.sms) throw new Error(`send: "sms" channel is not configured on defineNotifications`);
  if (channel === "in_app" && !config.channels.in_app) throw new Error(`send: "in_app" channel is not configured on defineNotifications`);
  if (channel === "push" && !config.channels.push) throw new Error(`send: "push" channel is not configured on defineNotifications`);
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
export async function recordSend(db: GuestDatabaseWriter, now: number, config: NotificationsConfig, args: SendArgs): Promise<{ messageIds: string[]; deduped: boolean; queued: QueuedMessage[]; suppressed: Channel[]; deferred: Channel[] }> {
  if (args.idempotencyKey !== undefined) {
    const [existing] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", args.idempotencyKey).take(1).collect();
    if (existing) return { messageIds: existing.messageIds as string[], deduped: true, queued: [], suppressed: [], deferred: [] };
  }
  const dataHash = stableHash(args.data);
  const templateKey = typeof args.template === "string" ? args.template : undefined;
  const category = args.category ?? config.defaultCategory;
  const messageIds: string[] = [];
  const queued: QueuedMessage[] = [];
  const suppressed: Channel[] = [];
  const deferred: Channel[] = [];

  // Dedupe channels so `["email","email"]` is one logical send (one row, one delivery), never two.
  for (const channel of [...new Set(args.channels)]) {
    assertConfigured(config, channel);
    const to = resolveAddress(channel, args.to);
    // N3 preference gate — the SINGLE consent chokepoint. A recipient with a `userId` who opted out
    // of (category, channel) is suppressed, UNLESS the category is critical (OTP/security). No
    // `userId` → no preference identity → send proceeds. Read runs in the calling mutation's txn.
    const userId = args.to.userId;
    if (userId !== undefined && !isCritical(config, category) && args.critical !== true && !(await resolvePreference(db, userId, category, channel))) {
      suppressed.push(channel);
      continue;
    }
    // N4 digest: a non-critical EMAIL send on a digest-configured category is BUFFERED (a
    // `digestBuffer` row) instead of enqueued — the digest driver flushes a combined email per
    // recipient on the category's rolling window. in_app is never digested (the inbox is the live
    // view); a critical send is never digested (immediate). Rendered here (deterministic, no I/O).
    if (channel === "email" && args.critical !== true && !isCritical(config, category) && digestWindowMs(config, category) !== null) {
      const content = renderEmail(config, args.template, args.data);
      const email = args.to.email!;                 // resolveAddress already asserted it for "email"
      await db.insert("digestBuffer", compact({
        recipientKey: email, email, userId: args.to.userId, category,
        subject: content.subject, text: content.text, html: content.html, createdAt: now,
      }));
      deferred.push(channel);
      continue;
    }
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
    } else if (channel === "push") {
      // Snapshot the recipient's CURRENTLY registered device tokens at send time (not at delivery
      // time) — a token registered/unregistered after this commit doesn't retroactively change what
      // this logical send fans out to; a race is resolved in favor of whatever was durable at send.
      const tokenRows = await db.query("pushTokens", "byUser").eq("userId", to).collect();
      const tokens: PushTokenEntry[] = tokenRows.map((r) => ({ token: r.token as string, provider: r.provider as PushProviderKind }));
      const content = renderPush(config, args.template, args.data);
      const messageId = (await db.insert("messages", compact({
        channel: "push", to, status: "queued", createdAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash,
        payload: content as unknown as Value, tokens: tokens.length ? (tokens as unknown as Value) : undefined,
      }))) as string;
      messageIds.push(messageId);
      queued.push({ _id: messageId, channel: "push", to, payload: content, tokens });
    } else {
      const payload: EmailContent | SmsPayload = channel === "email" ? renderEmail(config, args.template, args.data) : renderSms(config, args.template, args.data);
      const messageId = (await db.insert("messages", compact({
        channel, to, status: "queued", createdAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash, payload: payload as unknown as Value,
      }))) as string;
      messageIds.push(messageId);
      queued.push({ _id: messageId, channel, to, payload });
    }
  }

  if (args.idempotencyKey !== undefined) {
    await db.insert("sendReceipts", { idempotencyKey: args.idempotencyKey, messageIds, createdAt: now });
  }
  return { messageIds, deduped: false, queued, suppressed, deferred };
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
  const _enqueueSend = mutation(async (ctx: MutationCtx, args: SendArgs): Promise<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[]; deferred: Channel[] }> => {
    const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, args);
    return { messageIds: r.messageIds, queued: r.queued, suppressed: r.suppressed, deferred: r.deferred };
  });

  // Driver-facing trio — PRIVILEGED (fully-qualified "notifications/messages"). See the scheduler's
  // modules.ts module doc comment: privileged calls bypass namespace prefixing.

  // Selects ONLY `status:"queued"` rows that are eligible NOW (nextAttemptAt null or <= now). Returns
  // the earliest FUTURE nextAttemptAt among skipped (backed-off) rows so the driver can arm a precise
  // wake instead of only the interval timer. `now` is passed in (a query has no wall-clock).
  //
  // N2 SCALE BOUNDARY (single-node, moderate volume — deferred, not a correctness issue): this scans
  // the first BATCH_CAP `queued` rows in index order (oldest-first) then splits ready/deferred in
  // memory. Under a sustained retry storm (>= BATCH_CAP simultaneously backed-off rows, which sort
  // ahead as older), the batch can fill with not-yet-eligible rows and delay genuinely-ready fresh
  // messages until the backlog clears — nothing is lost or double-sent, only delayed. The fix is a
  // composite `["status","nextAttemptAt"]` index + range query (needs the engine's optional-index-
  // field semantics pinned down); an N2 follow-up, disproportionate to build for this single-node
  // slice. Relatedly, a same-pass-requeued row with a ~0 backoff is skipped via the driver's
  // `attemptedThisPass` guard but is NOT counted in `earliestDeferredAt` (it's eligible, not deferred),
  // so its precise re-wake falls back to the interval timer — irrelevant at production backoff
  // defaults (250ms+), only visible with a deliberately-zero backoff config.
  const _peekQueued = query(async (ctx: QueryCtx, args: { now: number }): Promise<{ ready: QueuedMessage[]; earliestDeferredAt: number | null }> => {
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "queued").take(BATCH_CAP).collect();
    const ready: QueuedMessage[] = [];
    let earliestDeferredAt: number | null = null;
    for (const r of rows) {
      if (r.channel !== "email" && r.channel !== "sms" && r.channel !== "push") continue; // defensive: in_app is never queued
      const next = r.nextAttemptAt as number | undefined;
      if (next == null || next <= args.now) {
        ready.push({
          _id: r._id as string, channel: r.channel as "email" | "sms" | "push", to: r.to as string,
          payload: r.payload as unknown as EmailContent | SmsPayload | PushContent,
          tokens: r.tokens as PushTokenEntry[] | undefined,
        });
      } else if (earliestDeferredAt === null || next < earliestDeferredAt) {
        earliestDeferredAt = next;
      }
    }
    return { ready, earliestDeferredAt };
  });

  // Claim-before-send: flip `queued → sending` in its OWN transaction BEFORE the network call. The
  // exact `status==="queued"` check under single-writer OCC is the authoritative once-only guard —
  // returns false if the row is gone or already claimed (another pass), so the driver skips it. A
  // crash after this commits but before `_markResult` leaves the row `"sending"` (recovered by N2's
  // `_reclaimStuck`). `claimedAt` is the lease start the reclaim sweep measures against.
  const _claimForSend = mutation(async (ctx: MutationCtx, args: { messageId: string }): Promise<boolean> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "queued") return false;
    await ctx.db.replace(args.messageId, { ...row, status: "sending", claimedAt: ctx.now() });
    return true;
  });

  // Finalize a claimed (`"sending"`) row: `sending → sent`/`queued` (retry)/`failed` (dead-letter).
  // `retryable` (undefined → treated as retryable) and `config.retry.maxAttempts` decide whether a
  // failure retries with a jittered backoff or dead-letters. Clears the transient `payload` (rendered
  // body, possibly OTP/PII) on sent/dead-letter; KEEPS it across a retry (needed to resend).
  const _markResult = mutation(async (ctx: MutationCtx, args: { messageId: string; ok: boolean; providerMessageId?: string; providerName?: string; error?: string; retryable?: boolean }): Promise<null> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "sending") return null; // must be mid-send — defensive
    const now = ctx.now();
    if (args.ok) {
      // `compact` drops the `undefined` keys, so `db.replace` writes a doc with NO `payload`/`error`
      // key — that absence IS the clear (both are `v.optional`). `providerName` is written ONLY on
      // this success branch (fallback decision 5) — the failure/retry/dead-letter branch below never
      // sets it; the concatenated `error` string from `deliverOutbound` already names every provider
      // tried on a failed attempt.
      await ctx.db.replace(args.messageId, compact({ ...row, status: "sent", sentAt: now, providerMessageId: args.providerMessageId, providerName: args.providerName, error: undefined, payload: undefined, tokens: undefined, claimedAt: undefined, nextAttemptAt: undefined }));
      return null;
    }
    const attempts = ((row.attempts as number | undefined) ?? 0) + 1;
    if (args.retryable !== false && attempts < config.retry.maxAttempts) {
      // Retry: back to queued with a backoff delay. KEEP payload (needed for the resend). Clear claimedAt.
      const nextAttemptAt = now + computeBackoff(attempts, ctx.random, { initialBackoffMs: config.retry.initialBackoffMs, base: config.retry.base });
      await ctx.db.replace(args.messageId, compact({ ...row, status: "queued", attempts, nextAttemptAt, error: args.error, claimedAt: undefined }));
    } else {
      // Dead-letter: terminal failed. Clear payload (delivered/dead content not retained) + the stale
      // retry cursor.
      await ctx.db.replace(args.messageId, compact({ ...row, status: "failed", attempts, error: args.error ?? "send failed", payload: undefined, tokens: undefined, claimedAt: undefined, nextAttemptAt: undefined }));
    }
    return null;
  });

  // Reclaim: a row stuck `sending` past the lease (a crash between claim and _markResult) is swept
  // back to `queued`, counting an attempt so a perpetually-crashing row eventually dead-letters
  // instead of looping. Single-node (wall-clock lease). Bounded batch.
  const _reclaimStuck = mutation(async (ctx: MutationCtx): Promise<number> => {
    const now = ctx.now();
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "sending").take(BATCH_CAP).collect();
    let reclaimed = 0;
    for (const row of rows) {
      const claimedAt = row.claimedAt as number | undefined;
      // Reclaim once the lease has ELAPSED (`now - claimedAt >= reclaimLeaseMs`), i.e. skip only while
      // still within the lease window. Written as an elapsed-time check (not `claimedAt + lease >= now`)
      // so `reclaimLeaseMs: 0` reclaims unconditionally rather than racing an exact-millisecond tie
      // between `claimedAt` and `now` (both real wall-clock reads, easily equal in a fast in-memory run).
      if (claimedAt === undefined || now - claimedAt < config.reclaimLeaseMs) continue;
      const attempts = ((row.attempts as number | undefined) ?? 0) + 1;
      if (attempts >= config.retry.maxAttempts) {
        await ctx.db.replace(row._id as string, compact({ ...row, status: "failed", attempts, error: "reclaim: stuck sending, max attempts", payload: undefined, claimedAt: undefined, nextAttemptAt: undefined }));
      } else {
        const nextAttemptAt = now + computeBackoff(attempts, ctx.random, { initialBackoffMs: config.retry.initialBackoffMs, base: config.retry.base });
        await ctx.db.replace(row._id as string, compact({ ...row, status: "queued", attempts, nextAttemptAt, claimedAt: undefined }));
      }
      reclaimed++;
    }
    return reclaimed;
  });

  // Push invalid-token pruning: called by the driver/`sendNow` after a delivery attempt reports
  // `invalidTokens` (a provider's synchronous "unregistered" signal). PRIVILEGED (fully-qualified
  // "notifications/pushTokens") — same driver-facing-internal convention as `_claimForSend`/
  // `_markResult`/`_reclaimStuck` above. A token already gone (raced unregister) is a silent no-op.
  const _pruneInvalidPushTokens = mutation(async (ctx: MutationCtx, args: { tokens: string[] }): Promise<null> => {
    for (const token of args.tokens) {
      const [row] = await ctx.db.query("notifications/pushTokens", "byToken").eq("token", token).take(1).collect();
      if (row) await ctx.db.delete(row._id as string);
    }
    return null;
  });

  return { _enqueueSend, _peekQueued, _claimForSend, _markResult, _reclaimStuck, _pruneInvalidPushTokens };
}

// Re-export the delivery dispatcher + result type so the facade's `sendNow` and the driver share the
// single provider-resolution path.
export { deliverOutbound };
export type { SendResult, DeliverEntry };
