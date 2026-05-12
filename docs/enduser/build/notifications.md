# Notifications

`@stackbase/notifications` is an opt-in component for sending messages across pluggable
channels — **email**, **SMS/WhatsApp**, an in-app **inbox**, and mobile/web **push** — through
swappable per-channel provider adapters (Resend, Twilio, Expo/FCM/APNs, or your own). Its headline
feature is a **reactive in-app inbox**: an in-app notification is just a row in a live-queried
table, so a user's inbox and unread count update in real time with no dedicated realtime service.

Both your app code **and** the auth component (`@stackbase/auth`, when composed alongside) send
through the same seam, so an OTP email and a marketing blast share one delivery path with the same
at-most-once guarantee — see [Auth unification](#auth-unification) below.

> **Scope (N1 + N2 + N3 + N4 — the notification arc is COMPLETE).** Sending across email/SMS/in-app,
> transactional at-most-once delivery, the reactive inbox (N1); automatic retry-with-backoff on a
> transient send failure, stuck-send reclaim, and inbound delivery webhooks with cross-provider
> status normalization (delivered/bounced/opened/…) (N2 — see
> [Delivery reliability](#delivery-reliability) below); per-user channel/category preferences with a
> critical-bypass, and topics/groups fan-out (N3 — see [Preferences](#preferences) and
> [Topics](#topics) below); an email digest that combines a category's buffered sends into one
> periodic message, and routing `@stackbase/auth`'s transactional emails through this same delivery
> path (N4 — see [Digest](#digest) and [Auth unification](#auth-unification) below). This closes the
> planned notification arc (N1 substrate → N2 reliability → N3 preferences/topics → N4
> digest/auth-unify). **Deferred** (post-arc, see [What's deferred](#whats-deferred)): SMS/in_app
> digest, per-user digest frequency, threshold batching, a crash-orphan digest reaper, multi-channel
> provider fallback, and time-of-day-aware routing.

## Setup

Compose the component in your `stackbase.config.ts` (opt-in, like the scheduler):

```ts
import { defineConfig } from "@stackbase/component";
import { defineNotifications, consoleEmail, resendEmail, twilioSms } from "@stackbase/notifications";

export default defineConfig({
  components: [
    defineNotifications({
      channels: {
        email: {
          provider: consoleEmail(),          // zero-config dev provider — logs to the server console
          from: "no-reply@app.test",
          templates: {
            welcome: (d) => ({ subject: `Welcome ${d.name}`, text: `Hi ${d.name}!` }),
          },
        },
        sms: {
          provider: twilioSms({ accountSid: process.env.TWILIO_SID!, authToken: process.env.TWILIO_TOKEN! }),
          from: "+15550000000",
        },
        in_app: {
          enabled: true,
          templates: {
            welcome: (d) => ({ title: "Welcome", body: `Hi ${d.name}!` }),
          },
        },
      },
      // Optional: the queued-send sweep cadence (ms). The driver also wakes on every commit, so this
      // is only a fallback. Default 5000.
      driverIntervalMs: 5000,
    }),
  ],
});
```

`consoleEmail()` is the zero-config dev provider — it prints to the server console so you can
develop without credentials. Swap in `resendEmail({ apiKey: process.env.RESEND_KEY! })` for real
email delivery; both satisfy the same `EmailProvider` seam.

## Sending

`ctx.notifications.send(...)` is available on every mutation context once the component is composed.
It runs **inside the calling mutation's transaction**, so an enqueue rolls back with the mutation
and fans out reactively on commit:

```ts
import { mutation } from "./_generated/server";

export const welcome = mutation({
  handler: async (ctx, { userId, email, name }) => {
    await ctx.notifications.send({
      to: { userId, email },                 // channel-addressed recipient
      channels: ["in_app", "email"],         // which configured channels to deliver on
      template: "welcome",                   // a registered template key…
      data: { name },                        // …rendered with this payload
    });
  },
});
```

- **`to`** is a recipient addressed per channel: `userId` for `in_app`, `email` for `email`,
  `phone` for `sms`. The recipient is always chosen by your server code, never by the client.
- **`template`** is either a **registered key** (as above) or an **inline content object** for
  one-off content — `{ in_app: { title, body }, email: { subject, text, html? }, sms: "…" }`.
  Return only the fields you have — omit an optional field (e.g. `html`) rather than setting it to
  `undefined`; a rendered field whose value is explicitly `undefined` is rejected when the row is
  written.
- **`in_app` is instant**: the send writes the inbox row synchronously in your transaction, so it is
  live to any inbox subscription the moment the mutation commits — no send step.
- **email/SMS are queued**: the send writes a `queued` row (with the rendered content), and a
  background driver delivers it via the provider *outside* the transaction (network I/O never runs
  inside a mutation). The row moves `queued → sending → sent`/`failed`.

### At-most-once with an idempotency key

Pass `idempotencyKey` to guarantee a message is never sent twice — the key that makes an OTP safe:

```ts
await ctx.notifications.send({
  to: { email }, channels: ["email"], template: "otp", data: { code },
  idempotencyKey: `otp:${userId}:${code}`,
});
```

A replay with the same key short-circuits to the already-recorded result (no second send), recorded
transactionally with the message rows. When the provider supports a native idempotency header
(Resend, Loops), the key is passed through to it as well.

### Sending from an action (`sendNow`)

In an action (which may do network I/O directly), `ctx.notifications.sendNow(...)` delivers
email/SMS **synchronously** and returns the provider results:

```ts
import { action } from "./_generated/server";

export const blast = action({
  handler: async (ctx, { email }) => {
    const { messageIds, results } = await ctx.notifications.sendNow({
      to: { email }, channels: ["email"], template: "welcome", data: { name: "Ada" },
    });
    return results; // [{ providerMessageId: "…" }]
  },
});
```

`sendNow` still enqueues durably first (the in-app row is written instantly, the email/SMS rows are
written and the receipt recorded atomically) and then delivers in place. If the process crashes
mid-delivery, the un-sent rows remain `queued` and the background driver delivers them — so a
channel is never silently dropped, and the same `idempotencyKey` dedup applies.

## The reactive in-app inbox

The in-app inbox is a live query — subscribe to it and it updates itself. From a React app, use the
helper from `@stackbase/client/react`:

```tsx
import { useNotifications } from "@stackbase/client/react";

function InboxBell() {
  const { notifications, unreadCount, markRead, markAllRead } = useNotifications();
  return (
    <div>
      <button onClick={markAllRead}>Mark all read ({unreadCount})</button>
      <ul>
        {notifications.map((n) => (
          <li key={n._id} onClick={() => markRead(n._id)} style={{ fontWeight: n.read ? "normal" : "bold" }}>
            <strong>{n.title}</strong> — {n.body}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- `notifications` is the caller's own feed (most-recent first), `unreadCount` its live unread total.
  Both are reactive — a new notification or a `markRead` updates every subscribed component with no
  polling.
- `markRead(id)` / `markAllRead()` are ownership-checked on the server: the caller's user id is
  resolved server-side, never taken as a client argument, so no caller can name another user's inbox.
  **Per-user isolation requires a verified identity.** With `@stackbase/auth` composed (or an upstream
  token-verifying proxy), the resolved id is trustworthy and isolation is enforced. Without either,
  the identity falls back to the raw `setAuth(...)` bearer token, which an unauthenticated client can
  set to any value — so compose auth (or verify the token upstream) before relying on inbox isolation.
- For custom markup, `<Inbox>` is a headless render-prop version:
  `<Inbox>{({ notifications, markRead }) => …}</Inbox>`.

## Providers

Three adapters ship in N1:

| Provider | Channel | Notes |
| --- | --- | --- |
| `consoleEmail()` | email | Zero-config dev provider; logs to the server console. |
| `resendEmail({ apiKey, baseUrl? })` | email | One `fetch` to the Resend API; passes `idempotencyKey` through natively. |
| `twilioSms({ accountSid, authToken })` | sms | SMS and WhatsApp (a `kind: "whatsapp"` message is addressed with the `whatsapp:` prefix). |
| `consoleSms()` | sms | Zero-config dev provider; logs to the server console. |

A channel can configure more than one provider — see [Provider fallback](#provider-fallback) below
for automatic same-channel failover (e.g. Resend down → SES).

### Writing your own provider

A provider is a small adapter over the `NotificationProvider` seam — one `send` method, no other
surface:

```ts
import type { EmailProvider, EmailMessage, SendResult } from "@stackbase/notifications";

export function myEmail(opts: { apiKey: string }): EmailProvider {
  return {
    channel: "email",
    async send(m: EmailMessage): Promise<SendResult> {
      const res = await fetch("https://api.example.com/send", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ to: m.to, from: m.from, subject: m.subject, text: m.text, html: m.html }),
      });
      if (!res.ok) throw new Error(`send failed (${res.status})`);          // throw on failure → row is marked `failed`
      const json = (await res.json()) as { id?: string };
      return { providerMessageId: json.id };
    },
  };
}
```

Credentials live in the provider closure, never in a message row. The SMS seam (`SmsProvider`) is
the same shape with an `SmsMessage` (`to`, `from`, `body`, `kind?`).

## Provider fallback

A channel can list additional providers tried, in order, after `provider` fails — all within the
**same** delivery attempt (no extra retry/backoff round-trip):

```ts
defineNotifications({
  channels: {
    email: {
      provider: resendEmail({ apiKey: RESEND_KEY }),
      from: "no-reply@example.com",
      fallbacks: [sesEmail({ /* … */ })], // tried only if resendEmail's send() throws
    },
  },
});
```

The effective ordered list is `[provider, ...fallbacks]`. On a delivery attempt, `deliverOutbound`
walks the whole list:

- It stops at the **first** provider whose `send` succeeds.
- A failure — **even a permanent, non-retryable one** (`NotificationSendError({ retryable: false })`,
  e.g. a 4xx bad-recipient response) — does **not** stop the walk; a later provider is still tried.
  A 4xx from Resend doesn't necessarily mean SES would also reject the recipient, so the walk never
  short-circuits on a middle failure.
- Only if **every** provider in the list fails does the attempt itself fail, re-entering the normal
  [retry](#retries)/backoff/dead-letter path exactly as a single-provider failure always has. That
  attempt's overall `retryable` verdict is the OR across every provider tried — retryable if *any*
  of them was, non-retryable only if *all* of them were.

**Observability.** The `messages` row records which provider ultimately delivered it, in a
`providerName` field — visible in the dashboard's data browser. A provider's diagnostic label is its
own `.name` if it sets one, else a positional default: `"primary"` (index 0), `"fallback-1"`,
`"fallback-2"`, and so on.

```ts
defineNotifications({
  channels: {
    email: {
      provider: resendEmail({ apiKey: RESEND_KEY }),      // labeled "primary"
      fallbacks: [{ ...sesEmail({ /* … */ }), name: "ses-backup" }], // labeled "ses-backup"
      from: "no-reply@example.com",
    },
  },
});
```

**Webhooks with multiple providers.** The delivery webhook route is unchanged
(`POST /api/notifications/webhooks/:channel`, keyed by *channel*, never by provider — no vendor-
dashboard-registered callback URL needs to change). When a channel has fallbacks, an inbound webhook
tries every configured provider's `verify()` in order and applies events from whichever one matches.
Only the *primary* provider (index 0) receives the channel-level `webhookSecret`; every fallback
receives no secret from the config and is expected to carry its own signing material internally —
bake a fallback's own secret into its own factory args, the same way `twilioSms({ accountSid,
authToken })` already does, rather than relying on a single shared `webhookSecret`.

Because the route accepts an event as soon as *any* configured provider's `verify()` passes, the
endpoint's trust surface is the union of every provider's verification — so configure only providers
whose `verify()` you trust as a fallback on a given channel. A provider's `verify()` must return
`false` on a signature it doesn't recognize; if a custom provider `verify()` *throws* instead, the
route treats that as "did not verify" and moves on to the next candidate (a throw never accepts and
never 500s — an unrecognized request still ends in `401`). Each event is parsed by the *matched*
provider's own `parse()`, so a request only ever mutates message state its own signer authorized.

**What this is not.** This is *same-channel* fallback only — one email provider failing over to
another email provider (or one SMS provider to another). *Cross-channel* fallback (e.g. an email
send failing over to SMS) and time-of-day/quiet-hours-aware routing are different, unrelated
features and remain deferred — see [What's deferred](#whats-deferred).

## Push

`push` is a fourth channel — mobile/web push notifications via one or more of three built-in
provider adapters (`expoPush`, `fcmPush`, `apnsPush`), all reusing the SAME `recordSend`/driver/
preference/topics machinery every other channel does. There's no separate "push system" to learn.

### Setup

```ts
import { defineConfig } from "@stackbase/component";
import { defineNotifications, expoPush, fcmPush, apnsPush } from "@stackbase/notifications";

export default defineConfig({
  components: [
    defineNotifications({
      channels: {
        push: {
          providers: {
            expo: expoPush({ accessToken: process.env.EXPO_ACCESS_TOKEN }), // optional — anonymous sends work without one
            fcm: fcmPush({
              projectId: process.env.FCM_PROJECT_ID!,
              serviceAccount: JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON!), // { client_email, private_key }
            }),
            apns: apnsPush({
              teamId: process.env.APNS_TEAM_ID!,
              keyId: process.env.APNS_KEY_ID!,
              privateKey: process.env.APNS_PRIVATE_KEY!, // PKCS8 PEM
              bundleId: "com.yourcompany.yourapp",
              production: process.env.NODE_ENV === "production", // sandbox vs. production APNs endpoint
            }),
          },
          templates: {
            welcome: (d) => ({ title: "Welcome", body: `Hi ${d.name}!` }),
          },
        },
      },
    }),
  ],
});
```

At least one of `expo`/`fcm`/`apns` must be set — `defineNotifications` throws at construction if
`channels.push` is configured with an empty `providers` map.

### Registering device tokens

A client registers its own device's push token — self-only, server-resolved identity (the same
ownership model as topics' `subscribe`/inbox's `markRead`; there is no `userId` argument to smuggle
another user's registration):

```ts
import { registerForPush, unregisterForPush } from "@stackbase/client/react";

// After acquiring the OS token (Expo `getExpoPushTokenAsync()`, a native FCM/APNs SDK, or a web
// `PushManager.subscribe()`) — acquiring the token itself is your app's responsibility.
await registerForPush(client, { token: expoToken, provider: "expo", platform: "ios" });

// On sign-out / permission revoke:
await unregisterForPush(client, { token: expoToken });
```

**Routing is by the token's OWN recorded provider, not by OS platform.** `registerPushToken`'s
`provider: "expo" | "fcm" | "apns"` argument decides which configured adapter a token's messages are
sent through — an iOS device using the native APNs SDK registers with `provider: "apns"`; an iOS
device using Expo's managed push service registers with `provider: "expo"`; there is no
platform-sniffing. `platform` is optional metadata only (`"ios" | "android" | "web"`), not used for
routing.

Registration is an **upsert by token**, not by `(userId, token)`: a device token identifies one
physical installation, so re-registering the same token under a different caller reassigns it
(the previous owner stops receiving pushes to that device — correct when a device is shared or a
user signs out and a different user signs in on the same phone). This means possession of a device
token is authority over its routing — a caller who knows another device's token can reassign it to
themselves. That is the intended model (a device token is a device-local secret, not a public id),
but note the boundary: don't treat a device token as safe to expose. The *argument*-based IDOR is
fully closed separately — the client-callable `registerPushToken`/`unregisterPushToken` never accept
a `userId`, so a caller can only ever act on tokens, never name a victim user directly.

### Sending

Push participates in `send`/`sendNow`/`sendToTopic` exactly like any other channel — address by
`to.userId` (never an email/phone; push has no such concept):

```ts
await ctx.notifications.send({
  to: { userId },
  channels: ["push"],
  template: "welcome",
  data: { name: "Ada" },
});
```

At send time, `recordSend` snapshots the recipient's *currently registered* device tokens onto the
`messages` row. At delivery time, the driver groups those tokens by their recorded `provider` and
fans out to each configured adapter — one logical send can deliver to a user's iPhone (APNs), Android
phone (FCM), and an Expo-managed dev client all at once, transparently.

**Zero registered devices is not an error.** If a recipient has no registered tokens, the row is
still written (`queued` → `sent`), but no provider is ever called — nothing to retry, nothing to
fail. Silence, not an error, is the correct behavior for "hasn't installed the app on any device
yet" or "revoked all push permissions."

**Partial multi-provider failure.** If a send fans out across multiple provider groups (e.g. both
`expo` and `fcm` tokens are registered) and only SOME groups fail, the overall attempt is still
`sent` — a partial success is success. Only when **every** configured group fails outright does the
attempt fail and re-enter the normal [retry](#retries)/backoff/dead-letter path.

**Invalid-token pruning.** When a provider's send response reports a token as permanently
unregistered/invalid (Expo's `DeviceNotRegistered` ticket, FCM's `UNREGISTERED`/`NOT_FOUND`, APNs'
`410`/`Unregistered`), the driver (and `sendNow`'s inline drain) automatically removes that row from
`pushTokens` — no manual cleanup, and the stale token is never retried.

**Preferences and topics apply for free.** A `channel: "push"` row in `notificationPreferences`
behaves identically to an email/sms/in_app one (the N3 preference gate is channel-generic); a
critical category still bypasses it. `sendToTopic({ channels: ["push"] })` fans out to every
subscriber's registered devices, preference-aware, the same way `["in_app"]` always has.

### Writing your own push provider

A push provider is the same small `send`-only adapter shape as email/SMS, fanned out per *provider
group* (not per token) — the component calls `send` once per configured provider with every token
routed to it in that send's `to` array:

```ts
import type { PushProvider, PushMessage, PushSendResult } from "@stackbase/notifications";

export function myPush(opts: { apiKey: string }): PushProvider {
  return {
    channel: "push",
    async send(m: PushMessage): Promise<PushSendResult> {
      const res = await fetch("https://api.example.com/push/send", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ to: m.to, title: m.title, body: m.body, data: m.data }),
      });
      if (!res.ok) throw new Error(`send failed (${res.status})`);
      const json = (await res.json()) as { id?: string; invalid?: string[] };
      return { providerMessageId: json.id, invalidTokens: json.invalid };
    },
  };
}
```

### Non-goals (v1)

- **No rich payload** — title/body/data only. No images, action buttons, sounds, badges, or
  platform-specific payload extensions (APNs `mutable-content`, FCM `android`/`apns` payload
  blocks).
- **No delivery/engagement receipts** — unlike email/SMS's webhook-driven `deliveryStatus`
  (delivered/opened/clicked/…), push has no equivalent axis-2 signal in v1. A `sent` `messages` row
  means "handed to the provider (or no devices to hand to)," not "the device confirmed receipt."
- **No web push** (`PushManager`/VAPID) — only native mobile push (Expo/FCM/APNs) ships. A web-push
  adapter is a plausible future `PushProvider` implementation (the seam supports it), just not built.
- **No per-device delivery result** — a send's result is per logical send, not per device; a
  provider-level fan-out failure of one device among many in the same provider group is not
  individually surfaced (see each adapter's own documented v1 simplifications above).

## Delivery reliability

Email/SMS sends are automatically retried on a transient failure, a crashed in-flight send is
recovered, and — once you wire the provider's webhook — the message row picks up a second,
normalized delivery status as the provider reports it. **This section applies to `email`/`sms`
only.** `in_app` has no queue or send step (it's written `sent` synchronously in your transaction),
so there's nothing to retry, reclaim, or hear back about via webhook.

### Retries

A queued email/SMS send that throws is retried with exponential backoff (jittered 50–100%) rather
than immediately failing. Configure it under `retry` on `defineNotifications`:

```ts
defineNotifications({
  channels: { /* … */ },
  retry: {
    maxAttempts: 4,          // total delivery attempts (first send + retries) before dead-lettering
    initialBackoffMs: 250,   // first retry's base delay
    base: 2,                 // exponential multiplier
  },
});
```

Whether a failure is retried depends on how the provider's `send` throws:

- A **plain `Error`** (or any throw that isn't a `NotificationSendError`) is treated as
  **retryable** — a transient 5xx/network blip. The row goes back to `queued` with a
  backed-off `nextAttemptAt` and its `attempts` count incremented.
- Throwing `new NotificationSendError(message, { retryable: false })` — e.g. for a 4xx
  bad-recipient response — is a **permanent** failure: the driver dead-letters the message to
  `status: "failed"` immediately, no retry. The shipped `resendEmail`/`twilioSms` adapters already
  classify their own send errors this way (4xx-except-429 → non-retryable, 5xx/429 → retryable).

Once a row's `attempts` reaches `maxAttempts`, it dead-letters to `failed` regardless of
retryability.

### Reclaim (crash recovery)

If the server crashes between claiming a message (`queued → sending`) and recording the send's
outcome, the row would otherwise be stuck `sending` forever. A background reclaim sweep recovers
any `sending` row older than `reclaimLeaseMs` (default 60000) back to `queued` (counting an
attempt, so a row that keeps crashing still eventually dead-letters instead of looping):

```ts
defineNotifications({
  channels: { /* … */ },
  reclaimLeaseMs: 60_000,
});
```

This is a **single-node** reclaim (a wall-clock lease, one writer) — a multi-node/fleet driver
reclaim is out of scope for this release.

### Delivery webhooks + normalized status

Point your provider's delivery-webhook (Resend, Twilio) at your deployment, and Stackbase will
verify its signature and reactively update the message row with a normalized `deliveryStatus` as
the provider reports what happened after the send — bounces, opens, clicks, complaints:

- **Endpoint URL:** `https://<your-host>/api/notifications/webhooks/email` for Resend,
  `https://<your-host>/api/notifications/webhooks/sms` for Twilio. Configure this URL in the
  provider's dashboard (Resend: Webhooks; Twilio: the number's Messaging status callback URL).
- **Signing secret:** set `webhookSecret` on the email channel so the route can verify the
  provider's signature (Resend uses Svix — a `whsec_…` secret from the Resend webhook settings
  page). Twilio's webhook is verified with the SMS provider's own `authToken` — no separate secret
  needed.

```ts
defineNotifications({
  channels: {
    email: {
      provider: resendEmail({ apiKey: process.env.RESEND_KEY! }),
      from: "no-reply@app.test",
      webhookSecret: process.env.RESEND_WEBHOOK_SECRET,   // Resend's whsec_… Svix signing secret
    },
    sms: {
      provider: twilioSms({ accountSid: process.env.TWILIO_SID!, authToken: process.env.TWILIO_TOKEN! }),
      from: "+15550000000",
      // No webhookSecret — Twilio's status-callback signature is verified with authToken above.
    },
  },
});
```

A signature failure is rejected `401` **before any row is read or written**. A verified event is
correlated to its message row by the provider's own message id and applied as a normalized
`deliveryStatus`:

```
"delivered" | "bounced" | "complained" | "opened" | "clicked" | "dropped" | "failed_permanent"
```

`deliveryStatus` is a **second, independent axis** from the send-lifecycle `status`
(`queued`/`sending`/`sent`/`failed`) — a message can be `status: "sent"` and later pick up
`deliveryStatus: "delivered"`, then `"opened"`, then `"clicked"` as the provider's webhooks arrive.
It's written **monotonically** by lifecycle rank, so a redelivered or out-of-order webhook event is
a no-op rather than regressing a later status back to an earlier one. Because it's an ordinary
field on the `messages` row, subscribing to a query over that row (or your own status view) sees
it update reactively — no polling.

**Spam complaints** are recorded on a separate `complainedAt` timestamp field, not on
`deliveryStatus`. A complaint always arrives *after* `delivered`, so folding it into the monotonic
`deliveryStatus` would drop it; instead it's captured unconditionally on `complainedAt` (the
compliance/suppression signal — check it to stop mailing an address that reported you as spam).

