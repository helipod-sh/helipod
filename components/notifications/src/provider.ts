/**
 * The Channel × Provider seam for `@stackbase/notifications` (Global Constraints). A CHANNEL is a
 * medium ("email"/"sms"/"in_app"); a PROVIDER is a swappable adapter for one channel. The base
 * `NotificationProvider` never leaks a driver into the engine — same philosophy as `DatabaseAdapter`
 * /`BlobStore`. Shaped auth-compatible (the `send({to,from,subject,text,html?})` email contract
 * generalizes `components/auth/src/email/provider.ts`) so N4 can unify auth onto it — N1 touches no
 * auth code.
 */

/** Every provider `send` returns this on success and THROWS on failure. */
export interface SendResult {
  providerMessageId?: string;
}

/** The wire message an email provider delivers. `templateId`/`variables` are anticipated for
 *  Loops/SES-template providers (not required in N1); `idempotencyKey` is passed through to a
 *  provider's native Idempotency-Key when supported (Resend/Loops). */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** The wire message an SMS provider delivers. `kind:"whatsapp"` selects WhatsApp addressing at the
 *  provider (Twilio prefixes `whatsapp:`), not a separate channel. */
export interface SmsMessage {
  to: string;
  from: string;
  body: string;
  kind?: "sms" | "whatsapp";
  idempotencyKey?: string;
}

export interface EmailProvider {
  channel: "email";
  send(m: EmailMessage): Promise<SendResult>;
}

export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
}

/** The base seam: any per-channel provider. `in_app` has no provider — the engine writes the row. */
export type NotificationProvider = EmailProvider | SmsProvider;

/** Rendered per-channel CONTENT (the output of an inline template function). Distinct from the
 *  wire *Message types above (which add `to`/`from`): content is channel payload only. */
export interface EmailContent {
  subject: string;
  text: string;
  html?: string;
}

export interface SmsPayload {
  body: string;
  kind?: "sms" | "whatsapp";
}

export interface InAppContent {
  title: string;
  body: string;
  /** Extra structured fields land on the inbox row's `data`. */
  [key: string]: unknown;
}
