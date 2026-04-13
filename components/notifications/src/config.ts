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
  /** Signing secret for this provider's inbound delivery webhook (e.g. Resend `whsec_…`). */
  webhookSecret?: string;
}

/** Retry policy for a failed email/SMS send (N2). `maxAttempts` counts total delivery attempts
 *  (the first send + retries) before dead-lettering to `failed`. */
export interface RetryOptions {
  maxAttempts: number;
  initialBackoffMs: number;
  base: number;
}
export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, initialBackoffMs: 250, base: 2 };
export const DEFAULT_RECLAIM_LEASE_MS = 60_000;
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
  retry?: Partial<RetryOptions>;
  /** A `"sending"` row older than this (ms) is reclaimed to `queued` (crash recovery). Default 60000. */
  reclaimLeaseMs?: number;
  /** The category a send uses when it names none. Default "default". */
  defaultCategory?: string;
  /** Per-category config; a `critical` category bypasses preferences and can't be opted out. */
  categories?: Record<string, { critical?: boolean }>;
}

/** Resolved config (driverIntervalMs defaulted) — closed over by the facade, modules, and driver. */
export interface NotificationsConfig {
  channels: NotificationChannels;
  driverIntervalMs: number;
  retry: RetryOptions;
  reclaimLeaseMs: number;
  defaultCategory: string;
  categories: Record<string, { critical?: boolean }>;
}

export const DEFAULT_DRIVER_INTERVAL_MS = 5000;

export function resolveNotificationsConfig(opts: NotificationsOptions): NotificationsConfig {
  return {
    channels: opts.channels,
    driverIntervalMs: opts.driverIntervalMs ?? DEFAULT_DRIVER_INTERVAL_MS,
    retry: {
      maxAttempts: opts.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      initialBackoffMs: opts.retry?.initialBackoffMs ?? DEFAULT_RETRY.initialBackoffMs,
      base: opts.retry?.base ?? DEFAULT_RETRY.base,
    },
    reclaimLeaseMs: opts.reclaimLeaseMs ?? DEFAULT_RECLAIM_LEASE_MS,
    defaultCategory: opts.defaultCategory ?? "default",
    categories: opts.categories ?? {},
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
  category?: string;   // N3 — preferences/criticality key; defaults to config.defaultCategory
  /** SERVER-AUTHORITY preference-bypass for a transactional send (OTP/security). When true the send
   *  is delivered regardless of the recipient's preferences, exactly like a config-critical category.
   *  Set ONLY by server code (never forward it from client input — same trust boundary as `to`). */
  critical?: boolean;
}
