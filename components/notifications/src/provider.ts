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
  webhook?: ProviderWebhook;
  /** Optional diagnostic label recorded as `messages.providerName` on a successful send via this
   *  provider. Defaults to a positional label ("primary" / "fallback-1" / "fallback-2" / …). */
  name?: string;
}

export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
  name?: string;
}

/** The base seam: any per-channel provider. `in_app` has no provider — the engine writes the row. */
export interface PushMessage {
  to: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}
export interface PushSendResult extends SendResult {
  /** Tokens the provider reported as permanently unregistered/invalid — pruned by the caller
   *  (the driver / `sendNow`) via `_pruneInvalidPushTokens`, never retried. */
  invalidTokens?: string[];
}
export interface PushProvider {
  channel: "push";
  send(m: PushMessage): Promise<PushSendResult>;
  // no `webhook?` — push invalid-token detection is synchronous (send response), no async webhook.
}
export type NotificationProvider = EmailProvider | SmsProvider | PushProvider;
export interface PushContent {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

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

/** Thrown by a provider `send` to signal whether the failure should be retried. A plain `Error`
 *  throw is treated as retryable by default; throw `new NotificationSendError(msg, {retryable:false})`
 *  for a permanent failure (e.g. a 4xx bad-recipient) so the driver dead-letters immediately. */
export class NotificationSendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message);
    this.name = "NotificationSendError";
    this.retryable = opts?.retryable ?? true;
  }
}

/** The normalized, cross-provider delivery status (axis 2 — provider-reported via webhooks). */
export type DeliveryStatus =
  | "delivered" | "bounced" | "complained" | "opened" | "clicked" | "dropped" | "failed_permanent";

/** One normalized delivery event parsed from a provider webhook payload. */
export interface WebhookEvent {
  providerMessageId: string;
  deliveryStatus: DeliveryStatus;
  /** Optional detail (bounce reason, etc.). */
  detail?: string;
}

/** Inputs to a provider's webhook signature verification. */
export interface WebhookVerifyArgs {
  headers: Headers;
  rawBody: string;
  url: string;
  /** The configured signing secret for this channel (e.g. Resend `whsec_…`); may be undefined. */
  secret?: string;
}

/** Optional per-provider delivery-webhook support. `verify` MUST return false on any missing/invalid
 *  signature (the route rejects with 401 before any write); `parse` maps the provider's payload to
 *  normalized events (throw on a malformed body → the route answers 400). */
export interface ProviderWebhook {
  verify(args: WebhookVerifyArgs): boolean | Promise<boolean>;
  parse(rawBody: string): WebhookEvent[];
}
