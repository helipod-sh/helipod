import { SignJWT, importPKCS8 } from "jose";
import type { PushProvider, PushMessage, PushSendResult } from "./provider";
import { NotificationSendError } from "./provider";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REFRESH_SKEW_MS = 5 * 60_000; // refresh 5 min before expiry

interface CachedToken { accessToken: string; expiresAt: number }

/** FCM HTTP v1: OAuth2 via a Google service-account JWT (RS256, exchanged at Google's token
 *  endpoint for a Bearer access token, cached in-memory and refreshed ~5 min before its ~1hr
 *  expiry — one adapter instance = one cache, matching how a long-lived driver process holds it).
 *  One HTTP request PER TOKEN (FCM v1 has no batch-send endpoint, unlike Expo) — hidden inside this
 *  adapter's own loop, invisible to the notifications component (which calls `send` once per
 *  provider GROUP regardless of token count).
 *
 *  KNOWN v1 SIMPLIFICATION: the per-token loop throws on the FIRST genuine hard failure (a non-
 *  UNREGISTERED/NOT_FOUND error), aborting the REST of that group's tokens for this pass — it does
 *  not collect partial per-token results before throwing. Accepted for v1; a future refinement could
 *  gather every token's outcome independently. Not silently swallowed — documented here + at the throw. */
export function fcmPush(opts: { projectId: string; serviceAccount: { client_email: string; private_key: string }; baseUrl?: string }): PushProvider {
  const base = opts.baseUrl ?? "https://fcm.googleapis.com/v1";
  let cached: CachedToken | null = null;

  async function getAccessToken(): Promise<string> {
    if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached.accessToken;
    const key = await importPKCS8(opts.serviceAccount.private_key, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: TOKEN_SCOPE })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(opts.serviceAccount.client_email)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
    });
    if (!res.ok) throw new NotificationSendError(`fcm token exchange failed (${res.status})`, { retryable: true });
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.accessToken;
  }

  return {
    channel: "push",
    async send(m: PushMessage): Promise<PushSendResult> {
      const token = await getAccessToken();
      const invalidTokens: string[] = [];
      let providerMessageId: string | undefined;
      for (const to of m.to) {
        const res = await fetch(`${base}/projects/${opts.projectId}/messages:send`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ message: { token: to, notification: { title: m.title, body: m.body }, ...(m.data ? { data: Object.fromEntries(Object.entries(m.data).map(([k, v]) => [k, String(v)])) } : {}) } }),
        });
        if (res.ok) { const json = (await res.json()) as { name?: string }; providerMessageId ??= json.name; continue; }
        const body = (await res.json().catch(() => ({}))) as { error?: { status?: string } };
        if (body.error?.status === "UNREGISTERED" || body.error?.status === "NOT_FOUND") { invalidTokens.push(to); continue; }
        throw new NotificationSendError(`fcm send failed (${res.status}): ${body.error?.status ?? ""}`, { retryable: res.status >= 500 || res.status === 429 });
      }
      return invalidTokens.length ? { providerMessageId, invalidTokens } : { providerMessageId };
    },
  };
}
