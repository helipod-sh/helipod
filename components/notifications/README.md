# @helipod/notifications

Multi-channel notifications for helipod: send email, SMS, push, and in-app messages from your mutations through a pluggable provider seam, with durable retries, per-user preferences and topics, and a reactive in-app inbox.

## Install

```sh
bun add @helipod/notifications
```

## Enable

Components are opt-in per project. `defineNotifications(opts)` takes a `channels` map; each channel gets a provider and named templates:

```ts
// helipod.config.ts
import { defineConfig } from "@helipod/component";
import { defineNotifications, consoleEmail, twilioSms } from "@helipod/notifications";

export default defineConfig({
  components: [
    defineNotifications({
      channels: {
        email: {
          provider: consoleEmail(), // zero-config dev provider: logs to the server console
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
    }),
  ],
});
```

## Usage

`ctx.notifications.send(args)` is available in every mutation. It writes through the calling mutation's own transaction, so an enqueue rolls back with the mutation and fans out reactively on commit:

```ts
export const welcome = mutation({
  handler: async (ctx, { userId, email, name }) => {
    await ctx.notifications.send({
      to: { userId, email },           // channel-addressed recipient
      channels: ["in_app", "email"],   // which configured channels to deliver on
      template: "welcome",             // a registered template key (or an inline template)
      data: { name },                  // rendered with this payload
    });
  },
});
```

`send` returns `{ messageIds, suppressed, deferred }`. Actions get a send-focused facade too (`send`, `sendNow`, `sendToTopic`).

## Features

- Four channels: `email`, `sms`, `push`, `in_app`. In-app rows are written in the same transaction and push to live inbox subscriptions instantly; outbound channels write a `queued` row that a background driver delivers outside the transaction (network I/O never runs inside a mutation).
- Built-in providers: `consoleEmail`/`consoleSms` (dev), `resendEmail`, `twilioSms`, and push via `expoPush`/`fcmPush`/`apnsPush` — or implement the provider interface yourself.
- Delivery reliability: retries with backoff, dead-lettering, stuck-send reclaim, and ordered provider `fallbacks` tried within a single delivery attempt.
- Per-user preferences and topics, enforced at the send chokepoint, with a `critical` server-side bypass for transactional sends (OTPs, security notices) and config-level critical categories.
- Email digests: batch a category into periodic per-user summaries instead of one email per event.
- `idempotencyKey` on `send` for safe re-invocation.
- Provider delivery-status webhooks (verified before any write) update message rows, so delivery state is observable in the dashboard.
- Templates are plain functions per channel (`(data) => content`), registered in config or passed inline.

No required dependency on other components; the background delivery loop runs on the engine's recurring-driver seam.

Part of [Helipod](https://github.com/helipod-sh/helipod) — docs at https://helipod-six.vercel.app/docs

License: FSL-1.1-Apache-2.0
