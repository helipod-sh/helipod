import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { notificationsSchema } from "./schema";
import { resolveNotificationsConfig, type NotificationsOptions } from "./config";
import { notificationsContext, notificationsActionContext } from "./facade";
import { makeSendModules } from "./modules";
import { makeInboxModules } from "./inbox";
import { notificationsDriver } from "./driver";

// Seam + config + content types (for adapter authors and N4 auth reuse).
export * from "./schema";
export type {
  SendResult, EmailMessage, SmsMessage, EmailProvider, SmsProvider, NotificationProvider,
  EmailContent, SmsPayload, InAppContent,
} from "./provider";
export type {
  NotificationsOptions, NotificationsConfig, NotificationChannels,
  EmailChannelConfig, SmsChannelConfig, InAppChannelConfig,
  EmailTemplates, SmsTemplates, InAppTemplates,
  EmailTemplateFn, SmsTemplateFn, InAppTemplateFn,
  Channel, Recipient, InlineTemplate, SendArgs,
} from "./config";
export { resolveNotificationsConfig, DEFAULT_DRIVER_INTERVAL_MS } from "./config";

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
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules() },
    context: (cctx) => notificationsContext(cctx, config),
    contextType: { import: "@stackbase/notifications", type: "NotificationsContext" },
    contextWrite: true,
    buildAction: (api) => notificationsActionContext(api, config),
    driver: notificationsDriver(config),
  });
}
