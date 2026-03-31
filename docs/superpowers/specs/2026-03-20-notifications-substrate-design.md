# Notifications N1 — substrate + reactive inbox (design)

**Date:** 2026-03-20
**Status:** Approved (design presented and approved in-session)
**Arc context:** Slice N1 of the four-slice notification arc — **N1 substrate + reactive inbox**
(this), N2 delivery reliability (retries + webhook ingestion + status normalization), N3
preferences + routing + topics, N4 digest/batching + the auth unification. This is the
load-bearing slice: the channel/provider seam it establishes is what N2–N4 and (eventually)
auth all hang off.

**Goal:** Ship `@stackbase/notifications` — an opt-in component (composed via
`stackbase.config.ts`, like scheduler/workflow/triggers) that sends messages across pluggable
channels (email, SMS/WhatsApp, in-app) through swappable per-channel provider adapters, with
transactional at-most-once delivery and a **reactive in-app inbox** that is nearly free because
stored rows are already live-queried.

**Research grounding:** market survey of Novu (the OSS reference: `IProvider{channelType}` + per-
channel `sendMessage` arms; a separate WebSocket service for the inbox), Knock, Courier, Supabase
(no general notification service — DIY), and Convex (small per-provider components + reactive-
inbox-as-a-pattern, the closest precedent). Verdict adopted: assemble a thin layer over stackbase's
existing primitives (scheduler, triggers, reactive queries, the Receipted-Outbox idempotency, the
`EmailProvider` seam) rather than rebuild Novu; make the reactive inbox the differentiator.

## Locked design decisions

1. **Two-layer seam: Channel × Provider** (the industry-standard shape, isomorphic to our
   `DatabaseAdapter`/`BlobStore` philosophy — the component never imports a driver). A **channel**
   is a medium (`"email"`, `"sms"`, `"in_app"`; WhatsApp is an SMS-provider variant addressed by
   the provider, not a separate channel in N1). A **provider** is a swappable adapter for one
   channel: base `NotificationProvider { channel; send(msg): Promise<SendResult> }` with per-
   channel message/result types.
2. **The seam is shaped auth-compatible, but N1 does NOT touch auth.** The `EmailProvider` shape
   generalizes today's auth-internal `components/auth/src/email/provider.ts` (same `send({to,
   from, subject, text, html?})` contract) so N4 can unify auth onto it — but N1 modifies nothing
   in `components/auth`. Clean slice boundary; auth keeps its own seam until N4.
3. **Send straddles the mutation/action boundary** (the A2 auth pattern, generalized): the public
   `ctx.notifications.send(...)` runs in a MUTATION and (a) writes a `messages` row per channel
   (`status: "queued"`), (b) for `in_app` the row IS the delivered notification — instantly
   visible to a live query, no send step, and (c) enqueues the email/SMS rows for a **driver** to
   pick up and actually send via the provider `fetch` OUTSIDE the transaction, updating status
   `queued → sent`/`failed`. Transactional enqueue (rolls back with the mutation), durable
   delivery, reactive in-app for free, provider I/O correctly outside the transaction. An
   action-side `ctx.notifications.sendNow(...)` variant sends synchronously for fire-and-now cases
   (returns the provider result directly).
4. **At-most-once via a durable send receipt** (reusing the Receipted-Outbox guard-chain
   discipline): a `sendReceipts` row keyed by `(idempotencyKey)` recorded transactionally before
   the provider call; a replay short-circuits to the recorded result. Passes the key through to a
   provider's native `Idempotency-Key` when supported (Resend/Loops) — only 2 of 8 providers have
   it, so the orchestrator owns dedup. This is what guarantees an OTP-class message never
   double-sends when N4 routes auth through here.
5. **The reactive in-app inbox is the flagship** (Novu/Knock run a dedicated realtime service for
   exactly this; we get it from the core engine): a `notifications` table + a generated
   `useQuery`-able inbox feed + an `unreadCount` query + a `markRead`/`markAllRead` mutation, with
   the delivery-status rows reactive too (a dashboard/inbox reflects status live). Ship a small
   `<Inbox>` / `useNotifications` helper in the React client.
6. **Inline typed per-channel templates** (not a markup engine): content is authored per channel —
   `email: (data) => { subject; html?; text }`, `sms: (data) => string`, `in_app: (data) =>
   { title; body; ...structured }`. Zero new dependency, type-safe, matches code-first authoring.
   A `templateId`+`variables` shape is anticipated in the email message type (for Loops/SES-
   template providers) but not required in N1.
7. **Providers shipped in N1:** `consoleEmail()` + `resendEmail()` (reuse/generalize the auth
   adapters, moved/copied into the notifications provider package — auth's copies stay untouched),
   a `twilioSms()` adapter (SMS + WhatsApp addressing), and the built-in `in_app` writer (not a
   pluggable provider — the engine writes the row). Provider selection: one active provider per
   channel in N1 (per-channel single-primary, like Novu's email/SMS policy); multi-provider
   fallback is N3.
8. **`ctx.now()` in mutations; provider I/O only in the driver/action.** No `Date.now()`/
   `Math.random()` in the mutation path; the message id / any token uses the engine's mint pattern.
   All timestamps via `ctx.now()`.

## Component surface

Config (opt-in, `stackbase.config.ts`), following `defineScheduler`/`defineTriggers`:

```ts
defineNotifications({
  channels: {
    email?: { provider: EmailProvider; from: string; templates?: EmailTemplates },
    sms?:   { provider: SmsProvider;   from: string; templates?: SmsTemplates },
    in_app?: { enabled: true; templates?: InAppTemplates },   // built-in writer
  },
  driverIntervalMs?: number,   // default 5000 — the queued-send sweep cadence (fallback to the
                               // commit-fanout wake, same as the scheduler's driver)
})
```

`NotificationProvider` seam (exported for adapters + N4 auth reuse):
```ts
interface EmailProvider { channel: "email"; send(m: EmailMessage): Promise<SendResult> }
interface SmsProvider   { channel: "sms";   send(m: SmsMessage):   Promise<SendResult> }
type EmailMessage = { to: string; from: string; subject: string; text: string; html?: string;
                      templateId?: string; variables?: Record<string, unknown>; idempotencyKey?: string }
