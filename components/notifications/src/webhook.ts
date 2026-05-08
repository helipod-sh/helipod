import { httpAction, mutation, type ActionCtx, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { NotificationsConfig } from "./config";
import type { DeliveryStatus, NotificationProvider } from "./provider";
import { compact } from "./render";

const WEBHOOK_PREFIX = "/api/notifications/webhooks/";

/** Lifecycle rank — a webhook event only applies if it is strictly higher-rank than the row's
 *  current deliveryStatus, so a redelivered or out-of-order event is a monotonic no-op. */
const RANK: Record<DeliveryStatus, number> = {
  dropped: 1, bounced: 2, complained: 2, failed_permanent: 2, delivered: 3, opened: 4, clicked: 5,
};

/** Resolve the ordered candidate providers for a webhook path segment (the CHANNEL name:
 *  "email"|"sms") — `[provider, ...fallbacks]` — each paired with the secret to pass it (only the
 *  PRIMARY, index 0, gets the channel-level `webhookSecret`; every fallback gets `secret: undefined`
 *  and is expected to carry its own verification material internally — decision 9). */
function resolveWebhookProviders(config: NotificationsConfig, channel: string): Array<{ provider: NotificationProvider; secret?: string }> {
  if (channel === "email") {
    const ch = config.channels.email;
    if (!ch) return [];
    return [{ provider: ch.provider, secret: ch.webhookSecret }, ...(ch.fallbacks ?? []).map((p) => ({ provider: p, secret: undefined }))];
  }
  if (channel === "sms") {
    const ch = config.channels.sms;
    if (!ch) return [];
    return [{ provider: ch.provider, secret: undefined }, ...(ch.fallbacks ?? []).map((p) => ({ provider: p, secret: undefined }))];
  }
  return [];
}

/** Reconstruct the PUBLIC URL a URL-signing provider (Twilio) signed over, honoring a TLS-terminating
 *  reverse proxy. Stackbase serves plain HTTP and is fronted by nginx/Caddy/Traefik (a locked deploy
 *  decision), which set `X-Forwarded-Proto`/`X-Forwarded-Host`. Twilio's `X-Twilio-Signature` is
 *  computed over the exact PUBLIC `https://…` URL configured in its console, which differs in scheme
 *  (and often host) from the internal `request.url` behind the proxy — so without this reconstruction
 *  every Twilio callback would 401 in the documented topology. Svix (Resend) signs the body, not the
 *  URL, so it is unaffected either way. Falls back to `request.url` when no forwarded headers are set
 *  (direct exposure / dev). Forging these headers cannot make verification PASS — the HMAC still needs
 *  the provider's secret — it can only cause an attacker's own forged callback to fail. */
function publicUrlOf(request: Request): string {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (!proto && !host) return url.toString();
  // String-build the authority (not the URL `.host`/`.protocol` setters, whose port-retention quirk
  // would leave a stale internal port on the public URL). A forwarded host WITHOUT a port yields an
  // authority without a port — exactly the URL the provider was configured to sign over.
  const scheme = proto ?? url.protocol.replace(/:$/, "");
  const authority = host ?? url.host;
  return `${scheme}://${authority}${url.pathname}${url.search}`;
}

export function makeWebhookModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // Reachable from the webhookHttp httpAction via `ctx.runMutation` — a NON-privileged action-to-
  // mutation invoke (unlike the driver's `ctx.runFunction`, which runs privileged), so this uses the
  // BARE table name ("messages") and lets standard namespacing resolve it to `notifications/messages`
  // — the same convention `recordSend`/`inbox` use for every other action/client-reachable internal
  // mutation. (A fully-qualified name here would double-prefix to `notifications/notifications/
  // messages` and 404 on `byProviderMessageId` — reproduced while writing this module's test.)
  const _applyWebhookEvent = mutation(async (ctx: MutationCtx, args: { providerMessageId: string; deliveryStatus: DeliveryStatus; detail?: string }): Promise<null> => {
    const [row] = await ctx.db.query("messages", "byProviderMessageId").eq("providerMessageId", args.providerMessageId).take(1).collect();
    if (!row) return null; // foreign / out-of-order delivery — drop (the row may not exist yet or ever)
    if (args.deliveryStatus === "complained") {
      // Compliance signal (spam complaint) — ALWAYS arrives after `delivered`, so it must NOT be gated
      // by the monotonic delivery rank (which would drop it as lower-rank than `delivered`). Recorded
      // unconditionally in its own orthogonal field; idempotent (a redelivered complaint is a no-op).
      if (row.complainedAt !== undefined) return null;
      await ctx.db.replace(row._id as string, compact({ ...row, complainedAt: ctx.now() }));
      return null;
    }
    const cur = row.deliveryStatus as DeliveryStatus | undefined;
    if (cur && RANK[cur] >= RANK[args.deliveryStatus]) return null; // monotonic: redelivered/older event → no-op
    await ctx.db.replace(row._id as string, compact({ ...row, deliveryStatus: args.deliveryStatus, deliveryDetail: args.detail }));
    return null;
  });

  const webhookHttp = httpAction(async (ctx, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const channel = url.pathname.slice(WEBHOOK_PREFIX.length); // "email" | "sms"
    const candidates = resolveWebhookProviders(config, channel).filter((c) => c.provider.webhook);
    if (candidates.length === 0) return new Response("unknown webhook channel", { status: 404 });
    const rawBody = await request.text();
    // Sign-check against the PUBLIC url (proxy-forwarded), so URL-signing providers (Twilio) verify
    // behind the documented TLS-terminating proxy. Verify strictly BEFORE any read/write. Try every
    // configured provider's verify in order — first match wins (a fallback's own webhook may be
    // registered at the vendor with different signing material than the primary's).
    const publicUrl = publicUrlOf(request);
    let matched: NotificationProvider | undefined;
    for (const { provider, secret } of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await provider.webhook!.verify({ headers: request.headers, rawBody, url: publicUrl, secret });
      if (ok) { matched = provider; break; }
    }
    if (!matched) return new Response("invalid signature", { status: 401 }); // BEFORE any write
    let events;
    try { events = matched.webhook!.parse(rawBody); } catch { return new Response("bad payload", { status: 400 }); }
    for (const e of events) {
      await (ctx as ActionCtx).runMutation<null>("notifications:_applyWebhookEvent", compact({ providerMessageId: e.providerMessageId, deliveryStatus: e.deliveryStatus, detail: e.detail }));
    }
    return new Response("ok", { status: 200 }); // ack so the provider stops retrying
  });

  return { webhookHttp, _applyWebhookEvent };
}
