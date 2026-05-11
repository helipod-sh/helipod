import type { NotificationsConfig, Channel, InlineTemplate, PushProviderKind } from "./config";
import type { EmailContent, InAppContent, SmsPayload, SendResult, EmailProvider, SmsProvider, PushContent, PushSendResult } from "./provider";
import { NotificationSendError } from "./provider";

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

export function renderPush(config: NotificationsConfig, template: string | InlineTemplate, data: Record<string, unknown> | undefined): PushContent {
  if (typeof template === "string") {
    const fn = config.channels.push?.templates?.[template];
    if (!fn) throw noTemplateError("push", template);
    return fn(data ?? {});
  }
  if (!template.push) throw new Error(`inline template has no "push" content but "push" was in channels`);
  return template.push;
}

/** One registered device token, as snapshotted onto a push `messages` row at send time
 *  (`recordSend`'s push branch) and consumed by `deliverOutbound`'s push branch. */
export interface PushTokenEntry { token: string; provider: PushProviderKind }

/** A queued/now delivery to hand to a provider — the driver and `sendNow` both dispatch through here
 *  (the ONE place that maps a channel to its configured provider + `from`). */
export interface DeliverEntry {
  channel: "email" | "sms" | "push";
  to: string;
  payload: EmailContent | SmsPayload | PushContent;
  tokens?: PushTokenEntry[]; // push only — the snapshotted device tokens to fan out to
  idempotencyKey?: string;
}

export interface DeliverOutcome extends SendResult {
  /** The provider that ultimately succeeded. Omitted for push (a single logical send can fan out
   *  across MULTIPLE provider groups — expo/fcm/apns — so there's no single "the" provider name). */
  providerName?: string;
  /** Push only: tokens the provider(s) reported as permanently unregistered/invalid — pruned by the
   *  caller (the driver / `sendNow`) via `_pruneInvalidPushTokens`, never retried. */
  invalidTokens?: string[];
}

/** The channel's ordered provider list — `[provider, ...fallbacks]` — each paired with its
 *  diagnostic label (its own `.name`, else a positional default), plus the channel's `from`
 *  address. Throws if the channel isn't configured at all (same guard `deliverOutbound` always
 *  had). */
function providerList(config: NotificationsConfig, channel: "email" | "sms"): { from: string; list: Array<{ provider: EmailProvider | SmsProvider; label: string }> } {
  if (channel === "email") {
    const ch = config.channels.email;
    if (!ch) throw new Error("email channel not configured");
    const all: EmailProvider[] = [ch.provider, ...(ch.fallbacks ?? [])];
    return { from: ch.from, list: all.map((p, i) => ({ provider: p, label: p.name ?? (i === 0 ? "primary" : `fallback-${i}`) })) };
  }
  const ch = config.channels.sms;
  if (!ch) throw new Error("sms channel not configured");
  const all: SmsProvider[] = [ch.provider, ...(ch.fallbacks ?? [])];
  return { from: ch.from, list: all.map((p, i) => ({ provider: p, label: p.name ?? (i === 0 ? "primary" : `fallback-${i}`) })) };
}

/** One provider's `send` call — the SAME per-channel `compact({...})` dispatch `deliverOutbound`
 *  always did (unchanged field mapping from before this slice), just parameterized over which
 *  provider/`from` to use. */
async function sendVia(channel: "email" | "sms", provider: EmailProvider | SmsProvider, from: string, e: DeliverEntry): Promise<SendResult> {
  if (channel === "email") {
    const c = e.payload as EmailContent;
    return (provider as EmailProvider).send(
      compact({ to: e.to, from, subject: c.subject, text: c.text, html: c.html, idempotencyKey: e.idempotencyKey }),
    );
  }
  const p = e.payload as SmsPayload;
  return (provider as SmsProvider).send(
    compact({ to: e.to, from, body: p.body, kind: p.kind, idempotencyKey: e.idempotencyKey }),
  );
}

/** Resolve the channel's ordered provider list and try each in turn until one succeeds (provider-
 *  level failover — see the fallback design doc, decisions 3/4). Network I/O — called ONLY from the
 *  driver's action context or the action-mode `sendNow`, never a mutation. On a delivery attempt
 *  where EVERY provider fails, throws a combined `NotificationSendError` whose `retryable` is the
 *  OR across every tried provider's own classification (decision 4) — so N2's existing
 *  `_markResult` retry/dead-letter logic needs no change to understand a fallback-aware failure.
 *
 *  Push is a DIFFERENT shape (fan-out across N provider GROUPS by token, not a single ordered
 *  fallback list) — handled by its own branch before the email/sms `providerList` path. */
export async function deliverOutbound(config: NotificationsConfig, e: DeliverEntry): Promise<DeliverOutcome> {
  if (e.channel === "push") {
    const tokens = e.tokens ?? [];
    if (tokens.length === 0) return {}; // decision 6 — no devices is not a failure
    const content = e.payload as PushContent;
    const byProvider = new Map<PushProviderKind, string[]>();
    for (const t of tokens) {
      if (!byProvider.has(t.provider)) byProvider.set(t.provider, []);
      byProvider.get(t.provider)!.push(t.token);
    }
    let providerMessageId: string | undefined;
    const invalidTokens: string[] = [];
    const errors: string[] = [];
    for (const [kind, toks] of byProvider) {
      const provider = config.channels.push?.providers[kind];
      if (!provider) { console.warn(`[notifications] push tokens registered for unconfigured provider "${kind}" — skipped`); continue; }
      try {
        const res: PushSendResult = await provider.send(compact({ to: toks, title: content.title, body: content.body, data: content.data, idempotencyKey: e.idempotencyKey }));
        providerMessageId ??= res.providerMessageId;
        if (res.invalidTokens) invalidTokens.push(...res.invalidTokens);
      } catch (err) {
        errors.push(`${kind}: ${String(err)}`);
      }
    }
    // Only rethrow (→ N2 retry/backoff) if EVERY configured group failed outright — decision 7.
    if (errors.length > 0 && errors.length === byProvider.size) {
      throw new NotificationSendError(errors.join("; "));
    }
    if (errors.length > 0) console.error(`[notifications] push: partial group failure (row still marked sent): ${errors.join("; ")}`);
    return compact({ providerMessageId, invalidTokens: invalidTokens.length ? invalidTokens : undefined });
  }
  const { from, list } = providerList(config, e.channel);
  const failures: string[] = [];
  let anyRetryable = false;
  let lastError: unknown;
  for (const { provider, label } of list) {
    try {
      const res = await sendVia(e.channel, provider, from, e);
      return { ...res, providerName: label };
    } catch (err) {
      lastError = err;
      const retryable = err instanceof NotificationSendError ? err.retryable : true;
      anyRetryable = anyRetryable || retryable;
      failures.push(`[${label}] ${String(err)}`);
    }
  }
  // Zero-behavior-change for the common NO-FALLBACK case: a single-provider list re-throws the
  // provider's OWN error verbatim (class, message, and `retryable`), byte-identical to the
  // pre-fallback single-`provider.send()` path — no `[primary]` prefix, no re-wrap. Only a genuine
  // multi-provider walk combines the per-provider failures into one OR-classified error.
  if (list.length === 1) throw lastError;
  throw new NotificationSendError(failures.join("; "), { retryable: anyRetryable });
}