**Behind a reverse proxy (Twilio):** Twilio computes its signature over the exact public
`https://…` URL you configured in its console, but Stackbase serves plain HTTP behind your
TLS-terminating proxy (nginx/Caddy/Traefik). Ensure the proxy forwards `X-Forwarded-Proto` and
`X-Forwarded-Host` (the common default) — Stackbase reconstructs the public URL from them to verify
the signature. Resend/Svix signs the request body, not the URL, so it needs no such configuration.

## Preferences

Every `send` is tagged with a **category** (a free-form string you choose — `"marketing"`,
`"security"`, `"comments"`, …; a send that names none uses `defaultCategory`, `"default"` unless
configured otherwise). A user can opt a `(category, channel)` pair out, and a suppressed send is
skipped **before** it ever writes a row or reaches a provider.

**Default-allow.** With no preference row at all, every category/channel is enabled — preferences
are opt-*out*, not opt-*in*. A category-wide opt-out (`channel` omitted) is overridden by a
channel-specific row for the same category, if one exists (most-specific wins).

```ts
await ctx.notifications.send({
  to: { userId, email }, channels: ["in_app", "email"], template: "digest",
  category: "marketing",   // ← gated by the recipient's own preference for (marketing, in_app)/(marketing, email)
});
```

The return value reports which requested channels were suppressed, so you can distinguish "sent" from
"skipped by preference" without a second query:

