/** The whole send seam — a plain async `send`. No Auth.js provider-object shape (decision: rejected). */
export interface EmailMessage { to: string; from: string; subject: string; text: string; html?: string }
export interface EmailProvider { send(msg: EmailMessage): Promise<void> }

/** Zero-config dev default (decision 14): logs the full email (incl. code/link) to the server console. */
export function consoleEmail(): EmailProvider {
  return {
    async send(msg) {
      // Intentionally logs the raw code/link — dev-only convenience, documented as such.
      console.log(
        `\n[stackbase auth] email →\n  to:      ${msg.to}\n  from:    ${msg.from}\n  subject: ${msg.subject}\n  ${msg.text.replace(/\n/g, "\n  ")}\n`,
      );
    },
  };
}

/** Production adapter (decision 14): ONE fetch to the Resend API, zero deps, throws on non-2xx. */
export function resendEmail(opts: { apiKey: string; baseUrl?: string }): EmailProvider {
  const base = opts.baseUrl ?? "https://api.resend.com";
  return {
    async send(msg) {
      const res = await fetch(`${base}/emails`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: msg.from, to: msg.to, subject: msg.subject, text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`resend send failed (${res.status}): ${body}`);
      }
    },
  };
}
