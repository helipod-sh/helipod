import type { SmsProvider, SmsMessage, SendResult, DeliveryStatus, WebhookEvent, WebhookVerifyArgs } from "./provider";
import { NotificationSendError } from "./provider";
import { createHmac, timingSafeEqual } from "node:crypto";

const TWILIO_STATUS: Record<string, DeliveryStatus> = {
  delivered: "delivered",
  undelivered: "bounced",
  failed: "failed_permanent",
};

function twilioVerify(authToken: string, args: WebhookVerifyArgs): boolean {
  const provided = args.headers.get("x-twilio-signature");
  if (!provided) return false;
  const params = Object.fromEntries(new URLSearchParams(args.rawBody));
  let data = args.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Production SMS adapter: ONE fetch to the Twilio Messages API (Basic auth, form-encoded), throws
 *  on non-2xx. `kind:"whatsapp"` prefixes both `To`/`From` with `whatsapp:` (WhatsApp addressing at
 *  the provider, not a separate channel). Twilio's basic API has no native idempotency key, so
 *  `idempotencyKey` is NOT forwarded — the orchestrator's `sendReceipts` owns dedup (2/8 providers). */
export function twilioSms(opts: { accountSid: string; authToken: string; baseUrl?: string }): SmsProvider {
  const base = opts.baseUrl ?? "https://api.twilio.com";
  return {
    channel: "sms",
    async send(m: SmsMessage): Promise<SendResult> {
      const to = m.kind === "whatsapp" ? `whatsapp:${m.to}` : m.to;
      const from = m.kind === "whatsapp" ? `whatsapp:${m.from}` : m.from;
      const basic = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");
      const form = new URLSearchParams({ To: to, From: from, Body: m.body });
      const res = await fetch(`${base}/2010-04-01/Accounts/${opts.accountSid}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new NotificationSendError(`twilio send failed (${res.status}): ${body}`, {
          retryable: res.status >= 500 || res.status === 429,
        });
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string };
      return { providerMessageId: json.sid };
    },
    webhook: {
      verify: (args) => twilioVerify(opts.authToken, args),
      parse(rawBody: string): WebhookEvent[] {
        const params = Object.fromEntries(new URLSearchParams(rawBody));
        const ds = params.MessageStatus ? TWILIO_STATUS[params.MessageStatus] : undefined;
        if (!ds || !params.MessageSid) return [];
        return [{ providerMessageId: params.MessageSid, deliveryStatus: ds }];
      },
    },
  };
}