```ts
const { messageIds, suppressed } = await ctx.notifications.send({ /* … */ });
// suppressed: Channel[] — e.g. ["email"] if the recipient opted email out for this category
```

### Critical categories (can't be opted out)

Mark a category `critical` in config to make it bypass preferences entirely — the archetypal case is
account-security mail (password reset, new-device login, suspicious-activity alerts) that must always
reach the user regardless of their marketing preferences:

```ts
defineNotifications({
  channels: { /* … */ },
  categories: {
    security: { critical: true },   // always delivered; setPreference rejects an attempt to disable it
  },
});
```

A `setPreference` call trying to disable a critical category throws rather than silently no-opping.

**Per-send override.** A single `send` can also bypass preferences without a config-level category
by passing `critical: true` directly:

```ts
await ctx.notifications.send({
  to: { userId, email }, channels: ["email"], template: "passwordReset",
  category: "security", critical: true,   // delivered regardless of this recipient's preferences
});
```

`critical` is a **server-authority** flag: it must be set only by server code (a mutation/action
handler you write, or a composed component like `@stackbase/auth` — see
[Auth unification](#auth-unification)), never forwarded straight from client-supplied arguments —
the same trust boundary as `to`. It's how a single transactional send (a password-reset link, a
new-device alert) guarantees delivery without requiring every such category be marked `critical` in
config up front.

### Reading and setting preferences

`ctx.notifications.setPreference(...)` (mutation-only; also a registered `notifications:setPreference`
module reachable directly from the client) upserts the **caller's own** preference row —
server-resolved identity, never a client-supplied user id:

```ts
await ctx.notifications.setPreference({ category: "marketing", channel: "email", enabled: false });
// channel omitted → a category-wide row (applies to every channel not overridden more specifically)
await ctx.notifications.setPreference({ category: "marketing", enabled: false });
```

`notifications:getPreferences` is a live query returning the caller's own preference rows
(`{ category, channel?, enabled }[]`) — reactive, so a `setPreference` from any tab is reflected
everywhere immediately. From React, `useNotificationPreferences()` wraps both:

```tsx
import { useNotificationPreferences } from "@stackbase/client/react";

function PreferencesPanel() {
  const { preferences, setPreference } = useNotificationPreferences();
  return (
    <label>
      <input
        type="checkbox"
        checked={!preferences.some((p) => p.category === "marketing" && p.enabled === false)}
        onChange={(e) => setPreference({ category: "marketing", channel: "email", enabled: e.target.checked })}
      />
      Marketing email
    </label>
  );
}
```

## Topics

A **topic** is a named subscriber list (`"news"`, `"team:42:updates"`, …) you fan a single send out
to — the mechanism behind broadcasts, digests-to-a-group, and per-resource watchers, without
looping over recipients yourself.

### Subscribing

`ctx.notifications.subscribe({ topic })` / `unsubscribe({ topic })` are available on every mutation
context and are also registered, client-callable modules (`notifications:subscribe`/`unsubscribe`).
**The client-callable path is self-only**: it always subscribes the caller's own resolved identity —
there is no way for a client to pass a `userId` and subscribe a different user (that would be an
IDOR). Idempotent either way: subscribing twice, or unsubscribing when not subscribed, is a no-op.

```ts
// From the client (or a plain mutation): subscribes the CALLER.
await ctx.notifications.subscribe({ topic: "news" });
```

To subscribe a **different** user — e.g. auto-subscribing every member of a team to that team's
topic — call the facade from your own server-side mutation with an explicit `userId`; this
server-controlled override is only reachable from app code, never from a client argument:

```ts
export const joinTeam = mutation({
  handler: async (ctx, { teamId, userId }) => {
    // … add userId to the team …
    await ctx.notifications.subscribe({ topic: `team:${teamId}`, userId });
  },
});
```

### Sending to a topic

`ctx.notifications.sendToTopic(...)` is an **action-only** method (fan-out pages through subscribers,
same as any bulk read) that sends to every current subscriber of a topic:

```ts
export const announce = action({
  handler: async (ctx, { message }) => {
    return ctx.notifications.sendToTopic({
      topic: "news", channels: ["in_app"], template: "announcement",
      data: { message }, category: "marketing",
    });
  },
});
```

It returns a count summary rather than per-recipient message ids (a broadcast can be arbitrarily
large):

```ts
{ recipientCount: number; sentCount: number; suppressedCount: number }
```

- **`in_app` only.** A topic subscription stores just a subscriber's `userId`, not their email or
  phone, so `sendToTopic` supports only the **`in_app`** channel — an email/SMS channel is rejected
  fast (before any partial send), since there's no address to resolve. To email/SMS a group, send to
  each recipient directly with `send`/`sendNow`.
- **Preference-aware for free.** Each subscriber's send routes through the exact same
  `recordSend` gate a direct `ctx.notifications.send` uses — a subscriber who's opted the category/
  channel out is silently skipped and counted in `suppressedCount`, with no second preference check
  to keep in sync.
- **Per-subscriber idempotency.** Pass `idempotencyKey` to make a re-run of the same broadcast a
  no-op: internally it's namespaced per subscriber, so retrying a `sendToTopic` call (e.g. after a
  timeout) never double-sends to anyone, exactly like a single `send`'s own idempotency key. (The
  returned counts reflect the *first* execution; a keyed retry reports the recorded no-op, not fresh
  work, so don't treat a retry's counts as authoritative.)
