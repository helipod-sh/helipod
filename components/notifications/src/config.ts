import type { EmailProvider, SmsProvider, EmailContent, InAppContent } from "./provider";

/** Inline typed per-channel templates (Global Constraints — not a markup engine). Keyed by
 *  templateKey; each renders channel content from the send's `data` payload. */
export type EmailTemplateFn = (data: any) => EmailContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type SmsTemplateFn = (data: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
export type InAppTemplateFn = (data: any) => InAppContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type EmailTemplates = Record<string, EmailTemplateFn>;
export type SmsTemplates = Record<string, SmsTemplateFn>;
export type InAppTemplates = Record<string, InAppTemplateFn>;

export interface EmailChannelConfig {
  provider: EmailProvider;
  from: string;
  templates?: EmailTemplates;
}
export interface SmsChannelConfig {
  provider: SmsProvider;
  from: string;
  templates?: SmsTemplates;
}
export interface InAppChannelConfig {
  enabled: true;
  templates?: InAppTemplates;
}

export interface NotificationChannels {
  email?: EmailChannelConfig;
  sms?: SmsChannelConfig;
  in_app?: InAppChannelConfig;
}

export interface NotificationsOptions {
  channels: NotificationChannels;
  /** Queued-send sweep cadence (ms); the driver also wakes on the commit fan-out. Default 5000. */
  driverIntervalMs?: number;
}

/** Resolved config (driverIntervalMs defaulted) — closed over by the facade, modules, and driver. */
export interface NotificationsConfig {
  channels: NotificationChannels;
  driverIntervalMs: number;
}

export const DEFAULT_DRIVER_INTERVAL_MS = 5000;

export function resolveNotificationsConfig(opts: NotificationsOptions): NotificationsConfig {
  return {
    channels: opts.channels,
    driverIntervalMs: opts.driverIntervalMs ?? DEFAULT_DRIVER_INTERVAL_MS,
  };
}

/** A channel medium. */
export type Channel = "email" | "sms" | "in_app";

/** A channel-addressed recipient. `userId` for in_app; `email` for email; `phone` for sms. */
export interface Recipient {
  userId?: string;
  email?: string;
  phone?: string;
}

/** Inline content object (the non-registered-key form of `template`) — per-channel content. */
export interface InlineTemplate {
  email?: EmailContent;
  sms?: string;
  in_app?: InAppContent;
}

/** The public `ctx.notifications.send`/`sendNow` argument. */
export interface SendArgs {
  to: Recipient;
  channels: Channel[];
  template: string | InlineTemplate;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}
