import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { notificationsSchema } from "./schema";
import { resolveNotificationsConfig, type NotificationsOptions } from "./config";
import { notificationsContext, notificationsActionContext } from "./facade";
import { makeSendModules } from "./modules";
import { makeInboxModules } from "./inbox";
import { makeWebhookModules } from "./webhook";
import { makePreferenceModules } from "./preferences";
import { makeTopicModules } from "./topics";
import { makeDigestModules } from "./digest";
import { makePushModules } from "./push";
import { notificationsDriver } from "./driver";

// Seam + config + content types (for adapter authors and N4 auth reuse).
export * from "./schema";
export type {
  SendResult, EmailMessage, SmsMessage, EmailProvider, SmsProvider, NotificationProvider,
  EmailContent, SmsPayload, InAppContent,
  DeliveryStatus, WebhookEvent, WebhookVerifyArgs, ProviderWebhook,
} from "./provider";
export { NotificationSendError } from "./provider";
export type {
  NotificationsOptions, NotificationsConfig, NotificationChannels,
  EmailChannelConfig, SmsChannelConfig, InAppChannelConfig,
  EmailTemplates, SmsTemplates, InAppTemplates,
  EmailTemplateFn, SmsTemplateFn, InAppTemplateFn,
  Channel, Recipient, InlineTemplate, SendArgs,
  DigestFrequency, DigestItem, DigestTemplateFn,
} from "./config";
export { resolveNotificationsConfig, DEFAULT_DRIVER_INTERVAL_MS } from "./config";

// Digest (N4): the driver-invoked flush module + the built-in combining renderer.
export { defaultDigestTemplate } from "./digest";

// Facade types (contextType target + action facade).
export type { NotificationsContext, NotificationsActionContext } from "./facade";
export { notificationsContext, notificationsActionContext } from "./facade";

// Driver.
export type { NotificationsDriver } from "./driver";
export { notificationsDriver } from "./driver";

// Provider adapters (files land from T2a/T2b/T2c into these slots — index owns the re-export line).
export { consoleEmail, consoleSms } from "./provider-console";
export { resendEmail } from "./provider-resend";
export { twilioSms } from "./provider-twilio";

/**
 * `defineNotifications(opts)` — the `@stackbase/notifications` component: the `messages`/
 * `notifications`/`sendReceipts` schema, the `ctx.notifications` facade (`send`, mutation-side +
 * `sendNow` action-side), the internal send/inbox modules, and the queued-send driver.
 *
 * `contextWrite: true` is load-bearing: `send` writes the `messages`/`notifications`/`sendReceipts`
 * rows through the calling mutation's own transaction (like `ctx.scheduler.runAfter`), so an enqueue
 * rolls back with the mutation and fans out reactively on commit.
 *
 * The module set closes over the resolved config (providers/templates/`from`), following
 * `defineScheduler`'s config-value convention.
 */
export function defineNotifications(opts: NotificationsOptions): ComponentDefinition {
  const config = resolveNotificationsConfig(opts);
  const hasWebhook = !!(config.channels.email?.provider.webhook || config.channels.sms?.provider.webhook);
  // DX: an email provider with a webhook but no signing secret verifies every callback as invalid
  // (svixVerify returns false without a secret → 401), which is fail-closed but silent. Warn loudly.
  if (config.channels.email?.provider.webhook && !config.channels.email.webhookSecret) {
    console.warn(
      "[notifications] the email provider defines a delivery webhook but no `channels.email.webhookSecret` is set — " +
      "every inbound email webhook will be rejected (401). Configure the provider's signing secret to enable delivery status.",
    );
  }
  if (config.channels.push && Object.keys(config.channels.push.providers).length === 0) {
    throw new Error(
      '[notifications] channels.push is configured with an empty `providers` map — set at least one of expo/fcm/apns, or omit `channels.push` entirely.',
    );
  }
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules(), ...makeWebhookModules(config), ...makePreferenceModules(config), ...makeTopicModules(config), ...makeDigestModules(config), ...makePushModules(config) },
    context: (cctx) => notificationsContext(cctx, config),
    contextType: { import: "@stackbase/notifications", type: "NotificationsContext" },
    contextWrite: true,
    buildAction: (api) => notificationsActionContext(api, config),
    driver: notificationsDriver(config),
    ...(hasWebhook ? { httpRoutes: [{ method: "POST", pathPrefix: "/api/notifications/webhooks/", handler: "webhookHttp" }] } : {}),
  });
}
