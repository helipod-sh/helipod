import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/notifications` schema (namespaced `notifications/*` when composed). All additive:
 * a project without `defineNotifications` gets none of these tables.
 *
 * `status`: `queued → sending → sent`/`failed`. The `"sending"` intermediate (claim-before-send)
 * makes a single-node crash mid-send non-re-sweepable: `_peekQueued` selects ONLY `"queued"`, so a
 * row left `"sending"` by a crash is never picked up again (no double-send). A stuck `"sending"` row
 * is terminal in N1 (recovery is N2). Fleet multi-driver claim/lease is N2. PRIVACY NOTE: a stuck
 * `"sending"` row keeps its `payload` (rendered content, possibly OTP/PII) at rest — N2's reclaim
 * sweep re-queues or dead-letters it, clearing `payload` when it does.
 *
 * `messages.payload` (RESOLVED AMBIGUITY, see the plan): the rendered per-channel content the
 * driver delivers out-of-transaction (`email {subject,text,html?}`; `sms {body,kind?}`). Templates
 * are pure functions rendered INSIDE the send mutation (deterministic, no I/O); only the rendered
 * output — never the raw template `data` (possible PII) — is persisted here. TRANSIENT: `_markResult`
 * NULLs `payload` on the `sent`/`failed` transition (the rendered body, possibly OTP/PII, is
 * delivered or dead — not retained at rest). The durable inbox content lives on the `notifications`
 * row (`title`/`body`), authz-scoped; only this outbound `payload` is cleared. Optional/additive.
 */
export const notificationsSchema = defineSchema({
  messages: defineTable({
    channel: v.union(v.literal("email"), v.literal("sms"), v.literal("in_app")),
    to: v.string(),
    status: v.union(v.literal("queued"), v.literal("sending"), v.literal("sent"), v.literal("failed")),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    templateKey: v.optional(v.string()),
    dataHash: v.optional(v.string()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    payload: v.optional(v.any()), // transient — cleared by `_markResult` on sent/failed (see doc above)
    // N2 delivery reliability (all additive/optional):
    attempts: v.optional(v.number()),        // retryable-failure count (absent = 0)
    nextAttemptAt: v.optional(v.number()),   // earliest sweep time for a backed-off `queued` row (absent = now)
    claimedAt: v.optional(v.number()),       // set on queued→sending; drives stuck-row reclaim
    deliveryStatus: v.optional(v.union(      // axis 2: provider-reported delivery/engagement, monotonic
      v.literal("delivered"), v.literal("bounced"), v.literal("complained"),
      v.literal("opened"), v.literal("clicked"), v.literal("dropped"), v.literal("failed_permanent"),
    )),
    deliveryDetail: v.optional(v.string()),  // optional provider detail (bounce reason, etc.)
    // Spam-complaint signal — ORTHOGONAL to `deliveryStatus`: a complaint always arrives AFTER
    // `delivered`, so it can't ride the monotonic delivery rank (it would be dropped as lower-rank).
    // Recorded unconditionally here (the compliance/suppression signal). `v.literal("complained")`
    // stays in the deliveryStatus union only for the pre-delivery no-`delivered`-yet edge.
    complainedAt: v.optional(v.number()),
  })
    // Driver sweep: scan `status:"queued"` cheaply (never `"sending"`/`"sent"`/`"failed"`).
    .index("byStatus", ["status"])
    // Dedup diagnostics / lookups by the caller's idempotency key.
    .index("byIdempotencyKey", ["idempotencyKey"])
    // Webhook correlation: resolve the target row from the provider's message id in one lookup.
    .index("byProviderMessageId", ["providerMessageId"]),

  notifications: defineTable({
    userId: v.string(),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
    read: v.boolean(),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
    messageId: v.string(),
  })
    // The inbox feed + unread count — keeps reactive invalidation scoped to ONE user's rows,
    // never a whole-table read-set (a full scan would re-run every user's inbox on every send).
    .index("byUser", ["userId"])
    .index("byUserUnread", ["userId", "read"]),

  sendReceipts: defineTable({
    idempotencyKey: v.string(),
    messageIds: v.array(v.string()),
    createdAt: v.number(),
  }).index("byKey", ["idempotencyKey"]),

  notificationPreferences: defineTable({
    userId: v.string(),
    category: v.string(),
    channel: v.optional(v.union(v.literal("email"), v.literal("sms"), v.literal("in_app"))), // absent = category-wide
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("byUser", ["userId"])           // getPreferences: all of a user's rows
    .index("byUserCategory", ["userId", "category"]), // the gate: a user's rows for one category

  topicSubscriptions: defineTable({
    topic: v.string(),
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("byTopic", ["topic"])           // fan-out scan
    .index("byUserTopic", ["userId", "topic"]), // dedup on subscribe / unsubscribe lookup

  // N4 digest: a non-critical EMAIL send on a digest-configured category buffers here (instead of
  // enqueuing a `messages` row) until the category's rolling window elapses, at which point the
  // digest driver claims (`flushedAt`) and combines a recipient's buffered items into ONE email
  // via `recordSend`. Additive/optional throughout — a project with no digest categories never
  // writes here.
  digestBuffer: defineTable({
    recipientKey: v.string(),       // grouping key = to.email (email digest)
    email: v.string(),              // the address the flushed digest is sent to
    userId: v.optional(v.string()), // for the preference re-check at flush
    category: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    createdAt: v.number(),
    flushedAt: v.optional(v.number()), // set when the digest driver claims+flushes it
  })
    .index("byUnflushed", ["flushedAt"])                    // driver scans flushedAt = undefined
    .index("byRecipientCategory", ["recipientKey", "category"]),
});
