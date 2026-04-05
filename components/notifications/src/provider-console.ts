import type { EmailProvider, SmsProvider } from "./provider";

/** Zero-config dev default: logs the full email (incl. any code/link) to the server console.
 *  Generalizes `components/auth/src/email/provider.ts`'s `consoleEmail` (auth's copy is untouched). */
export function consoleEmail(): EmailProvider {
  return {
    channel: "email",
    async send(m) {
      console.log(
        `\n[stackbase notifications] email →\n  to:      ${m.to}\n  from:    ${m.from}\n  subject: ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}\n`,
      );
      return {};
    },
  };
}

/** Zero-config dev SMS provider: logs the message to the server console (no delivery). */
export function consoleSms(): SmsProvider {
  return {
    channel: "sms",
    async send(m) {
      const kind = m.kind === "whatsapp" ? "whatsapp" : "sms";
      console.log(`\n[stackbase notifications] ${kind} →\n  to:   ${m.to}\n  from: ${m.from}\n  ${m.body.replace(/\n/g, "\n  ")}\n`);
      return {};
    },
  };
}
