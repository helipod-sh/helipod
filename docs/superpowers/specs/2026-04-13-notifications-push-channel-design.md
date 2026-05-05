# Notifications — push channel (Expo / FCM / APNs) (design)

**Date:** 2026-04-13
**Status:** Approved (decided per the standing "take decisions, don't ask, build" directive)
**Arc context:** A **post-arc follow-on** to the four-slice notification arc (N1 substrate, N2
reliability, N3 preferences/topics, N4 digest/auth-unification — all shipped, main). N1's own
non-goals list named this explicitly: *"Push channel (FCM/APNs/Expo) — post-arc (the seam supports
adding it as a new channel)."* This slice cashes that in: a fourth channel, `"push"`, on the
existing Channel × Provider seam, with its own device-token registry and three provider adapters.
It is additive throughout — a project that doesn't configure `channels.push` sees zero new surface.

**Goal:** Ship push notifications (mobile/web) through `@stackbase/notifications`, reusing every
existing mechanism (queued delivery, N2 retry/backoff/reclaim, N3 preferences/critical-bypass,
topics) rather than building a parallel pipeline. Add: (1) a `pushTokens` device-token registry +
self-service registration, (2) a `"push"` channel with multi-token fan-out per logical send, and
(3) three provider adapters — `expoPush()`, `fcmPush()`, `apnsPush()` — with invalid-token pruning
on provider-reported "unregistered" responses (no webhook needed; push providers report this
synchronously in the send response, unlike email/SMS engagement events).

**Research grounding:**
- **Expo Push API** — one HTTP endpoint (`POST https://exp.host/--/api/v2/push/send`), accepts an
  ARRAY of messages (`{to, title, body, data, ...}`) in one request (capped at 100 messages/request
  — the adapter chunks), returns an array of "tickets" (`{status:"ok", id}` or `{status:"error",
  message, details:{error}}`, with `details.error === "DeviceNotRegistered"` the invalid-token
  signal). Handles routing to APNs/FCM internally for Expo-format tokens — the simplest possible
  first adapter, and Expo explicitly recommends it as the default for Expo/React Native apps.
- **FCM HTTP v1** (`POST https://fcm.googleapis.com/v1/projects/{projectId}/messages:send`) —
  per-token request (`{message: {token, notification:{title,body}, data}}`), OAuth2 Bearer auth via
  a Google service-account JSON key (no static API key — v1 retired the legacy server-key scheme).
  A 404/`UNREGISTERED` (or `NOT_FOUND`) response error code is the invalid-token signal.