type SmsMessage   = { to: string; from: string; body: string; kind?: "sms" | "whatsapp";
                      idempotencyKey?: string }
type SendResult   = { providerMessageId?: string }   // throws on failure
```

Context facade (`ctx.notifications`, an always-available provider on every function ctx when the
component is composed, like `ctx.scheduler`):
- `send({ to, channels, template, data, idempotencyKey? })` — MUTATION-side. `to` = a channel-
  addressed recipient (`{ userId?, email?, phone? }`); `channels` = which of the configured
  channels to deliver on; `template` = a registered template key or an inline content object;
  `data` = the template payload. Writes the `messages` rows + (for in_app) the `notifications`
  row; enqueues email/SMS. Returns `{ messageIds }`.
- `sendNow(...)` — ACTION-side synchronous variant (live provider fetch, returns the results).

Client (`@stackbase/client` + react): `useNotifications()` (the inbox feed + unread count),
`markRead(id)` / `markAllRead()`, and a headless `<Inbox>` render helper.

## Schema (component tables, namespaced)

- `messages`: `{ channel, to, status: "queued"|"sent"|"failed", providerMessageId?, error?,
  idempotencyKey?, templateKey?, dataHash?, createdAt, sentAt? }`, indexes `byStatus`
  (driver sweep), `byIdempotencyKey` (dedup). One row per (send × channel).
- `notifications`: the in-app inbox — `{ userId, title, body, data?, read: boolean, readAt?,
  createdAt, messageId }`, indexes `byUser` (the feed / unread count, keeps invalidation scoped
  to the user), `byUserUnread`. This row is written synchronously in the send mutation and is the
  delivered in-app notification.
- `sendReceipts`: `{ idempotencyKey, messageIds, createdAt }`, index `byKey` — the at-most-once
  ledger (a replay returns the recorded messageIds).

All additive; a project without `defineNotifications` composed has zero new tables/surface.

## The driver (queued email/SMS delivery)

Built on the recurring `driver` component seam (the scheduler/storage-reaper pattern): woken by
the commit fan-out + a wall-clock timer (`driverIntervalMs`). Each tick: read `messages` where
`status = "queued"` and `channel ∈ {email, sms}` (bounded batch), and for each — resolve the
configured provider, render the template, call `provider.send(...)` (network I/O, allowed in the
driver's action context), then transactionally update the row `→ sent` (with
`providerMessageId`) or `→ failed` (with `error`). In N1, a failed send is terminal (retries are
N2). The at-most-once receipt guards a message that's already been handed to a provider so a
driver restart mid-send can't double-deliver (worst case a message stuck `queued` is retried
once in N2; N1 marks it `sent` only after the provider call returns).

## Security / correctness

- **No secret leakage:** provider credentials (API keys) live in the provider closure/config,
  never in a `messages` row. The `dataHash` is a hash of the template payload for dedup, not the
  payload itself if it carries PII (store the payload only where needed for the in-app row).
- **In-app authorization:** `notifications.byUser` rows are the recipient's; the inbox query
  resolves the caller's identity (`ctx.auth?.getUserId()` when auth is composed, else the raw
  identity) and returns only that user's rows — a user can't read another's inbox. `markRead`
  is ownership-checked.
- **Idempotency correctness:** the receipt is written in the SAME transaction as the `messages`
  rows (consume-before-validate discipline); a concurrent duplicate send with the same key
  resolves to one winner under single-writer OCC.
- **In-app is instant + reactive; email/SMS are queued** — the send mutation never does I/O
  (deterministic), so it composes with the reactive engine without write amplification.

## Testing

- Component-level (`@stackbase/test`): send writes the right `messages` rows + status; in-app
  send writes the `notifications` row synchronously (visible to a query in the same test); the
  driver sweeps a queued email/SMS row and marks it sent via a capture provider; idempotency —
  a replay with the same key returns the recorded messageIds and does NOT re-send (capture
  provider asserts one send); a failed provider marks the row `failed`; the inbox query returns
  only the caller's rows; `markRead` flips `read` + is ownership-checked; unread count is correct.
- Provider adapter unit tests: `resendEmail`/`twilioSms` request shape against a mocked fetch
  (auth header, payload, idempotency-key passthrough, error-on-non-2xx); `consoleEmail` output.
- E2E through the real `stackbase dev` server (`packages/cli/test/notifications-e2e.test.ts`):
  a capture provider composed via `defineNotifications`; a client mutation calls
  `ctx.notifications.send` for an in-app + email; a LIVE `useNotifications` subscription sees the
  in-app notification appear reactively; the driver delivers the email (capture provider records
  it); `markRead` fans out reactively (the unread count drops live). The reactive-inbox proof is
  the headline.
- Client tests for `useNotifications`/`markRead` (the react helper over the generated queries).

## Docs

`docs/enduser/build/notifications.md` (new): the component setup (`defineNotifications`, the
console/Resend/Twilio providers), `ctx.notifications.send`, the inline template shape, the
reactive in-app inbox (`useNotifications`/`<Inbox>`), and the honest N1 boundary (what's deferred
to N2–N4). Native `@stackbase/*` imports only.

## Non-goals (N1 — deferred to later arc slices)

- Delivery **webhook ingestion** + cross-provider status normalization (delivered/bounced/
  opened) — **N2**.
- **Retries** on failed sends (N1 marks failed terminally) — **N2**.
- **Preferences** (per-user channel/category opt-outs) + the **critical-bypass** + multi-channel
  **routing/fallback** + **topics/groups** — **N3**.
- **Digest/batching** + refactoring **auth** to send through the notification seam — **N4**.
- A markup/visual **template registry** (Liquid/MJML) — post-arc; inline typed functions in v1.
- Push channel (FCM/APNs/Expo) — post-arc (the seam supports adding it as a new channel).

## Reference implementations consulted

Novu (`IProvider`/per-channel-`sendMessage`, the separate `apps/ws` inbox service we deliberately
do NOT replicate), Knock (message status axes, the inbox feed), Convex components
(`@convex-dev/resend`/`twilio`: durable send + status-rows-in-DB + idempotency + the reactive
inbox as a pattern — the closest precedent), Courier (channel/provider layering). Full survey +
citations in the session research record. The reactive in-app inbox is the deliberate
differentiator: competitors build a realtime service for it; for us it is a table + a live query.
