import type { SmsProvider, SmsMessage, SendResult } from "./provider";

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
        throw new Error(`twilio send failed (${res.status}): ${body}`);
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string };
      return { providerMessageId: json.sid };
    },
  };
}
