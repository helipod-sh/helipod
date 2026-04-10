# Notifications N3 — preferences + topics (design)

**Date:** 2026-03-20
**Status:** Approved (decided per the standing "take decisions, don't ask, build" directive)
**Arc context:** Slice N3 of the four-slice notification arc — N1 substrate + reactive inbox
(shipped, main `275ba7d`), N2 delivery reliability (shipped, main `453d340`), **N3 preferences +
topics** (this), N4 digest/batching + auth unification. N3 adds the *audience & consent* layer: a
send now respects the recipient's per-category channel preferences (with a critical-bypass for
transactional/OTP), and a broadcast can fan out to the subscribers of a named topic.

**Goal:** Add three capabilities to `@stackbase/notifications`, integrated into the N1 send path and
self-contained in the component: (1) **per-user, per-category, per-channel preferences** that gate
the send path (default-allow; an explicit opt-out suppresses that channel); (2) **critical-bypass**
— a category configured `critical: true` can never be suppressed (OTP/security); (3) **topics** — a
subscription model plus a preference-aware `sendToTopic` fan-out.

**Scope decision (deferred — delivery mechanics, not the consent layer):** multi-provider
**fallback** (Resend→SES on failure) and **time-based multi-channel routing** ("try in-app, then
email after 5 min") are NOT in N3. They are delivery-orchestration concerns (an extension of N2's
retry path), separable from the audience/consent layer this slice delivers. Called out, not built.

**Research grounding:** Knock's PreferenceSet (per-category × per-channel toggles, a default, and a
"commercial vs transactional" split where transactional can't be opted out) and Topics
(subscribe/publish fan-out); Novu's subscriber preferences + topics. Adopted: a default-allow
per-(category, channel) preference model with a config-declared critical category set, and an
action-paginated topic fan-out that reuses the N1 queued-send path (no new driver).

## Locked design decisions

