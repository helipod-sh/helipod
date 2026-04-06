# Notifications

`@stackbase/notifications` is an opt-in component for sending messages across pluggable
channels — **email**, **SMS/WhatsApp**, and an in-app **inbox** — through swappable per-channel
provider adapters (Resend, Twilio, or your own). Its headline feature is a **reactive in-app
inbox**: an in-app notification is just a row in a live-queried table, so a user's inbox and unread
count update in real time with no dedicated realtime service.

Both your app code and (in a later release) the auth component send through the same seam, so an
OTP email and a marketing blast share one delivery path with the same at-most-once guarantee.

> **Scope (N1 + N2, what this release is).** Sending across email/SMS/in-app, transactional
> at-most-once delivery, the reactive inbox (N1); automatic retry-with-backoff on a transient
> send failure, stuck-send reclaim, and inbound delivery webhooks with cross-provider status
> normalization (delivered/bounced/opened/…) (N2 — see [Delivery reliability](#delivery-reliability)
> below). **Deferred:** per-user preferences, routing/fallback, and topics (N3); digest/batching and
> the auth-unification (N4); a push channel (FCM/APNs/Expo) and a markup/visual template registry
> (post-arc).

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

Selecting one active provider per channel is the N1 model (multi-provider fallback is N3).

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

## What's deferred

- **N3** — per-user channel/category preferences + critical-bypass; multi-channel routing/fallback;
  topics/groups.
- **N4** — digest/batching; routing the auth component's OTP/magic-link/verification emails through
  this seam.
- **Post-arc** — a push channel (FCM/APNs/Expo); a markup/visual template registry (Liquid/MJML).
  Inline typed template functions are the v1 authoring model.