- **Paginated internally.** An arbitrarily large subscriber list is processed in bounded pages under
  the hood — you never need to page it yourself. Because pages are separate transactions, a
  subscribe/unsubscribe landing mid-broadcast may include or skip that one subscriber; a keyed
  broadcast stays safe against a double either way.

## Digest

A category can be configured to **digest**: instead of sending each `email` immediately, matching
sends are buffered and combined into one periodic email per recipient — the mechanism behind a
"daily updates" or "weekly summary" email that doesn't spam a user once per event.

```ts
defineNotifications({
  channels: { /* … */ },
  categories: {
    updates: { digest: "daily" },   // "hourly" | "daily" | "weekly"
  },
  digestTemplates: {
    // Combine a recipient's buffered items into one email. Falls back to a built-in plain-text
    // concatenation (`defaultDigestTemplate`) for a digest category with no template here.
    updates: (items) => ({
      subject: `You have ${items.length} update${items.length === 1 ? "" : "s"}`,
      text: items.map((i) => `• ${i.subject}\n${i.text}`).join("\n\n"),
    }),
  },
});
```

- **Email-only.** Digest applies only to the `email` channel. `in_app` is never digested — the inbox
  is already the live, immediate view of what happened, so batching it would just add lag. A
  **`critical` send is never digested** either (config-critical category or the per-send `critical`
  flag) — a transactional email always goes out immediately, digest or not.