- **APNs provider API** (`POST https://api.push.apple.com/3/device/{deviceToken}`, HTTP/2 only —
  Apple's provider API mandates h2 and has no HTTP/1.1 fallback) — token-based auth via an ES256 JWT
  signed with an Apple-issued `.p8` key (`kid`=Key ID, `iss`=Team ID), refreshed at most once/hour
  per Apple's guidance. A `410 Gone` with reason `Unregistered`, or `400` with `BadDeviceToken`, is
  the invalid-token signal.
- Prior art surveyed for the routing/multi-provider shape: Novu (`IChannel` push provider arms:
  FCM/APNs/Expo/OneSignal, one active provider per platform), OneSignal (single unified send API
  hiding FCM/APNs behind it — the Expo-for-push-generally pattern), Knock (push channel = device
  tokens + a provider-per-token model, closest to what's adopted here).

## Locked design decisions

1. **`"push"` extends `Channel`** (`"email" | "sms" | "in_app" | "push"`). It is not a new
   mechanism — it plugs into the existing `recordSend` chokepoint, the N2 queued-delivery driver
   (retry/backoff/reclaim), and the N3 preference/critical-bypass gate for free, because those are
   all already `Channel`-generic. Push is **never digested** (like `in_app` — the N4 digest branch
   is `channel === "email"`-gated only; push stays immediate).

2. **Device-token registry**: a new `pushTokens` table `{ userId, token, provider, platform?,
   createdAt }`, with SELF-ONLY, client-callable `registerPushToken({ token, provider, platform?
   })` / `unregisterPushToken({ token })` — the caller's own id is resolved server-side
   (`callerId`, the same helper `subscribe`/`unsubscribe`/`markRead` use), **never a client-supplied
   `userId` argument** (the N3 IDOR lesson: a client-callable module that accepted a `userId` arg
   would let any caller register/unregister ANY user's device). A server-controlled `userId?`
   override lives only on the mutation facade (`ctx.notifications.registerPushToken`), reachable
   exclusively from server-authored code — the exact two-transports-one-core split `subscribe`/
   `unsubscribe` already established.
   - **Registration is an upsert keyed by `token`, not `(userId, token)`.** A device token
     physically identifies one installation; when a different user logs into the same device
     (reinstall, account switch), the token should route to the NEW user, not accumulate stale
     rows for the old one. `registerPushToken` overwrites any existing row for that exact token
     (reassigning `userId`/`provider`/`platform`), matching how a physical device can only ever
     belong to whoever is currently logged into it.
   - `unregisterPushToken` is ownership-checked (a caller can only remove their OWN token row —
     mirrors `markRead`'s ownership check), a no-op if the token isn't theirs or doesn't exist.

3. **Token → provider routing is by a `provider` field recorded AT REGISTRATION** (`"expo" | "fcm"
   | "apns"`), not by OS platform. The two are orthogonal: an iOS device can hold an Expo token OR
   a raw APNs token depending on which SDK/flow the app uses; `platform` (`"ios" | "android" |
   "web"`, optional) is kept as diagnostic/UX metadata only, never used for routing. Config:
   `channels.push.providers: { expo?: PushProvider; fcm?: PushProvider; apns?: PushProvider }` — a
   map, not a single provider (unlike email/sms's one-provider-per-channel), because a real app
   frequently runs Expo-managed and bare-native builds side by side, or migrates between them, and
   both need to keep working. `defineNotifications` throws at construction time if `channels.push`
   is set but the `providers` map is empty (a fail-fast config-bug guard, mirroring the existing
   `hasWebhook`-without-`webhookSecret` warning's spirit, but hard-erroring since an empty map would
   silently drop every push forever).

4. **One `messages` row per logical push send, not per token.** Matches the existing model (one row
   per send × channel). The row's `to` is the recipient's `userId` (exactly like `in_app`'s
   addressing); `resolveAddress("push", to)` requires `to.userId`, same assertion shape as
   `in_app`. Multi-token, potentially multi-PROVIDER fan-out is a DELIVERY-time concern (the
   driver), grouped by each token's recorded `provider`.
5. **The token list is snapshotted inside `recordSend`'s own transaction** — a fresh `db.query
   ("pushTokens","byUser").eq("userId", to.userId).collect()` read at enqueue time, stored on the
   row (`messages.tokens`, additive/optional). This is the SAME discipline `resolveAddress` already
   uses for email/phone (resolve the address once, at enqueue, inside the transaction) — not a new
   idea, just applied to a token LIST instead of a single string. Trade-off, stated plainly: a
   device registered after this send's enqueue but before the driver's next pass will not receive
   THIS particular send (it will receive the next one). Given sends are typically delivered within
   one driver tick (seconds), this is an acceptable, honestly-scoped v1 boundary — re-resolving
   tokens live at delivery time was considered and rejected as unnecessary complexity for a
   marginal freshness gain.
6. **Zero registered devices is not a failure.** `recordSend` still enqueues the row (audit trail,
   consistent history across channels); the driver short-circuits to `sent` without ever calling a
   provider when the token snapshot is empty. (A user who hasn't installed/opened the app yet is
   the common case, not an error condition.)
7. **Partial multi-provider-group failure policy.** A logical send's token snapshot is grouped by
   `provider` at delivery time; each group is dispatched to its configured provider adapter
   independently. A group's provider call throwing is caught and logged per-group — **never
   re-thrown** — UNLESS every configured group in the fan-out threw, in which case the row is
   retried through the EXISTING N2 backoff/dead-letter path exactly like an email/SMS failure.
   Rationale: retrying the WHOLE row after a partial success would re-push to devices that already
   received it. Push tolerates an occasional missed device (this policy's worst case) far better
   than it tolerates duplicate pushes to devices that already got one (a whole-row retry's worst
   case) — an explicit, asymmetric choice, not an oversight. A token whose recorded `provider` isn't
   configured on `channels.push.providers` (config drift — e.g. a token registered before an admin
   removed `fcm` from the config) is skipped with a logged warning, not attempted and not pruned
   (it's a config problem, not a bad token).
8. **Invalid/unregistered token handling — no webhook needed.** Unlike email/SMS (whose engagement
   events — bounced, opened — need N2's asynchronous webhook ingestion), all three push providers
   report an invalid/unregistered token SYNCHRONOUSLY in the send response itself (Expo's ticket
   `details.error === "DeviceNotRegistered"`; FCM's `UNREGISTERED`/`NOT_FOUND` error code; APNs'
   `410`/`BadDeviceToken`). `PushProvider.send` returns an extended `PushSendResult { ...SendResult,
   invalidTokens?: string[] }`; the shared `deliverOutbound` aggregates `invalidTokens` across every
   provider group in one logical send, and the caller (the driver's pass loop, and the action
   facade's `sendNow` drain loop — the SAME two call sites that already invoke `deliverOutbound` and
   `_markResult`) makes one additional call to a new privileged internal mutation,
   `_pruneInvalidPushTokens({ tokens })`, which deletes those `pushTokens` rows by exact token match
   (`byToken` index). No `httpRoutes` entry is added for push in v1 — this is a deliberate scope cut
   from the email/sms webhook pattern, justified by the synchronous-response mechanic above.
9. **`sendToTopic` gains `"push"` as a second allowed channel.** Its N3-locked restriction to
   `Array<"in_app">` exists because a topic subscription stores only `userId` (no email/phone), so
   email/SMS fan-out can't resolve an address from it. Push resolves via `userId` too (exactly like
   `in_app` — decision 4), so it has the SAME resolvability as `in_app` and the restriction is
   widened to `Array<"in_app" | "push">` for free (one type change + one error-message update in
   `facade.ts`; no new mechanism).
10. **Preferences and critical-bypass apply to push automatically** (N3's `resolvePreference`/
    `isCritical`/the `recordSend` gate are already generic over `Channel`, and `Channel` now has
    four members). A `notificationPreferences` row with `channel: "push"` (or category-wide)
    behaves identically to an email/sms/in_app one. `getPreferences`'s client-facing `channel` type
    (`packages/client/src/notifications.tsx`) widens to include `"push"`.
11. **Content shape: `PushContent { title: string; body: string; data?: Record<string, unknown> }`.**
    Inline typed templates, matching the existing per-channel authoring style:
    `PushTemplateFn = (data) => PushContent`, `channels.push.templates?: PushTemplates`, and
    `InlineTemplate.push?: PushContent` for ad-hoc (non-registered-key) sends. This is deliberately
    NOT a rich-payload API — no `sound`/`badge`/`priority`/silent-push/`collapse-id` in v1 (see
    Non-goals). `idempotencyKey` is accepted on `PushMessage` for interface symmetry with
    `EmailMessage`/`SmsMessage` but is NOT forwarded to any of the three v1 providers — none has a
    request-level idempotency mechanism with matching semantics (Expo has none; FCM's message id is
    server-assigned, not client-supplied; APNs' `apns-collapse-id` REPLACES a still-undelivered
    notification rather than deduplicating a repeat send, a different mechanic). The shared
    `sendReceipts` guard (decision unchanged from N1) is what makes a replayed push send a no-op —
    exactly as it already is for the 6/8 email/SMS providers with no native idempotency key.
12. **Three provider adapters ship in this slice** (all three, not just Expo — see the plan's
    parallelization): `expoPush()` (fetch, auto-chunked to Expo's 100-message batch cap — the
    simplest adapter, the recommended default), `fcmPush({ projectId, serviceAccount })` (FCM HTTP
    v1; OAuth2 service-account JWT exchange via `jose`, with an in-memory cached access token
    refreshed ~5 minutes before its ~1-hour expiry), and `apnsPush({ teamId, keyId, privateKey,
    bundleId, production? })` (APNs provider API; ES256 JWT via `jose`, and **`node:http2`, not
    `fetch`** — Apple's provider API mandates HTTP/2 and Node's global `fetch` does not negotiate
    ALPN h2 to arbitrary hosts, the one adapter that can't reuse the fetch-based pattern the other
    six providers in this component all share). New dependency: `jose` (already a dependency of
    `components/auth` for JWT signing/verification — same library, no new supply-chain surface).
13. **Client surface: `registerForPush`.** A thin helper in `packages/client/src/notifications.tsx`
    (alongside `useNotifications`/`useNotificationPreferences`) that calls the well-known
    `notifications:registerPushToken` mutation — `registerForPush(client, { token, provider,
    platform? })`. Acquiring the actual OS push token (requesting permission, calling Expo's
    `Notifications.getExpoPushTokenAsync()`, a native FCM/APNs SDK, or a web-push
    `PushManager.subscribe`) is **app/platform-specific and explicitly out of scope** — the same
    "thin call, not a permission/identity framework" boundary `useNotifications` already draws for
    the inbox. `unregisterForPush(client, { token })` mirrors it for logout/opt-out flows.

## Component surface

Config addition (opt-in — a project without `channels.push` gets none of this):

```ts
defineNotifications({
  channels: {
    // ...existing email/sms/in_app...
    push?: {
      providers: { expo?: PushProvider; fcm?: PushProvider; apns?: PushProvider }; // ≥1 required
      templates?: PushTemplates;
    },
  },
})
```

`PushProvider` seam (exported for adapters, alongside the existing `EmailProvider`/`SmsProvider`):

```ts
interface PushProvider { channel: "push"; send(m: PushMessage): Promise<PushSendResult> }
interface PushMessage {
  to: string[];              // one or more device tokens for THIS provider group
  title: string;
  body: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;   // accepted for shape symmetry; unused by all three v1 adapters
}
interface PushSendResult extends SendResult {
  invalidTokens?: string[];  // provider-reported unregistered/invalid tokens — pruned by the caller
}
type NotificationProvider = EmailProvider | SmsProvider | PushProvider;
```

Provider construction (mirrors `resendEmail(opts)`/`twilioSms(opts)`):

```ts
expoPush(opts?: { accessToken?: string; baseUrl?: string }): PushProvider
fcmPush(opts: { projectId: string; serviceAccount: { client_email: string; private_key: string }; baseUrl?: string }): PushProvider
apnsPush(opts: { teamId: string; keyId: string; privateKey: string; bundleId: string; production?: boolean }): PushProvider
```

Registered modules (client-callable, self-only):
- `registerPushToken({ token, provider: "expo"|"fcm"|"apns", platform?: "ios"|"android"|"web" })` →
  `null`. Upserts by exact `token` match, resolving `userId` from the caller.
- `unregisterPushToken({ token })` → `null`. Ownership-checked delete.

Mutation facade (`ctx.notifications`) additions, server-controlled `userId?` override:
```ts
registerPushToken(args: { token: string; provider: "expo"|"fcm"|"apns"; platform?: "ios"|"android"|"web"; userId?: string }): Promise<null>;
unregisterPushToken(args: { token: string; userId?: string }): Promise<null>;
```

`send`/`sendNow` gain `"push"` as a valid `channels[]` entry with no signature change (`Channel`
already widened); `sendToTopic`'s `channels` param widens from `Array<"in_app">` to
`Array<"in_app" | "push">`.

Client (`@stackbase/client`):
```ts
registerForPush(client: StackbaseClient, args: { token: string; provider: "expo"|"fcm"|"apns"; platform?: "ios"|"android"|"web" }): Promise<void>
unregisterForPush(client: StackbaseClient, args: { token: string }): Promise<void>
```

## Schema (additive)

```ts
pushTokens: defineTable({
  userId: v.string(),
  token: v.string(),
  provider: v.union(v.literal("expo"), v.literal("fcm"), v.literal("apns")),
  platform: v.optional(v.union(v.literal("ios"), v.literal("android"), v.literal("web"))),
  createdAt: v.number(),
})
  .index("byUser", ["userId"])    // recordSend's fan-out read
  .index("byToken", ["token"]),   // registration upsert + prune-by-token + ownership check
```

`messages` table (existing — additive changes only):
- `channel` union gains `v.literal("push")`.
- New optional field `tokens: v.optional(v.any())` — the enqueue-time device-token snapshot
  (`Array<{ token: string; provider: "expo"|"fcm"|"apns" }>`), typed at the TS level, stored
  untyped like the existing `payload: v.optional(v.any())` field on the same table (which already
  holds a union of per-channel content shapes the same way). Cleared on `sent`/`failed` alongside
  `payload` by `_markResult` (nothing sensitive lives here beyond opaque token strings, but the
  clearing discipline stays uniform across every transient enqueue-time field on the row).

No table is renamed, no field is removed, no existing field's type narrows. Composing this version
of `@stackbase/notifications` onto an app that never sets `channels.push` produces zero new rows
anywhere (schema addition only manifests in the `pushTokens` table, which nothing ever writes to
without registration calls). Note: because the component set (and its schema) is fixed at boot
(CLAUDE.md's locked deploy model), an app already running an OLDER `@stackbase/notifications`
picks this up on its next restart, not via a live `stackbase deploy` push — consistent with "adding/
removing components needs a restart."

## Data flow: send → token fan-out → provider

```
ctx.notifications.send({ to: {userId}, channels: ["push"], template, data, category? })
  └─ recordSend (the ONE chokepoint, unchanged shape)
       ├─ assertConfigured(config, "push")        // channels.push must be set
       ├─ resolveAddress("push", to)               // requires to.userId (like in_app)
       ├─ N3 preference gate: resolvePreference(db, userId, category, "push")  — for free
       ├─ (push is never digest-eligible — the digest branch is email-only)
       ├─ tokenRows = db.query("pushTokens","byUser").eq("userId", userId).collect()
       ├─ content = renderPush(config, template, data)     // pure, in-tx, like renderEmail/Sms
       └─ db.insert("messages", { channel:"push", to:userId, status:"queued",
                                   payload: content, tokens: tokenRows.map(...) })
                                   // one row, whatever the token count (0..N)

notificationsDriver pass (unchanged claim/mark loop, `_peekQueued` now also selects channel:"push")
  ├─ _claimForSend(messageId)          // queued → sending, same OCC guard
  ├─ deliverOutbound({ channel:"push", to, payload, tokens, idempotencyKey })
  │    ├─ tokens.length === 0 → return {} immediately (no provider call — decision 6)
  │    ├─ group tokens by `provider` field
  │    ├─ for each group: config.channels.push.providers[kind].send({to: groupTokens, title, body, data})
  │    │    ├─ success → merge providerMessageId (first wins), collect invalidTokens
  │    │    └─ throw   → log + skip this group (decision 7), UNLESS every group throws → rethrow
  │    └─ return { providerMessageId?, invalidTokens? }
  ├─ _markResult(messageId, ok, providerMessageId, error, retryable)   // sending → sent/queued(retry)/failed
  └─ if invalidTokens.length: _pruneInvalidPushTokens({ tokens: invalidTokens })   // NEW, one extra call
```

`sendNow` (the action-facade synchronous variant) follows the identical `deliverOutbound` →
`_markResult` → (conditionally) `_pruneInvalidPushTokens` sequence inline, exactly mirroring how it
already shares `_claimForSend`/`_markResult` with the driver for email/SMS.

## Security / correctness

- **Self-only registration (IDOR guard).** `registerPushToken`/`unregisterPushToken` are
  client-callable (not `_`-prefixed) and resolve the subject exclusively from `callerId(ctx)` —
  never a request argument. This is the exact discipline `subscribe`/`unsubscribe`/`markRead`
  already enforce; a client-supplied `userId` on either module would let any authenticated (or, per
  the inbox's documented boundary, any UNauthenticated-but-token-asserting) caller register a device
  against an arbitrary victim's account and receive their pushes, or delete a victim's legitimate
  registration.
- **Ownership check on unregister** — a caller can only delete a `pushTokens` row whose `userId`
  matches their own resolved id (same shape as `markRead`'s row-ownership check); a foreign/missing
  token is a no-op, not an error (avoids leaking whether a given token string is registered to
  someone else).
- **No secret leakage.** FCM/APNs credentials (service-account private key, `.p8` signing key) live
  only in the provider closure/config, exactly like the existing Resend API key / Twilio auth
  token — never persisted to a `messages` row. Device tokens themselves are treated as
  sensitive-but-not-secret identifiers (like a phone number) — not logged in full on a delivery
  error (truncate/hash in adapter error messages).
- **Idempotency correctness unchanged.** The `sendReceipts` guard (keyed by the caller's
  `idempotencyKey`, written in the SAME transaction as the `messages`/`pushTokens`-snapshot insert)
  still resolves a concurrent/replayed send to one winner under single-writer OCC — push adds no
  new dedup mechanism, it rides the existing one.
- **Token snapshot is deterministic.** Reading `pushTokens` inside `recordSend`'s transaction is a
  plain DB read (no I/O, no clock, no randomness) — it composes with the reactive engine exactly
  like every other `recordSend` read (the preference gate, the `sendReceipts` check).
- **Push-specific abuse surface, out of scope for this slice**: rate-limiting registrations per
  user/device, verifying a token actually belongs to the claimed platform/provider format before
  accepting it, and detecting/reaping tokens that are stale-but-not-yet-reported-invalid (a device
  that silently stopped accepting pushes without the provider ever saying so) are not built — flag
  as future hardening, not a v1 blocker (the existing N2 retry/backoff already bounds the cost of a
  dead token that DOES get reported).

## Testing

- **Component-level (`@stackbase/test`)**: `registerPushToken` upserts by token (re-registering the
  same token under a different caller reassigns `userId`); `unregisterPushToken` is ownership-gated
  (a foreign caller's unregister is a no-op, verified via a subsequent send still reaching the
  original owner's device); a push send with 2 tokens across 2 different configured providers
  writes ONE `messages` row and dispatches to both provider mocks; a push send with 0 tokens for the
  recipient is enqueued and marked `sent` by the driver WITHOUT any provider mock being called; a
  provider returning `invalidTokens` results in that `pushTokens` row being deleted after the pass;
  a provider throwing for ONE of two configured groups still marks the row `sent` (the other
  group's success) and does not retry; a provider throwing for ALL configured groups retries per
  the existing N2 backoff and eventually dead-letters; the N3 preference gate suppresses a `"push"`
  channel exactly like it does `"email"`; a critical category bypasses it; `sendToTopic` fans out to
  `"push"` subscribers.
- **Provider adapter unit tests** (mocked `fetch`/`http2`, following `resendEmail`'s/`twilioSms`'s
  existing test shape): `expoPush` — request shape (array body, chunked at 100), ticket-array
  parsing into `invalidTokens` on `DeviceNotRegistered`, non-2xx → `NotificationSendError`;
  `fcmPush` — service-account JWT is exchanged for an access token (mocked token endpoint), the
  token is cached and reused across calls within its lifetime, `UNREGISTERED`/`NOT_FOUND` → pruned;
  `apnsPush` — ES256 JWT construction (`jose`) is well-formed (`kid`/`iss` claims), a `410`/
  `BadDeviceToken` response → pruned, a real HTTP/2 round-trip is exercised against a local
  `node:http2` test server (not just a mocked `fetch`, since this adapter deliberately doesn't use
  `fetch` — the test needs to prove the transport choice actually works).
- **E2E through the real `stackbase dev` server** (new
  `packages/cli/test/notifications-push-e2e.test.ts`, alongside the existing
  `notifications-*-e2e.test.ts` files): a capture `PushProvider` composed via
  `defineNotifications({ channels: { push: { providers: { expo: capture } } } })`; a client mutation
  registers a push token (`registerForPush`), then a mutation calls `ctx.notifications.send` with
  `channels: ["push"]`; the driver delivers it and the capture provider records the exact
  `{to, title, body, data}` it received; a second E2E case proves invalid-token pruning end-to-end
  (a capture provider that returns `invalidTokens: [thatToken]` on its first call results in a
  SECOND send to the same user finding zero tokens and short-circuiting to `sent` with no provider
  call).

## Docs

`docs/enduser/build/notifications.md` (update, existing file): a new `## Push` section — the
`channels.push.providers` map, `expoPush()`/`fcmPush()`/`apnsPush()` setup (each provider's
credential shape and where to get it: Expo access token, Google service-account JSON, Apple `.p8`
key), `registerPushToken`/`registerForPush`, the token→provider routing rule, the "zero devices is
not an error" behavior, invalid-token pruning, and the honest v1 boundary (rich payload options,
delivery/engagement receipts — see Non-goals). Native `@stackbase/*` imports only.

## Non-goals (deferred, not built in this slice)

- **Rich push payload**: `sound`, `badge` count management, `priority`/silent (background,
  `content-available`) push, `apns-collapse-id`/notification replacement, action buttons/rich
  media attachments. `PushContent` stays `{title, body, data?}` in v1.
- **Delivery/engagement receipts** (delivered-to-device, opened/tapped) analogous to N2's email/SMS
  webhook-driven `deliveryStatus`. Expo has a separate receipts-polling API, FCM/APNs have no
  built-in open-tracking — all deferred; only send-time invalid-token detection ships.
- **Web push** (VAPID / the browser `PushManager` + Service Worker flow) — a fourth push transport
  distinct from Expo/FCM/APNs; the `platform: "web"` value is reserved on the schema for future use
  but no `webPush()` adapter ships.
- **Per-provider multi-primary fallback** (N3 explicitly deferred this for email/SMS too — "try
  Resend, then SES on failure" is a delivery-orchestration concern, not the routing model this
  slice builds, which is provider-BY-TOKEN, not provider-as-fallback).
- **Token liveness reaping** beyond provider-reported invalidity (a device that silently stopped
  accepting pushes without the provider ever saying so) — not detected or pruned.
- **Rate-limiting / format validation on registration** — `registerPushToken` accepts any string as
  a token and any of the three literal `provider` values; it does not verify the token's format
  matches the claimed provider, nor rate-limit registration attempts per caller.
- **FCM legacy HTTP API / APNs certificate-based auth** — only the current token-based auth schemes
  (FCM HTTP v1 service-account OAuth2; APNs JWT) are supported, matching how the codebase already
  only builds against current, non-deprecated provider APIs elsewhere (e.g. Resend/Twilio's current
  REST APIs, not any legacy variant).

## References consulted

Expo Push Notifications API docs (`exp.host/--/api/v2/push/send`, ticket/receipt model, the
100-message batch cap, `DeviceNotRegistered`); Firebase Cloud Messaging HTTP v1 reference (OAuth2
service-account auth, `messages:send`, error codes); Apple Push Notification service — Sending
Notification Requests to APNs (HTTP/2 requirement, JWT provider token auth, `410`/`BadDeviceToken`);
Novu's push channel providers (FCM/APNs/Expo/OneSignal `IChannel` arms); OneSignal's unified-send
abstraction; Knock's device-token + provider-per-token model. This document and
`docs/superpowers/plans/2026-04-13-notifications-push-channel.md` are the only files this design
pass wrote or touched.
