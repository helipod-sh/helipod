# Notifications N4 — digest + auth unification (design)

**Date:** 2026-03-20
**Status:** Approved (decided per the standing "take decisions, don't ask, build" directive)
**Arc context:** The FOURTH and FINAL slice of the notification arc — N1 substrate + reactive inbox
(main `275ba7d`), N2 delivery reliability (main `453d340`), N3 preferences + topics (main `aa3c3ca`),
**N4 digest + auth unification** (this). N4 delivers the arc's north star — routing `@stackbase/auth`'s
transactional emails through the one notification delivery path — plus email digest batching.

**Goal:** Two INDEPENDENT capabilities: (A) **auth unification** — `@stackbase/auth`'s OTP/magic-
link/verification/reset emails route through `ctx.notifications.send` (gaining N2 retries+reclaim,
the shared providers, a unified sender) when notifications is composed, falling back to auth's own
`EmailProvider` otherwise; (B) **email digest** — a category can buffer its email sends and deliver a
combined per-recipient digest on a rolling schedule instead of one email per send.

**Research grounding:** auth's email seam (`components/auth/src/email/provider.ts` — `EmailProvider {
send(msg): Promise<void> }`, distinct from notifications' `{channel, send}`) and its send call site
(`components/auth/src/functions.ts:503-517`, `requestAction` → `e.provider.send({to, from,
...rendered})` inside an ACTION); the notifications `recordSend` gate + N3 critical-bypass; the
`buildAction` seam (a composed component's action facade is attached as `ctx[name]` inside an action,
so auth's action ctx sees `ctx.notifications` when composed); the recurring-driver seam
(`DriverContext.onCommit`/`setTimer`/`now`) reused for the digest flush, exactly as N1/N2's send
driver.

## Part A — Auth unification

### Locked decisions

A1. **A server-authority `critical?: boolean` on `SendArgs`.** N3 made criticality config-declared
   (a category is critical or not) so a client can't force a preference bypass. N4 adds a per-send
   `critical` override for TRANSACTIONAL sends (auth's OTP): `args.critical === true` bypasses the
   preference gate for every channel, in addition to a config-critical category. It is
   SERVER-AUTHORITY — set only by server-side code (auth's action, an app mutation), never forwarded
   from client input (documented exactly like `to.userId`/`category`; the app owns the trust
   boundary, same as it already does for the recipient). A client cannot reach `send` directly; it
   calls an app function that decides the args.

A2. **The gate honors `critical`.** `recordSend`'s gate becomes: suppress iff `userId` present AND
   NOT `isCritical(config, category)` AND NOT `args.critical` AND the resolved preference is off.

A3. **Auth routes through notifications when composed, else falls back — no hard dependency.** In
   `requestAction` (`functions.ts`), the `e.provider.send(...)` call is replaced by: if the action's
   `ctx.notifications` facade is present (notifications composed), call
   `ctx.notifications.send({ to: { email: decision.email }, channels: ["email"], template: { email:
   rendered }, category: config.email.notificationCategory ?? "auth", critical: true })`; else the
   existing `e.provider.send({ to, from, ...rendered })` (unchanged). Auth defines a MINIMAL local
   `NotificationsSendFacade` interface (just the `send` shape it calls) and duck-types
   `ctx.notifications` — it does NOT import `@stackbase/notifications` (no dependency, no compose
   requirement). `critical: true` guarantees the OTP always sends regardless of the recipient's
   preferences; the `"auth"` category is what a preference center would show (and could be made
   config-critical too, but `critical: true` makes it unconditional).

A4. **Graceful + inert by default.** An auth deployment WITHOUT notifications composed behaves
   byte-for-byte as today (the `ctx.notifications` presence check is false → the `e.provider.send`
   fallback). The `from` used when routed is the notifications channel's configured `from` (a single
   unified sender identity), not auth's `e.from` — an intended consequence of unification, documented.

A5. **Anti-enumeration preserved.** `requestAction` still returns `{ sent: true }` ALWAYS, whichever
   path sends — the routing is invisible to the caller (no new failure surface, no enumeration
   oracle). A routed send is queued (fire-and-forget, driver delivers + retries), matching auth's
   existing "issue then send, always report sent" shape.

## Part B — Email digest

### Locked decisions

B1. **Digest is EMAIL-only in N4** (the clear use case: one daily summary instead of 20 emails).
   `in_app` is NEVER digested — the reactive inbox is already the live batched view. SMS digest is
   deferred. A CRITICAL send/category is never digested (always immediate).

B2. **A category opts into digest via config**: `categories: { updates: { digest: "hourly" |
   "daily" | "weekly" } }`. The frequency maps to a rolling window (`hourly`=1h, `daily`=24h,
   `weekly`=7d). Absent → the category sends immediately (N1–N3 behavior, unchanged).

B3. **A digest-category email send BUFFERS instead of enqueuing.** In `recordSend`, for `channel ===
   "email"` when `digestWindowMs(config, category)` is set AND the send is not critical: write a
   `digestBuffer` row `{ recipientKey, category, subject, text, html?, createdAt, flushedAt? }`
   (`recipientKey` = `to.userId ?? to.email` — a stable per-recipient key) INSTEAD of the `queued`
   `messages` row. The channel is reported in neither `messageIds` (nothing sent yet) nor
   `suppressed` (it's deferred, not suppressed) — the send returns a `deferred?: Channel[]` addition
   so the caller can see it was buffered.

B4. **A digest driver flushes on a rolling window.** Built on the recurring-driver seam (like the
   send driver): each pass, group un-flushed `digestBuffer` rows by `(recipientKey, category)`; for a
   group whose OLDEST un-flushed item is older than the category's window, CLAIM the group (mark its
   items `flushedAt = now` in one txn — the claim guard, so a crash can't double-flush), render a
   combined digest via the category's `digestTemplate((items) => EmailContent)`, and `recordSend` ONE
   email to the recipient (preference-checked AT FLUSH — a recipient who opted the category out
   between buffering and flush is honored; a critical override is NOT used here — digest is
   non-critical by definition). The flushed email is a normal queued send (N2 driver delivers +
   retries). Single-node; fleet multi-driver deferred (same boundary as the send driver).

B5. **`digestTemplate` is a per-category config function** `(items: DigestItem[]) => EmailContent`,
   where `DigestItem = { subject, text, html?, createdAt }` — the app renders the list into one
   email (e.g. "You have 12 updates: …"). A default template (a simple concatenation) is provided so
   a category can opt into digest with only `digest: "daily"` and no template.

B6. **Idempotent, bounded flush.** The claim (`flushedAt` set in a txn before rendering) makes a
   crash-after-claim leave the items flushed (they won't re-flush) — worst case a crash after claim
   but before the `recordSend` loses that one digest (terminal, like the send driver's stuck-sending
   in N1; a reclaim is a deferred follow-up). Bounded batch per pass. Rendering/`recordSend` for the
   flushed email is deterministic (runs in the driver's mutation, no wall-clock beyond `ctx.now()`).

## Component surface

`SendArgs` gains `critical?: boolean` (A1); `send`/`sendNow` return `{ messageIds, suppressed,
deferred? }` (B3). Config `categories[cat]` gains `{ critical?, digest? }` and a per-category
`digestTemplate?`. `NotificationsConfig` resolves a `digestWindowMs(category)` helper + the digest
templates. The digest driver is added to `defineNotifications` (always composed when any category has
`digest`, else inert). Auth (`@stackbase/auth`) gains the `ctx.notifications`-routing in
`requestAction` + an optional `email.notificationCategory` config.

## Schema (additive)

- `digestBuffer`: `{ recipientKey, category, subject, text, html?, createdAt, flushedAt? }`, indexes
  `byUnflushed` (`["flushedAt"]` — the driver scans `flushedAt = null`; note optional-field index
  semantics, mirror the N2 `byStatus` pattern) and `byRecipientCategory` (`["recipientKey",
  "category"]` — group a recipient's items). All additive.

## Security / correctness

- **`critical` is server-authority**, the same trust boundary as `to.userId`/`category` — an app must
  not forward it from client input; a client cannot reach `send` directly. Documented prominently.
- **Auth unification adds no attack surface**: the routed send is the same `recordSend` path, and
  `critical: true` only bypasses PREFERENCES (never auth's own anti-enumeration/rate-limit guards,
  which run before the send in `_issueCode`). The fallback path is byte-identical to today.
- **Digest honors preferences at FLUSH** (the latest opt-out wins), and never digests a critical
  send — so a transactional email is never delayed into a digest.
- **Idempotent flush** (claim-before-render) — no double-send of a digest; the N1 receipt still
  guards the flushed `recordSend` if a broadcast key is derived.
- **No secret/PII beyond N1–N3**: `digestBuffer` holds rendered content (like `messages.payload`);
  a flushed/old buffer is cleaned by the flush (a reaper for crash-orphaned claimed rows is deferred).

## Testing

- **Part A (auth unification):** with notifications composed, an auth `requestVerification` routes
  through `ctx.notifications` — a message row is written for the email (and it's `critical`, so a
  recipient who opted "auth" out STILL gets it); without notifications, `e.provider.send` is called
  (a capture provider records it) — the fallback is unchanged. Proven E2E through the real dev server
  (`packages/cli/test/notifications-auth-unify-e2e.test.ts`): compose auth + notifications with a
  capture email provider; call an auth email flow; the capture provider receives the OTP via the
  notification driver (not auth's own provider); a preference opt-out of "auth" does NOT suppress it.
- **`critical` gate (component-level):** `send({ critical: true })` to an opted-out `(category,
  channel)` is NOT suppressed; `critical` interacts correctly with a config-critical category.
- **Part B (digest, component-level):** a digest-category email send writes a `digestBuffer` row (no
  `messages` row) and reports `deferred: ["email"]`; the driver does NOT flush before the window;
  after the window it flushes a combined email (one `messages` row via the digest template) and marks
  items flushed; a second pass does not re-flush; a recipient who opts out between buffer and flush is
  suppressed at flush; in_app on a digest category is immediate (not buffered); a critical send on a
  digest category is immediate. E2E (`packages/cli/test/notifications-digest-e2e.test.ts`): buffer
  three emails, advance the driver past the window, one combined email is delivered by the capture
  provider.
- Digest-template default (concatenation) unit test.

## Docs

`docs/enduser/build/notifications.md`: **Auth unification** (compose auth + notifications → auth
emails flow through the one path with retries/shared-provider; the `critical` server-authority flag;
the fallback) and **Digest** (`categories: { x: { digest: "daily" } }` + `digestTemplate`, email-only,
the rolling window, preference-at-flush). Update the scope banner (N4 = final) + "what's deferred":
digest + auth-unification → shipped; remaining deferrals (SMS/in_app digest, per-user digest
frequency, provider-fallback, time-based routing) noted post-arc.

## Non-goals (N4 — deferred)

- **SMS / in_app digest** — email-only in N4.
- **Per-user digest-frequency preference** — config-level frequency per category only.
- **Threshold-count batching** ("digest after N items") — rolling-time-window only.
- **A reaper for crash-orphaned claimed digest rows** — a flush crash after claim loses that one
  digest (terminal, like N1's stuck-sending); reclaim is a follow-up.
- **Multi-provider fallback + time-based multi-channel routing** — still deferred (delivery mechanics,
  from N3).
- **Auth REQUIRING notifications** — auth stays independently usable; unification is graceful/opt-in.

## Reference implementations consulted

Knock/Novu digest (batch window + a digest renderer), the auth A2 email seam + `requestAction` send
site, the N1 `recordSend` chokepoint + N2 driver seam (reused for the digest flush), and the
`buildAction` composed-facade mechanism (auth reaching `ctx.notifications`).
