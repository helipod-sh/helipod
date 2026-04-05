import type { EmailProvider, EmailMessage, SendResult } from "./provider";

/** Production email adapter: ONE fetch to the Resend API, zero deps, throws on non-2xx. Passes the
 *  send's `idempotencyKey` through to Resend's native `Idempotency-Key` header (one of the 2/8
 *  providers with native support). Generalizes `components/auth`'s `resendEmail` (auth untouched). */
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
        throw new Error(`resend send failed (${res.status}): ${body}`);
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: json.id };
    },
  };
}