- **Rolling window.** Each buffered item's own age (not a fixed wall-clock boundary) determines when
  a recipient's group is due: the driver flushes a `(recipient, category)` group once its *oldest*
  buffered item has waited out the configured window (`"hourly"` = 1h, `"daily"` = 24h, `"weekly"` =
  7d) — the same recurring driver that delivers queued sends and reclaims stuck ones (see
  [Delivery reliability](#delivery-reliability)) also flushes due digests on every pass.
- **Preferences are re-checked at flush**, not at buffer time — an opt-out recorded anytime before
  the flush suppresses the whole combined digest for that recipient/category, through the exact same
  `recordSend` gate every other send uses.
- **The send return tells you it was buffered.** A `send` on a digest-configured category returns
  `deferred: Channel[]` alongside `messageIds`/`suppressed` — `["email"]` means that channel was
  buffered rather than queued for immediate delivery:

  ```ts
  const { messageIds, suppressed, deferred } = await ctx.notifications.send({
    to: { userId, email }, channels: ["email"], template: "weeklyDigest", category: "updates",
  });
  // deferred: ["email"] — buffered into the digest; nothing was sent (and nothing was suppressed)
  ```

## Auth unification

When you compose **both** `@stackbase/auth` and `@stackbase/notifications` in the same
`stackbase.config.ts`, auth's own transactional emails — email verification, password reset, magic
link, and OTP codes — automatically route through the notifications delivery path instead of auth's
own standalone `EmailProvider`. You get this for free just by composing both; there's no extra
wiring:

```ts
export default defineConfig({
  components: [
    defineNotifications({ channels: { email: { provider: resendEmail(RESEND_KEY), from: "no-reply@app.test" } } }),
    defineAuth({ /* … */ }),   // auth's OTP/reset/magic-link emails now flow through notifications
  ],
});
```

- **What you get.** Auth's emails inherit N2's retry-with-backoff and stuck-send reclaim, whichever
  provider you've wired notifications to (so one Resend/Twilio-style adapter serves both auth and
  your own app sends), and a single unified `from` address for every outbound email your app sends —
  one delivery path, one place to reason about deliverability.
- **Always delivered — the `critical` flag.** Every auth email is sent with `critical: true`, the
  same server-authority preference-bypass flag described in
  [Critical categories](#critical-categories-cant-be-opted-out) above — a password-reset or OTP
  email can never be silently dropped by a recipient's notification preferences. This flag is set
  only by auth's own server-side code; it is never something a client can trigger.
- **The category.** Auth's emails use the `"auth"` category by default — configurable per email
  channel:

  ```ts
  defineAuth({
    email: { provider: /* … */, from: "auth@app.test", notificationCategory: "security" },
  });
  ```

- **Graceful fallback — auth stays independent.** `@stackbase/auth` does not depend on
  `@stackbase/notifications`; it duck-types a minimal `ctx.notifications` shape at runtime. If
  notifications isn't composed in your project, auth silently falls back to its own `EmailProvider`
  — byte-identical to how it behaved before this feature existed. Composing notifications is purely
  additive: nothing breaks, and nothing else needs to change, if you add or remove it later.

## What's deferred

The planned notification arc (N1 substrate → N2 reliability → N3 preferences/topics → N4
digest/auth-unify) is **complete**. What remains is explicitly **post-arc**, not a gap in this
release:

- **Digest scope** — SMS/in_app digest (email-only today), per-user digest frequency (today's
  frequency is a fixed per-category config, not user-selectable), threshold-based batching (e.g.
  "digest after N items" rather than purely time-windowed), and a crash-orphan digest reaper (a
  `flushedAt`-claimed-but-never-delivered row is not yet automatically recovered, unlike the queued-
  message reclaim in [Delivery reliability](#delivery-reliability)).
- **Delivery-mechanics** — *cross-channel* provider fallback (e.g. retry a failed email send over
  SMS) and time-of-day/quiet-hours-aware routing. (*Same-channel* multi-provider fallback — e.g.
  Resend failing over to SES within the email channel — has shipped; see
  [Provider fallback](#provider-fallback). These are distinct features: the shipped one never
  crosses channels.)
- **Beyond the arc** — a markup/visual template registry (Liquid/MJML). Inline typed template
  functions are the v1 authoring model. (A push channel — FCM/APNs/Expo — has since shipped; see
  [Push](#push) above, including its own v1 non-goals: no rich payload, no delivery/engagement
  receipts, no web push.)
