import type { PushProvider, PushMessage, PushSendResult } from "./provider";
import { NotificationSendError } from "./provider";

const CHUNK_SIZE = 100; // Expo's documented per-request message cap

interface ExpoTicket { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } }

/** Simplest push adapter: ONE HTTP endpoint, no auth required for anonymous sends (an optional
 *  `accessToken` enables Expo's enhanced security / higher rate limits). Auto-chunks a large `to`
 *  array into <=100-message requests (Expo's documented cap) — invisible to the caller, one logical
 *  send still yields one merged result. A per-token "error" ticket with
 *  `details.error === "DeviceNotRegistered"` maps to `invalidTokens`; any other per-ticket error is
 *  logged but not treated as a prunable token (could be transient — rate limit, malformed payload). */
export function expoPush(opts?: { accessToken?: string; baseUrl?: string }): PushProvider {
  const base = opts?.baseUrl ?? "https://exp.host/--/api/v2/push";
  return {
    channel: "push",
    async send(m: PushMessage): Promise<PushSendResult> {
      const invalidTokens: string[] = [];
      let providerMessageId: string | undefined;
      for (let i = 0; i < m.to.length; i += CHUNK_SIZE) {
        const chunk = m.to.slice(i, i + CHUNK_SIZE);
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
        if (opts?.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
        const res = await fetch(`${base}/send`, {
          method: "POST",
          headers,
          body: JSON.stringify(chunk.map((to) => ({ to, title: m.title, body: m.body, data: m.data }))),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new NotificationSendError(`expo push send failed (${res.status}): ${body}`, { retryable: res.status >= 500 || res.status === 429 });
        }
        const json = (await res.json().catch(() => ({}))) as { data?: ExpoTicket[] };
        (json.data ?? []).forEach((ticket, idx) => {
          if (ticket.status === "ok") { providerMessageId ??= ticket.id; return; }
          if (ticket.details?.error === "DeviceNotRegistered") invalidTokens.push(chunk[idx]!);
        });
      }
      return invalidTokens.length ? { providerMessageId, invalidTokens } : { providerMessageId };
    },
  };
}
