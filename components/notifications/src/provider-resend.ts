import type { EmailProvider, EmailMessage, SendResult, DeliveryStatus, WebhookEvent, WebhookVerifyArgs } from "./provider";
import { NotificationSendError } from "./provider";
import { createHmac, timingSafeEqual } from "node:crypto";

const SVIX_TOLERANCE_S = 5 * 60; // reject timestamps more than 5 minutes from now (replay guard)

/** Map a Resend webhook `type` to a normalized DeliveryStatus (unknown types are ignored). */
const RESEND_STATUS: Record<string, DeliveryStatus> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.delivery_delayed": "dropped",
};

function svixVerify(args: WebhookVerifyArgs): boolean {
  if (!args.secret) return false;
  const id = args.headers.get("svix-id");
  const ts = args.headers.get("svix-timestamp");
  const sigHeader = args.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > SVIX_TOLERANCE_S) return false;
  const key = Buffer.from(args.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${args.rawBody}`).digest();
  // The header is a space-separated list of `v1,<b64>` — accept if ANY entry matches (constant-time).
  for (const part of sigHeader.split(" ")) {
    const b64 = part.startsWith("v1,") ? part.slice(3) : part.includes(",") ? part.split(",")[1]! : part;
    let got: Buffer;
    try { got = Buffer.from(b64, "base64"); } catch { continue; }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** Production email adapter: ONE fetch to the Resend API, zero deps, throws on non-2xx. Passes the
 *  send's `idempotencyKey` through to Resend's native `Idempotency-Key` header (one of the 2/8
 *  providers with native support). Generalizes `components/auth`'s `resendEmail` (auth untouched).
 *  Also implements the inbound delivery webhook (Svix signature scheme Resend uses): `verify` checks
 *  the HMAC-SHA256 signature over `${svix-id}.${svix-timestamp}.${rawBody}` (constant-time compare,
 *  5-min timestamp-skew guard); `parse` maps Resend event types to the normalized `DeliveryStatus`. */
export function resendEmail(opts: { apiKey: string; baseUrl?: string }): EmailProvider {
  const base = opts.baseUrl ?? "https://api.resend.com";
  return {
    channel: "email",
    async send(m: EmailMessage): Promise<SendResult> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      };
      if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey;
      const res = await fetch(`${base}/emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 4xx (except 429 rate-limit) is a permanent client error → do not retry. 5xx/429 → retry.
        const retryable = res.status >= 500 || res.status === 429;
        throw new NotificationSendError(`resend send failed (${res.status}): ${body}`, { retryable });
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: json.id };
    },
    webhook: {
      verify: svixVerify,
      parse(rawBody: string): WebhookEvent[] {
        const evt = JSON.parse(rawBody) as { type?: string; data?: { email_id?: string } };
        const ds = evt.type ? RESEND_STATUS[evt.type] : undefined;
        const id = evt.data?.email_id;
        if (!ds || !id) return [];
        return [{ providerMessageId: id, deliveryStatus: ds }];
      },
    },
  };
}
