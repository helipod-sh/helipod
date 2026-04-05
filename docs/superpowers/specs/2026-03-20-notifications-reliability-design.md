# Notifications N2 — delivery reliability (design)

**Date:** 2026-03-20
**Status:** Approved (decided per the standing "take decisions, don't ask, build" directive)
**Arc context:** Slice N2 of the four-slice notification arc — N1 substrate + reactive inbox
(shipped, main `275ba7d`), **N2 delivery reliability** (this), N3 preferences + routing + topics,
N4 digest/batching + auth unification. N2 makes the queued-send path *durable and observable*: a
transient failure retries, a crashed send is reclaimed, and each provider's delivery outcome
(delivered/bounced/opened) flows back as normalized reactive status.

**Goal:** Add three reliability capabilities to `@stackbase/notifications`, all self-contained in
the component (no new component dependency — the retry/backoff math is copied in, like N1 copied
`compact`): (1) **retries with exponential backoff** on retryable send failures plus **reclaim of
stuck `"sending"` rows** (the crash recovery N1 explicitly deferred); (2) **inbound delivery
webhooks** (Resend, Twilio) on the engine's `httpRoutes` seam, with per-provider signature
verification; (3) **cross-provider status normalization** into one two-axis status model.

**Research grounding:** the scheduler's `computeBackoff` (`components/scheduler/src/backoff.ts` —
pure exponential + seeded jitter, `retryable`-classified failures, dead-letter) is the reuse
target for retry timing. The `httpRoutes` engine seam (`ComponentDefinition.httpRoutes`, added by
auth A3, `ComponentHttpRoute { method, pathPrefix, handler }`) is how auth mounts its OAuth callback
and is exactly how N2 mounts its webhook endpoint. Knock's two-axis message status (send lifecycle
vs. provider-reported delivery) is the normalization model adopted. Provider webhook auth:
**Resend** signs with Svix (HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`, secret
`whsec_…`); **Twilio** signs with `X-Twilio-Signature` (HMAC-SHA1 over the full URL + POST params
sorted by key, keyed by the account auth token).

## Locked design decisions

1. **Retries live in the notifications driver, not routed through `@stackbase/scheduler`.** The N1
   driver already owns the send lifecycle; coupling notifications to the scheduler component (which
   N1 does not require) would be a heavier dependency than the feature warrants. The scheduler's
   `computeBackoff` (34 lines, pure) is **copied into** `components/notifications/src/backoff.ts`,
   the same self-containment choice N1 made for `compact`. The `messages` row carries its own
   attempt/backoff state; the existing driver sweep and `driverIntervalMs` timer drive retries.
2. **A failed send is retryable-by-default, terminal after `maxAttempts`.** On a provider throw the
   driver classifies: a `NotificationSendError({ retryable: false })` (or a 4xx the adapter maps to
   one) is **terminal immediately** (`failed`); anything else is **retryable**. On a retryable failure
   the row does `attempts++` (post-increment), and while `attempts < maxAttempts` re-queues
   (`sending → queued`, `nextAttemptAt = now + computeBackoff(attempts)`); at the cap
   (`attempts >= maxAttempts`) it **dead-letters** to `failed` with the last error. `_peekQueued` is extended to return only `queued` rows whose
   `nextAttemptAt` is null or `<= now`, so a backed-off row is not swept early. `maxAttempts`
   default **4**, configurable per `defineNotifications({ retry: { maxAttempts, initialBackoffMs,
   base } })`.
3. **Stuck-`"sending"` rows are reclaimed by a lease timeout** (closes the N1-deferred crash
   recovery). A `messages` row carries `claimedAt` (set when `_claimForSend` flips `queued →
   sending`). Each driver pass, before peeking queued work, `_reclaimStuck` sweeps rows where
   `status = "sending"` AND `claimedAt + reclaimLeaseMs < now` back to `queued` (counting an
   attempt, so a row that repeatedly crashes mid-send still dead-letters rather than looping
   forever). `reclaimLeaseMs` default **60000**. This also resolves the N1 review's payload-at-rest
   privacy note: a reclaimed row is eventually delivered or dead-lettered, and `_markResult`/dead-
   letter clears `payload`. **Single-node** lease (wall-clock, one writer); fleet multi-driver
   claim/lease remains N3+/deferred and is called out.
4. **Inbound webhooks mount on the `httpRoutes` seam at `POST /api/notifications/webhooks/:provider`.**
   `defineNotifications` contributes `httpRoutes: [{ method: "POST", pathPrefix:
   "/api/notifications/webhooks/", handler: "webhookHttp" }]` when any channel's provider declares a
   `webhook`. The `webhookHttp` httpAction parses `:provider` from the sub-path, resolves the
   configured provider for that name, **verifies the signature (401 on failure, before any write)**,
   parses the payload into normalized events, and applies each to the matching `messages` row. The
   reserved `/api/*` prefix is engine-owned; `/api/notifications/…` is claimed by this component's
   route (the same reserved-prefix guard auth's route passes).
5. **The provider seam gains an optional `webhook` sub-interface.** `NotificationProvider` stays
   `{ channel, send }`; a provider that supports delivery callbacks additionally implements
   `webhook?: { verify(args: { headers, rawBody, url, secret }): boolean; parse(rawBody: string):
   WebhookEvent[] }`, where `WebhookEvent = { providerMessageId: string; deliveryStatus:
   DeliveryStatus; at?: number; detail?: string }`. **`resendEmail`** and **`twilioSms`** gain a
   `webhook` (Svix / `X-Twilio-Signature`); each takes its verification secret from config
   (`webhookSecret` on the channel, or the twilio auth token already in the adapter). Console/dev
   providers have no `webhook` (no route mounted for a dev-only setup).
6. **Two-axis status normalization** (Knock's model). N1's `messages.status` (send lifecycle:
   `queued/sending/sent/failed`) is **untouched** — it remains driven solely by the send path. N2
   adds `messages.deliveryStatus` (provider-reported), a normalized `DeliveryStatus` enum:
   `delivered | bounced | complained | opened | clicked | dropped | failed_permanent`. Each
   provider's `webhook.parse` maps its own vocabulary (Resend `email.delivered`/`email.bounced`/
   `email.complained`/`email.opened`/`email.clicked`; Twilio `delivered`/`undelivered`/`failed`) to
   this enum. A webhook write is idempotent and **status-monotonic** — a later terminal status never
   regresses to an earlier one, and a redelivered identical event is a no-op. Both fields are
   `messages`-row writes → reactive.
7. **`providerMessageId` is the webhook correlation key.** The N1 send path already records the
   provider's returned id on the row (`_markResult` sets `providerMessageId`); N2 adds a
   `byProviderMessageId` index so a webhook resolves its target row in one lookup. An event whose id
   matches no row is dropped (logged) — not an error (out-of-order/foreign delivery).
8. **All timestamps/attempt-state via `ctx.now()`; backoff jitter via `ctx.random`** (the seeded
   PRNG), so the retry decision is deterministic-for-replay exactly as the scheduler's is. No
   `Date.now()`/`Math.random()` in the mutation path.

## Schema changes (additive — the additive-schema gate accepts them)

`messages` gains (all optional, so existing rows and the N1 additive-deploy rule are satisfied):
- `attempts?: number` — retryable-failure count (absent = 0).
- `nextAttemptAt?: number` — earliest next sweep time for a backed-off `queued` row (absent =
  eligible now).
- `claimedAt?: number` — set when `queued → sending`; drives reclaim.
- `deliveryStatus?: DeliveryStatus` — the provider-reported normalized status (axis 2).
- `deliveryDetail?: string` — optional provider detail (bounce reason, etc.).
- New index `byProviderMessageId` (`["providerMessageId"]`) — webhook correlation.

`maxAttempts` is config, not a per-row field (uniform per deployment); `reclaimLeaseMs` and the
backoff params likewise live in `NotificationsConfig`.

## The retry/reclaim driver (extends N1's `driver.ts`)

The N1 driver's pass gains two things, before/around the existing peek-claim-deliver-mark loop:
1. **Reclaim** (`_reclaimStuck`, a mutation): sweep `status="sending"` rows with `claimedAt +
   reclaimLeaseMs < now` back to `queued` (`attempts++`, clear `claimedAt`). Bounded batch.
2. **Backoff-aware peek** (`_peekQueued` extended): return `status="queued"` email/SMS rows where
   `nextAttemptAt` is null or `<= now`. The driver's timer (`driverIntervalMs`) already re-wakes, so
   a backed-off row is picked up on a later pass; the driver also arms a timer at the earliest
   `nextAttemptAt` when the peek skips backed-off rows (so a long backoff isn't missed between
   commits). `_claimForSend` additionally stamps `claimedAt = now`.
3. **Result handling** (`_markResult` extended): on success → `sent` (+ clear payload) as N1. On a
   failure it first does `attempts++` (so `attempts` is the count of delivery attempts made,
   post-increment). Then: a **retryable** failure with `attempts < maxAttempts` → `queued`,
   `nextAttemptAt = now + computeBackoff(attempts, ctx.random, backoffOpts)`, **keep payload**
   (needed for the resend). A **non-retryable** failure, OR `attempts >= maxAttempts` → dead-letter
   to `failed` (+ clear payload, set last error). So `maxAttempts` is the total number of delivery
   attempts before dead-lettering (default 4 = the first send + 3 retries). The retryable
   classification comes from the driver catching the provider throw: a `NotificationSendError`
   carries `retryable`; any other throw defaults retryable.

Crash-safety unchanged in shape: a claim precedes the network call; `_peekQueued` never returns
`sending`; the NEW reclaim path is what eventually recovers a crashed `sending` row (N1 left it
terminal). Single-node.

## The webhook path

- **Route:** `POST /api/notifications/webhooks/:provider` via `httpRoutes` (mounted only when a
  configured provider declares a `webhook`). `webhookHttp` (an httpAction in the component) reads the
  raw body + headers, extracts `:provider` from the sub-path, looks up the configured provider by
  channel/name, and calls `provider.webhook.verify(...)`. **Verify fails → 401, no write.**
- **Apply:** for each parsed `WebhookEvent`, look up the `messages` row by `byProviderMessageId`; if
  found, apply a **monotonic** `deliveryStatus` update (via an internal `_applyWebhookEvent`
  mutation — reactive). No matching row → log + 200 (ack, so the provider stops retrying). Parse/verify
  errors → 4xx.
- **Idempotency:** the update is keyed by `(providerMessageId, deliveryStatus)` monotonicity, so a
  redelivered webhook is a no-op; no separate receipt table needed (unlike the send path, a delivery
  event is naturally idempotent by target+status).

## Provider `webhook` implementations

- **`resendEmail`** — `webhook: { verify }` implements Svix verification: HMAC-SHA256 over
  `${svix-id}.${svix-timestamp}.${rawBody}` with the base64 secret from `whsec_…`, constant-time
  compared to the `svix-signature` header (space-separated `v1,<sig>` list); timestamp-skew guard.
  `parse` maps Resend event types → `DeliveryStatus`. Secret from the channel config
  (`email.webhookSecret`).
- **`twilioSms`** — `webhook: { verify }` implements `X-Twilio-Signature`: HMAC-SHA1 over the full
  request URL followed by each POST param appended in **key-sorted** order, base64, constant-time
  compared. `parse` maps `MessageStatus` (`delivered`/`undelivered`/`failed`) →
  `DeliveryStatus`. Keyed by the existing auth token (no new secret).
- Signature crypto uses the platform's existing primitives (`node:crypto`/WebCrypto, as auth's
  hashing does) — no new dependency.

## Security / correctness

- **Signature verification is mandatory and precedes any state change** — an unverified or
  malformed webhook is rejected (401/4xx) before a row is touched, so a forged callback can't mark a
  message delivered/bounced. Constant-time comparison; timestamp-skew rejection (replay).
- **No secret leakage:** the webhook secret / auth token lives in the provider config closure, never
  in a row or an error string (the N1 twilio-error discipline extended).
- **Monotonic status** prevents a replayed or out-of-order `opened`-then-`delivered` from regressing
  a terminal `bounced`.
- **Reclaim counts an attempt**, so a row that always crashes mid-send dead-letters instead of
  looping (bounded work); the reclaim sweep is batch-capped.
- **Retries preserve at-most-once semantics:** a retry re-runs delivery for a row that was NOT
  confirmed sent (`markResult` only reaches `sent` on a provider success); the auto `msg:<id>`
  provider Idempotency-Key (N1) means a supporting provider dedups a retry that actually did send
  but whose ack was lost.

## Testing

- **Retry/reclaim (component-level, `@stackbase/test`/inline runtime):** a capture provider that
  fails N times then succeeds → the row retries with backoff and lands `sent` after the right
  attempt count; a permanently-failing provider dead-letters at `maxAttempts`; a non-retryable
  error fails on the first attempt (no retries); a row stuck `sending` past the lease is reclaimed
  and delivered; reclaim counts attempts (a perpetually-crashing row dead-letters). Backoff math has
  its own pure unit test (like the scheduler's).
- **Webhook verification (adapter unit tests):** Resend Svix — a correctly-signed payload verifies,
  a tampered body/sig fails, a stale timestamp fails; Twilio `X-Twilio-Signature` — a correctly
  computed signature verifies, wrong token fails; `parse` maps each provider vocabulary to the right
  `DeliveryStatus`.
- **Status normalization + monotonicity (component-level):** applying a `delivered` then a stale
  `sent`-class event does not regress; an unknown `providerMessageId` is a no-op; a redelivered
  identical event is a no-op.
- **E2E through the real dev server** (`packages/cli/test/notifications-reliability-e2e.test.ts`):
  a capture provider fails once then succeeds → a live status subscription observes the row go
  `queued → (retry) → sent`; a POST to `/api/notifications/webhooks/<provider>` with a valid
  signature flips `deliveryStatus` to `delivered` reactively (a live subscription sees it), and an
  invalid signature is 401 with no change. The reactive delivery-status proof is the headline.

## Docs

Extend `docs/enduser/build/notifications.md` with a **Delivery reliability** section: retries + the
`retry` config, the reclaim behavior, setting up a provider webhook (the endpoint URL, where to put
the signing secret, per-provider setup for Resend/Twilio), and the `deliveryStatus` field + how to
surface delivered/bounced in an app. Update the N1 "what's deferred" list (retries + webhooks move
from deferred to shipped; preferences/routing/topics remain N3, digest/auth-unify N4).

## Non-goals (N2 — deferred)

- **Preferences / routing / fallback / topics** — N3.
- **Digest / batching** + **auth unification** — N4.
- **Fleet multi-driver claim/lease** for retries/reclaim — the reclaim lease is single-node
  wall-clock; a multi-node fleet needs an owner/lease check (deferred, called out, same boundary as
  N1's driver).
- **Enabling provider-side open/click tracking config** — N2 *ingests and normalizes* whatever the
  provider sends; it does not turn on Resend/Twilio open-tracking for you (a provider dashboard
  setting).
- **A generic webhook framework** for arbitrary providers — N2 ships Resend + Twilio verification;
  a third provider adds its own `webhook` on the seam (the extension point exists, but no generic
  signature-scheme registry is built).
- **Retry of `in_app`** — in_app never enters the queue (it's written `sent` synchronously), so it
  has no retry/webhook path; reliability applies to email/SMS only.

## Reference implementations consulted

Convex `@convex-dev/resend` (durable retries + Svix webhook ingestion + status rows — the closest
precedent), `@convex-dev/twilio` (status-callback ingestion), Knock (two-axis message status),
`@stackbase/scheduler` (the `computeBackoff` + dead-letter + `retryable` pattern reused here), and
`@stackbase/auth`'s A3 `httpRoutes` usage (the webhook-route mechanism).
