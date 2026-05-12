import * as http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";
import type { PushProvider, PushMessage, PushSendResult } from "./provider";
import { NotificationSendError } from "./provider";

const PROD_URL = "https://api.push.apple.com";
const SANDBOX_URL = "https://api.sandbox.push.apple.com";
const JWT_REFRESH_MS = 50 * 60_000; // Apple: refresh at most once/hour — stay well under it

interface CachedJwt { token: string; mintedAt: number }

/** APNs provider API — HTTP/2 ONLY (Apple has no HTTP/1.1 fallback for this endpoint), hence
 *  `node:http2` rather than the `fetch`-based pattern every other provider in this component uses
 *  (Node's global `fetch` does not negotiate ALPN h2 to arbitrary hosts). Auth is a per-adapter-
 *  instance cached ES256 JWT (`kid`=Key ID, `iss`=Team ID), reused across sends and re-signed only
 *  once its cache age exceeds `JWT_REFRESH_MS` (well under Apple's documented ~1hr guidance to
 *  avoid rate-limiting the token-generation endpoint — unlike FCM, APNs JWTs are SELF-SIGNED
 *  locally, not exchanged over the network — "refresh" here means re-sign, not re-fetch). */
export function apnsPush(opts: { teamId: string; keyId: string; privateKey: string; bundleId: string; production?: boolean; baseUrl?: string }): PushProvider {
  const base = opts.baseUrl ?? (opts.production ? PROD_URL : SANDBOX_URL);
  let cached: CachedJwt | null = null;

  async function getJwt(): Promise<string> {
    if (cached && Date.now() - cached.mintedAt < JWT_REFRESH_MS) return cached.token;
    const key = await importPKCS8(opts.privateKey, "ES256");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ iss: opts.teamId })
      .setProtectedHeader({ alg: "ES256", kid: opts.keyId })
      .setIssuedAt(now)
      .sign(key);
    cached = { token, mintedAt: Date.now() };
    return token;
  }

  async function sendOne(session: http2.ClientHttp2Session, token: string, deviceToken: string, m: PushMessage): Promise<{ ok: true; id?: string } | { ok: false; invalid: true } | { ok: false; invalid: false; error: string; retryable: boolean }> {
    return new Promise((resolve, reject) => {
      const req = session.request({
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${token}`,
        "apns-topic": opts.bundleId,
        "content-type": "application/json",
      });
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        resolve(parseResult());
      });
      let statusCode = 0;
      let apnsId: string | undefined;
      req.on("response", (headers) => {
        statusCode = Number(headers[":status"]);
        apnsId = headers["apns-id"] as string | undefined;
      });
      req.on("error", reject);
      function parseResult() {
        if (statusCode === 200) return { ok: true as const, id: apnsId };
        const parsed = body ? (JSON.parse(body) as { reason?: string }) : {};
        if (statusCode === 410 || parsed.reason === "Unregistered" || parsed.reason === "BadDeviceToken") {
          return { ok: false as const, invalid: true as const };
        }
        return { ok: false as const, invalid: false as const, error: parsed.reason ?? `status ${statusCode}`, retryable: statusCode >= 500 };
      }
      req.end(JSON.stringify({ aps: { alert: { title: m.title, body: m.body } }, ...(m.data ? m.data : {}) }));
    });
  }

  return {
    channel: "push",
    async send(m: PushMessage): Promise<PushSendResult> {
      const token = await getJwt();
      // KNOWN v1 SIMPLIFICATION: a fresh session is connected and closed PER SEND (not pooled/reused
      // across sends). Correct, but not Apple's recommended long-run pattern (keep one connection
      // open across many sends) — a documented perf follow-up, not built now.
      const session = http2.connect(base);
      try {
        const invalidTokens: string[] = [];
        let providerMessageId: string | undefined;
        const errors: string[] = [];
        for (const deviceToken of m.to) {
          const r = await sendOne(session, token, deviceToken, m);
          if (r.ok) { providerMessageId ??= r.id; continue; }
          if (r.invalid) { invalidTokens.push(deviceToken); continue; }
          errors.push(r.error);
        }
        // Carry any permanently-invalid tokens found this pass onto the thrown error so the driver
        // prunes them even though the attempt fails (they'd otherwise be lost with the throw).
        if (errors.length > 0) throw new NotificationSendError(`apns send failed: ${errors.join("; ")}`, { retryable: true, invalidTokens });
        return invalidTokens.length ? { providerMessageId, invalidTokens } : { providerMessageId };
      } finally {
        session.close();
      }
    },
  };
}
