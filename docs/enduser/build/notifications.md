# Notifications

`@stackbase/notifications` is an opt-in component for sending messages across pluggable
channels — **email**, **SMS/WhatsApp**, and an in-app **inbox** — through swappable per-channel
provider adapters (Resend, Twilio, or your own). Its headline feature is a **reactive in-app
inbox**: an in-app notification is just a row in a live-queried table, so a user's inbox and unread
count update in real time with no dedicated realtime service.

Both your app code and (in a later release) the auth component send through the same seam, so an
OTP email and a marketing blast share one delivery path with the same at-most-once guarantee.

> **N1 scope (what this release is).** Sending across email/SMS/in-app, transactional at-most-once
> delivery, and the reactive inbox. **Deferred:** delivery webhooks + status normalization
> (delivered/bounced/opened) and retries (N2); per-user preferences, routing/fallback, and topics
> (N3); digest/batching and the auth-unification (N4); a push channel (FCM/APNs/Expo) and a
> markup/visual template registry (post-arc). A failed send is terminal in N1 — it is marked
> `failed`, not retried.

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
  resolved server-side (from the auth component when composed, otherwise the ambient identity), so a
  user can only ever read or mutate their own inbox — the recipient id is never a client argument.
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

## What's deferred

- **N2** — delivery webhook ingestion + cross-provider status normalization (delivered/bounced/
  opened); retries on failed sends.
- **N3** — per-user channel/category preferences + critical-bypass; multi-channel routing/fallback;
  topics/groups.
- **N4** — digest/batching; routing the auth component's OTP/magic-link/verification emails through
  this seam.
- **Post-arc** — a push channel (FCM/APNs/Expo); a markup/visual template registry (Liquid/MJML).
  Inline typed template functions are the v1 authoring model.