1. **Sends carry a `category`** (optional on `SendArgs`; defaults to `config.defaultCategory ??
   "default"`). The category is the unit preferences and criticality key on. A send with no explicit
   category uses the default category (which a user can still mute unless it's critical).
2. **Preferences are default-allow, stored sparsely.** A `notificationPreferences` row exists ONLY
   when a user has set a preference; its absence means opted-in. A row is
   `{ userId, category, channel?, enabled, updatedAt }`: `channel` absent = a category-wide toggle;
   `channel` set = a channel-specific override. **Resolution** (for a `(userId, category, channel)`
   send): the most specific matching row wins — channel-specific `enabled` > category-wide `enabled`
   > default `true`.
3. **The gate lives in `recordSend`'s channel loop** (the single send chokepoint). For each channel:
   if `to.userId` is set AND the category is NOT critical AND the resolved preference is
   `enabled: false` → **skip the channel** (no `messages` row, no enqueue). No `userId` on the
   recipient → nothing to check (send proceeds; email/SMS-only recipients have no preference
   identity). The `in_app` channel is gated the same way. Skipping is silent at the row level; the
   send RESULT reports it (decision 4).
4. **The send result reports suppressions via the API, not a new row status.** `send`/`sendNow`
   return `{ messageIds, suppressed?: Channel[] }` — the channels a preference suppressed. This is
   an ADDITIVE return-shape change (no `messages.status` union widening, which the additive-schema
   deploy gate would reject). `messageIds` still lists only delivered channels.
5. **Critical-bypass is category-config-driven.** `defineNotifications({ categories: { security:
   { critical: true } } })`. A critical category skips the preference gate entirely for every
   channel, so an OTP/security notification is never suppressible. The preference SETTER also
   refuses to disable a critical category (a loud error), so a client preference center can't even
   record an un-honorable opt-out. Categories not listed default to non-critical.
6. **The preference API resolves the caller's OWN userId server-side** (the inbox ownership model):
   `setPreference({ category, channel?, enabled })` and `getPreferences()` never take a target
   userId as a client argument — a user manages only their own consent. (Absent a verified identity,
   the same boundary as the inbox applies — documented.) A reactive `useNotificationPreferences()`
   React helper reads `getPreferences()` live and exposes `setPreference`.
7. **Topics are a subscription set + a preference-aware fan-out.** `topicSubscriptions`
   `{ topic, userId, createdAt }`. `subscribe({ topic, userId? })` / `unsubscribe({ topic, userId? })`
   (mutations; `userId` defaults to the caller, or an explicit id for a server/admin subscribing
   others — server-controlled, same as `send`'s recipient). `sendToTopic({ topic, channels,
   template, data, category?, idempotencyKey? })` is an ACTION that paginates the topic's subscribers
   and, per bounded batch, calls an internal mutation that `recordSend`s to each subscriber
   (preference-aware, so each subscriber's opt-outs are honored). Returns `{ recipientCount,
   sentCount, suppressedCount }`. Reuses the N1 queued-send driver for actual delivery — no new
   driver.
8. **Topic fan-out idempotency is per-subscriber-derived.** A `sendToTopic` with `idempotencyKey`
   derives each per-subscriber send's key as `${idempotencyKey}:${userId}`, so a mid-fan-out crash
   re-runs the action and the already-sent subscribers dedup (at-least-once fan-out, exactly-once
   per recipient under the N1 receipt guard). Bounded page size; the action loops pages to
   completion.
9. **All time/id via `ctx.now()`/the engine mint; no `Date.now()`/`Math.random()` in a mutation.**
   Preferences/subscriptions `updatedAt`/`createdAt` via `ctx.now()`.

## Component surface

Config (extends `defineNotifications`):
```ts
defineNotifications({
  channels: { ... },                       // N1
  retry: { ... }, reclaimLeaseMs: ...,      // N2
  defaultCategory?: string,                 // default "default"
  categories?: Record<string, { critical?: boolean }>,   // e.g. { security: { critical: true } }
})
```

`SendArgs` gains `category?: string`. `send`/`sendNow` return `{ messageIds, suppressed?: Channel[] }`.

Context facade (`ctx.notifications`, additive):
- `setPreference({ category, channel?, enabled })` — MUTATION, caller's own prefs.
- `getPreferences()` — QUERY, caller's own prefs (reactive).
- `subscribe({ topic, userId? })` / `unsubscribe({ topic, userId? })` — MUTATIONS.
- `sendToTopic({ topic, channels, template, data, category?, idempotencyKey? })` — ACTION.

Client (`@stackbase/client` + react): `useNotificationPreferences()` (live prefs + `setPreference`).

## Schema (additive)

- `notificationPreferences`: `{ userId, category, channel: v.optional(...), enabled, updatedAt }`,
  index `byUser` (`["userId"]`) — the gate fetches a user's rows for a category and resolves in
  memory; `byUserCategory` (`["userId","category"]`) for a scoped fetch. One row per
  `(userId, category, channel|∅)`.
- `topicSubscriptions`: `{ topic, userId, createdAt }`, index `byTopic` (`["topic"]`, the fan-out
  scan) and `byUserTopic` (`["userId","topic"]`, dedup on subscribe + unsubscribe lookup).

All additive; a project without preferences/topics usage writes none of these rows.

## The preference gate (in `recordSend`)

`recordSend` already loops `for (const channel of [...new Set(args.channels)])`, resolving the
address and rendering. N3 inserts, right after address resolution and before the row insert:
```
category = args.category ?? config.defaultCategory ?? "default"
if to.userId AND NOT config.categories[category]?.critical:
    if resolvePreference(db, to.userId, category, channel) === false:
        suppressed.push(channel); continue   // no row, no enqueue
