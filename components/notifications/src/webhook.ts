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

/** Resolve the configured provider for a webhook path segment (the CHANNEL name: "email"|"sms"),
 *  plus its signing secret. One provider per channel in N1/N2. */
function resolveWebhookProvider(config: NotificationsConfig, channel: string): { provider?: NotificationProvider; secret?: string } {
  if (channel === "email") return { provider: config.channels.email?.provider, secret: config.channels.email?.webhookSecret };
  if (channel === "sms") return { provider: config.channels.sms?.provider, secret: undefined };
  return {};
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
    const cur = row.deliveryStatus as DeliveryStatus | undefined;
    if (cur && RANK[cur] >= RANK[args.deliveryStatus]) return null; // monotonic: redelivered/older event → no-op
    await ctx.db.replace(row._id as string, compact({ ...row, deliveryStatus: args.deliveryStatus, deliveryDetail: args.detail }));
    return null;
  });

  const webhookHttp = httpAction(async (ctx, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const channel = url.pathname.slice(WEBHOOK_PREFIX.length); // "email" | "sms"
    const { provider, secret } = resolveWebhookProvider(config, channel);
    if (!provider?.webhook) return new Response("unknown webhook channel", { status: 404 });
    const rawBody = await request.text();
    const ok = await provider.webhook.verify({ headers: request.headers, rawBody, url: request.url, secret });
    if (!ok) return new Response("invalid signature", { status: 401 }); // BEFORE any write
    let events;
    try { events = provider.webhook.parse(rawBody); } catch { return new Response("bad payload", { status: 400 }); }
    for (const e of events) {
      await (ctx as ActionCtx).runMutation<null>("notifications:_applyWebhookEvent", compact({ providerMessageId: e.providerMessageId, deliveryStatus: e.deliveryStatus, detail: e.detail }));
    }
    return new Response("ok", { status: 200 }); // ack so the provider stops retrying
  });

  return { webhookHttp, _applyWebhookEvent };
}
