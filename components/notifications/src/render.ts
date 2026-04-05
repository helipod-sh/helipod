import type { NotificationsConfig, Channel, InlineTemplate } from "./config";
import type { EmailContent, InAppContent, SmsPayload, SendResult } from "./provider";

/** Drop `undefined`-valued keys before a `db.insert`/`db.replace` — the syscall codec rejects
 *  `undefined`; omit rather than null it out. Mirrors `components/scheduler/src/facade.ts`'s `compact`. */
export function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(obj)) if (val !== undefined) out[k] = val;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Deterministic, key-order-stable JSON for hashing (so `{a,b}` and `{b,a}` hash identically). */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** A stable, dependency-free hash of the template payload — for dedup/diagnostics, NEVER the
 *  payload itself (no PII at rest beyond the rendered content). djb2 over the stable JSON. */
export function stableHash(data: unknown): string {
  const s = stableStringify(data ?? null);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function noTemplateError(channel: Channel, template: string): Error {
  return new Error(`no ${channel} template "${template}" registered on defineNotifications({ channels.${channel}.templates })`);
}

/** Render email content for a send: a registered templateKey resolves against config templates; an
 *  inline object supplies content directly. Pure — no I/O — so it runs inside the send mutation. */
export function renderEmail(config: NotificationsConfig, template: string | InlineTemplate, data: Record<string, unknown> | undefined): EmailContent {
  if (typeof template === "string") {
    const fn = config.channels.email?.templates?.[template];
    if (!fn) throw noTemplateError("email", template);
    return fn(data ?? {});
  }
  if (!template.email) throw new Error(`inline template has no "email" content but "email" was in channels`);
  return template.email;
}

export function renderSms(config: NotificationsConfig, template: string | InlineTemplate, data: Record<string, unknown> | undefined): SmsPayload {
  if (typeof template === "string") {
    const fn = config.channels.sms?.templates?.[template];
    if (!fn) throw noTemplateError("sms", template);
    return { body: fn(data ?? {}) };
  }
  if (template.sms === undefined) throw new Error(`inline template has no "sms" content but "sms" was in channels`);
  return { body: template.sms };
}

export function renderInApp(config: NotificationsConfig, template: string | InlineTemplate, data: Record<string, unknown> | undefined): InAppContent {
  if (typeof template === "string") {
    const fn = config.channels.in_app?.templates?.[template];
    if (!fn) throw noTemplateError("in_app", template);
    return fn(data ?? {});
  }
  if (!template.in_app) throw new Error(`inline template has no "in_app" content but "in_app" was in channels`);
  return template.in_app;
}

/** A queued/now delivery to hand to a provider — the driver and `sendNow` both dispatch through here
 *  (the ONE place that maps a channel to its configured provider + `from`). */
export interface DeliverEntry {
  channel: "email" | "sms";
  to: string;
  payload: EmailContent | SmsPayload;
  idempotencyKey?: string;
}

/** Resolve the channel's provider and deliver. Network I/O — called ONLY from the driver's action
 *  context or the action-mode `sendNow`, never a mutation. Throws on provider failure (the caller
 *  records `failed`). Passes `idempotencyKey` through to the provider's native header when set. */
export async function deliverOutbound(config: NotificationsConfig, e: DeliverEntry): Promise<SendResult> {
  if (e.channel === "email") {
    const ch = config.channels.email;
    if (!ch) throw new Error("email channel not configured");
    const c = e.payload as EmailContent;
    return ch.provider.send(
      compact({ to: e.to, from: ch.from, subject: c.subject, text: c.text, html: c.html, idempotencyKey: e.idempotencyKey }),
    );
  }
  const ch = config.channels.sms;
  if (!ch) throw new Error("sms channel not configured");
  const p = e.payload as SmsPayload;
  return ch.provider.send(
    compact({ to: e.to, from: ch.from, body: p.body, kind: p.kind, idempotencyKey: e.idempotencyKey }),
  );
}