```
`resolvePreference` does one `byUserCategory` fetch (rows for that user+category), then picks the
most-specific: a `channel === channel` row's `enabled`, else a `channel == null` row's `enabled`,
else `true`. The read runs inside the calling mutation's transaction (a consistency read, not a
reactive subscription). `recordSend` returns `suppressed` alongside `messageIds`/`queued`; the
facades thread it into the `send`/`sendNow` result.

## Topics fan-out (`sendToTopic`)

An action (`ctx.notifications.sendToTopic`), not a mutation, because a broadcast is inherently
multi-transaction and does no I/O itself (it delegates rows to internal mutations, delivery to the
driver):
1. Page `topicSubscriptions.byTopic.eq(topic)` (cursor, bounded page size, e.g. 100).
2. Per page, call an internal `_recordSendBatch` mutation: for each subscriber, `recordSend` to
   `{ userId }` on the requested channels/template/data/category, with derived idempotencyKey
   `${key}:${userId}` when a broadcast key is set. Accumulate `sentCount`/`suppressedCount`.
3. Loop until the cursor is exhausted; return `{ recipientCount, sentCount, suppressedCount }`.
Each per-subscriber send is preference-aware (the gate runs in `recordSend`) and dedup-guarded
(the N1 receipt). Delivery is the driver's job. Scale note: a driver-based resumable broadcast
(a broadcast row the driver fans out) is a deferred follow-up; the action-paginate is adequate for
N3 and crash-safe via per-subscriber idempotency.

## Security / correctness

- **Consent is honored at the single send chokepoint** (`recordSend`), so EVERY send path — direct
  `send`, action `sendNow`, and topic fan-out — respects preferences uniformly (no bypass surface).
- **Critical can't be suppressed**, by config, at BOTH the gate (skips prefs) and the setter
  (refuses to record a critical opt-out) — a client can't create an un-honorable state.
- **Preference/subscription identity is server-resolved** for the self-service path (a user manages
  only their own consent/subscriptions), the same ownership model as the inbox; the server/admin
  path takes an explicit `userId` (server-controlled), never a client-forgeable arg on the
  self-service mutations.
- **Idempotency under fan-out**: per-subscriber derived keys make a re-run exactly-once per
  recipient; a topic with a subscriber who opted out is counted `suppressed`, not sent.
- **No secret/PII leakage** beyond N1/N2's stance; preferences store only category/channel/enabled.

## Testing

- **Preference gate (component-level):** a send to an opted-out `(category, channel)` writes no row
  for that channel and reports it in `suppressed`; a channel-specific opt-out overrides a
  category-wide allow (and vice-versa); default-allow (no row) sends; a recipient with no `userId`
  is never gated; a **critical** category ignores an opt-out and delivers.
- **Preference API:** `setPreference` writes/updates the caller's row; `getPreferences` returns only
  the caller's rows; setting a critical category to disabled throws; ownership (can't set another's).
- **Topics:** `subscribe`/`unsubscribe` maintain the set (idempotent subscribe, dedup);
  `sendToTopic` fans out to all subscribers, honors each one's preferences (an opted-out subscriber
  is suppressed), derives per-subscriber idempotency (a re-run sends no duplicates), returns the
  right counts.
- **E2E through the real dev server** (`packages/cli/test/notifications-preferences-e2e.test.ts`):
  a user opts out of a category via `setPreference` (a live `getPreferences` subscription reflects
  it), a subsequent `send` on that category is suppressed (the inbox/message rows show it didn't
  arrive), a critical send still arrives; a `sendToTopic` to a small topic fans out to subscribers
  and skips the opted-out one — proven live.
- Client test for `useNotificationPreferences`.

## Docs

Extend `docs/enduser/build/notifications.md` with **Preferences** (categories, the default-allow
model, `setPreference`/`getPreferences`/`useNotificationPreferences`, critical categories) and
**Topics** (`subscribe`/`sendToTopic`, the preference-aware fan-out, the idempotency note). Update
the "what's deferred" list: preferences + topics move to shipped; N4 = digest/batching + auth
unification; provider-fallback + time-based routing noted as deferred delivery-mechanics.

## Non-goals (N3 — deferred)

- **Multi-provider fallback** (Resend→SES on failure) and **time-based multi-channel routing** —
  delivery mechanics, an N2 extension, not the consent layer.
- **Digest / batching** + **auth unification** (route auth's OTP/magic-link through the seam) — N4.
- **A driver-based resumable topic broadcast** (a broadcast row the driver fans out) — the
  action-paginate fan-out is what ships; the driver-based form is a scale follow-up.
- **Preference inheritance / org-level defaults / preference templates** — per-user only in N3.
- **Frequency capping** (rate-limit per user across categories) — post-arc.

## Reference implementations consulted

Knock (PreferenceSet per-category×channel + transactional-can't-opt-out + Topics subscribe/publish —
the closest precedent), Novu (subscriber preferences + topics), and the N1 `recordSend` send
chokepoint (the single gate point) + the N1 receipt idempotency (per-subscriber fan-out dedup).
