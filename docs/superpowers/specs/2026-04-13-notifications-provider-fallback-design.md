# Notifications — multi-provider fallback (design)

**Date:** 2026-04-13
**Status:** Approved (decided per the standing "take decisions, don't ask, build" directive)
**Arc context:** The planned notification arc (N1 substrate → N2 delivery reliability → N3
preferences/topics → N4 digest/auth-unify) is **complete** (merged). This is a **post-arc
delivery-mechanics follow-on** — every N2/N3/N4 spec's "what's deferred" section named the same
item consistently: *"multi-provider fallback (Resend→SES on failure)"* (N3 spec, scope decision;
N4 spec, non-goals; `docs/enduser/build/notifications.md`, deferred table). This slice builds it.
It is a direct extension of **N2's retry/backoff model** (`components/notifications/src/backoff.ts`,
`driver.ts`, `modules.ts`'s `_markResult`), not a new subsystem — the goal is to slot provider-level
failover INTO the existing attempt/backoff loop with the smallest possible seam change.

**Goal:** A channel (`email` or `sms`) can configure an ORDERED list of providers. On a delivery
attempt, the driver (and the action-mode `sendNow`) tries each configured provider in order within
that ONE attempt; the attempt succeeds the moment any provider succeeds. Only if every provider in
the list fails does the attempt itself fail — and it re-enters N2's existing retry/backoff/
dead-letter machinery completely unchanged. This is **provider-level failover** (Courier/Novu's
term): routing around one vendor's outage, not a new delivery-orchestration concept.

**Explicitly out of scope (see Non-goals):** cross-*channel* fallback (e.g., "retry a failed email
over SMS" — a different, still-deferred item, sometimes confused with this one in the existing
docs; this slice clarifies the distinction), health-based/weighted routing, per-provider circuit
breaking, quiet-hours/time-based routing.

**Research grounding:** Courier's [Automated Failover](https://www.courier.com/docs/platform/sending/failover)
distinguishes **provider-level failover** (a channel's primary provider is down → try a configured
backup provider on the SAME channel) from **channel-level failover** (a channel itself is
unavailable → move to a different channel). Courier scopes automatic failover triggers to
`408`/`429`/`>=500` — i.e., exactly the shape N2 already classifies as `retryable`. Novu's dashboard
equivalent: "if SendGrid returns 5xx, retry with Resend or SES." Both products treat an ordered
provider list, tried top-to-bottom, as the default policy — neither defaults to health-scored or
weighted routing; that is offered as a separate, heavier feature. This grounds two of the locked
decisions below: (1) an ordered, static list (no health-based reordering) is the right v1 policy,
matching both reference products' default; (2) using N2's existing `retryable` classification as
the walk-continues/walk-stops signal is not a novel invention — it mirrors Courier's own trigger
conditions almost exactly, with one deliberate divergence noted in decision 3.

## Locked design decisions

1. **Config shape: `provider` stays; add optional `fallbacks`.** `EmailChannelConfig`/
   `SmsChannelConfig` keep their existing required `provider` field (zero migration for every
   existing `defineNotifications({channels: {email: {provider, from}}})` call) and each gains
   `fallbacks?: EmailProvider[]` / `fallbacks?: SmsProvider[]` — additional providers tried, in
   array order, after `provider`, within the same delivery attempt. The effective ordered list for
   a channel is `[provider, ...(fallbacks ?? [])]`. Rejected alternative: replacing `provider` with
   a `providers: [...]` array — strictly more disruptive (every existing config literal breaks) for
   no behavioral gain, since `[provider, ...fallbacks]` already IS "an ordered list of providers";
   `fallbacks` is additive sugar on top of the same underlying model.
2. **`from` stays channel-level, shared by every provider in the list.** A provider's `send`
   contract already receives `from` as a per-call argument (`EmailMessage.from`/`SmsMessage.from`),
   not as its own construction-time property — so every provider in the ordered list is handed the
   SAME channel-configured `from` address. Per-provider `from` override (e.g., a different verified
   sending domain per vendor) is a real use case in production email setups, but is deferred — see
   Non-goals — since it would require widening the provider-list entry from a bare
   `EmailProvider`/`SmsProvider` to a `{ provider, from? }` wrapper, a bigger config-shape change
   than this slice's scope justifies without a demonstrated need.
3. **The failover policy — try the WHOLE ordered list within one attempt, not short-circuiting on a
   non-retryable failure.** This is the crux decision. On a delivery attempt, `deliverOutbound` (now
   provider-list-aware) calls `provider[0].send()`; on failure it does NOT decide whether to
   continue based on that provider's own `retryable` classification — it ALWAYS proceeds to
   `provider[1].send()`, then `provider[2]`, etc., stopping only on the first success or after
   every provider in the list has been tried. **Only once every provider has failed** does the
   attempt classify an overall retryable verdict for N2's existing `_markResult` (see decision 4).
   Rationale: a `NotificationSendError({retryable:false})` from one provider (e.g., a 4xx "invalid
   recipient domain") reflects THAT vendor's validation/allowlist, which a different vendor may not
   share — Resend rejecting a domain doesn't mean SES will. Not trying the fallback in that case
   would silently forfeit exactly the scenario multi-provider config exists to cover. The one
   documented divergence from Courier's product (which scopes automatic failover triggers strictly
   to `408`/`429`/`5xx` and does NOT fail over on an application-level 4xx): Courier's model is
   justified by ITS heavier async multi-provider-timeout architecture (5 min/provider, 30 min/
   channel, 72 h/message — see the research above); this component's whole provider-list walk
   happens synchronously inside ONE driver-pass network round trip (milliseconds, 2-3 providers in
   practice), so the cost of "try the next provider even though this one 4xx'd" is negligible and
   the safety upside (a genuinely-provider-specific rejection doesn't waste a whole N2 backoff
   cycle) outweighs it. An early-exit-on-non-retryable policy (closer to Courier's literal trigger
   set) is left as a possible future config knob — see Non-goals — not built now because no
   evidence yet suggests the default is wrong for real provider pairs (Resend/SES, Twilio/Vonage).
4. **The overall attempt's retryable verdict: retryable if ANY tried provider's failure was
   retryable; non-retryable ONLY if every provider's failure was non-retryable.** This is what feeds
   N2's unchanged `_markResult` (`args.retryable`). Concretely: `[4xx, 4xx]` → non-retryable →
   dead-letters immediately on `attempts===1` exactly as a single-provider non-retryable failure
   does today (byte-identical N2 behavior when there's no fallback, or when every fallback also
   4xx's). `[5xx, 4xx]` or `[4xx, 5xx]` or `[5xx, 5xx]` → retryable → the row re-queues with N2's
   existing jittered backoff, and next attempt tries the WHOLE list again from the top (not
   resuming mid-list — decision 6 explains why). This directly answers the two scenarios the task
   named ("all providers 4xx → terminal"; "any provider 5xx/network but others 4xx → retryable") and
   is the most conservative-safe reading consistent with N2's own bias (a plain, unclassified
   `Error` throw already defaults to `retryable: true`).
5. **`deliverOutbound`'s new return shape carries `providerName`; `messages` gains one additive
   field, `providerName?: string`, set ONLY on a successful send.** `NotificationProvider` (the base
   of `EmailProvider`/`SmsProvider`) gains an optional `name?: string` for diagnostics/labeling; a
   provider that doesn't set one is labeled positionally (`"primary"` for index 0, `"fallback-1"`,
   `"fallback-2"`, … for the rest). On an attempt where every provider fails, `messages.error`
   already carries a concatenation of every tried provider's own error, each prefixed with its
   label (e.g. `[primary] resend send failed (503): …; [fallback-1] twilio send failed (500): …`
   for a same-channel mixed scenario, or the analogous same-vendor-type case) — this is sufficient
   failure diagnostics without a second schema field, so `providerName` is deliberately success-only.
6. **An "attempt" is unchanged: one pass over the (whole) provider list, exactly matching N2's
   existing semantics where `attempts` counts delivery attempts, not network calls.** A retry after
   a failed attempt always restarts from `provider[0]` (the top of the list) rather than resuming
   from wherever it left off — so a transient primary outage that resolves between attempts is
   naturally preferred again on the next attempt (providers are configured in a deliberate priority
   order; a mid-list resume would invert that intent for no benefit, since the very next call to
   `provider[0]` costs one more network round trip, not one more `attempts` decrement). `attempts`
   is NOT per-provider — it is still exactly what N2 already means by it (one count per delivery
   attempt of the row), so `config.retry.maxAttempts` continues to mean "this many passes over the
   (possibly multi-provider) send," unchanged in meaning and unchanged in the schema.
7. **Idempotency-Key is passed identically to every provider tried, same value, same format
   (`msg:<rowId>`).** It cannot dedupe ACROSS vendors (a Resend key means nothing to SES) — see the
   Security/correctness section for the honest boundary this creates — but it remains valuable
   WITHIN one provider across attempts (a provider tried again on a later attempt reuses the same
   key, so a provider that actually sent but whose ack was lost still dedupes on retry, exactly as
   N2 already relies on).
8. **Webhook route resolution becomes verify-to-identify, not config-to-identify — a non-breaking
   change to the existing route.** `POST /api/notifications/webhooks/:channel` is unchanged (still
   keyed by CHANNEL, `"email"`/`"sms"`, never by provider name — no existing webhook URL registered
   at a vendor dashboard needs to change when a fallback provider is added). The route handler now
   tries `verify()` against EVERY configured provider for that channel (primary, then each
   fallback, in order) that implements `.webhook`, and uses the FIRST one whose `verify()` returns
   true — that provider's own `.parse()` then normalizes the event. This works because HMAC
   verification is provider-secret-specific: an event genuinely from vendor A will not verify
   against vendor B's secret (astronomically unlikely collision), so trying multiple candidates in
   sequence is safe, not ambiguous. The existing single-provider-per-channel behavior is the
   `fallbacks: []` special case of this general loop (list length 1 — no behavior change).
9. **`webhookSecret` stays channel-level (backward-compat convenience for the primary provider); a
   provider needing its OWN distinct secret bakes it into its own constructor closure, following
   the precedent `twilioSms` already set.** No new `webhookSecret`-per-provider config field is
   added. Today's `twilioVerify` already ignores the passed `WebhookVerifyArgs.secret` entirely and
   closes over `opts.authToken` instead — proving the seam already supports "a provider owns its own
   verification material" without any config change. A second email fallback provider that ALSO
   needs Svix-style external-secret verification (e.g., two Resend-shaped adapters) is expected to
   accept its own secret at construction (e.g., `someOtherProvider({ apiKey, webhookSecret })`) and
   use it internally rather than relying on the channel's single `webhookSecret` field, which
   remains reserved for whichever provider is configured as `provider` (index 0) for back-compat.
   This is called out explicitly in the docs (see Docs section) so it isn't a silent footgun.
10. **Health/circuit-breaking is deferred, not built.** No per-provider rolling-failure counter, no
    "skip a provider that's failed N times recently." The ordered list is walked in full, in the
    same order, on every attempt, forever — matching Courier/Novu's default (health-based routing
    is an opt-in heavier feature in both reference products, not their default). See Non-goals.
11. **Cross-provider double send is an accepted, honestly-documented boundary — not solved.** If
    provider A actually delivers but the ack is lost on our end (treated as a failure), and the walk
    proceeds to provider B, which also sends, the recipient receives the message twice. This is
    structurally impossible to close (no shared idempotency namespace exists across vendors) and is
    a strictly WORSE case of the same "at-least-once" honesty N2 already documented for its own
    retry-of-the-same-provider path (where a native provider Idempotency-Key at least has a chance
    to dedupe). See Security/correctness.

## Config / schema changes (additive)

`components/notifications/src/config.ts`:
```ts
export interface EmailChannelConfig {
  provider: EmailProvider;
  from: string;
  templates?: EmailTemplates;
  webhookSecret?: string;
  /** Additional providers tried, in order, after `provider` fails, within the SAME delivery
   *  attempt (provider-level failover). Each is a complete EmailProvider (its own send + optional
   *  webhook). The effective ordered list is `[provider, ...fallbacks]`. */
  fallbacks?: EmailProvider[];
}
export interface SmsChannelConfig {
  provider: SmsProvider;
  from: string;
  templates?: SmsTemplates;
  fallbacks?: SmsProvider[];
}
```

`components/notifications/src/provider.ts` — `NotificationProvider`'s two concrete shapes gain an
optional label:
```ts
export interface EmailProvider {
  channel: "email";
  send(m: EmailMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
  /** Optional diagnostic label recorded as `messages.providerName` on a successful send via this
   *  provider. Defaults to a positional label ("primary" / "fallback-1" / "fallback-2" / …) when
   *  unset. */
  name?: string;
}
export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
  name?: string;
}
```

`components/notifications/src/schema.ts` — `messages` gains ONE optional field:
```ts
    providerName: v.optional(v.string()), // the provider that succeeded (fallback observability)
```
No new index (nothing queries by `providerName`; it is an observability field, read via the
existing per-row lookups/dashboard browse). No changes to `notifications`, `sendReceipts`,
`notificationPreferences`, `topicSubscriptions`, or `digestBuffer`.

## The deliver → failover data flow

`components/notifications/src/render.ts` is where the change concentrates — `deliverOutbound` was
a single `provider.send(...)` call; it becomes a walk over the channel's ordered provider list:

```ts
export interface DeliverOutcome extends SendResult {
  providerName: string; // the provider that ultimately succeeded
}

function providerList(config: NotificationsConfig, channel: "email" | "sms"):
    Array<{ provider: EmailProvider | SmsProvider; label: string }> {
  const ch = channel === "email" ? config.channels.email : config.channels.sms;
  if (!ch) throw new Error(`${channel} channel not configured`);
  const all = [ch.provider, ...(ch.fallbacks ?? [])];
  return all.map((p, i) => ({ provider: p, label: p.name ?? (i === 0 ? "primary" : `fallback-${i}`) }));
}

export async function deliverOutbound(config: NotificationsConfig, e: DeliverEntry): Promise<DeliverOutcome> {
  const list = providerList(config, e.channel);
  const failures: string[] = [];
  let anyRetryable = false;
  for (const { provider, label } of list) {
    try {
      const res = await sendVia(provider, e); // the existing per-channel compact(...)+provider.send(...) call
      return { ...res, providerName: label };
    } catch (err) {
      const retryable = err instanceof NotificationSendError ? err.retryable : true;
      anyRetryable ||= retryable;
      failures.push(`[${label}] ${String(err)}`);
    }
  }
  throw new NotificationSendError(failures.join("; "), { retryable: anyRetryable });
}
```

`driver.ts`'s `runPass` and `facade.ts`'s `sendNow` — the TWO existing call sites — are otherwise
**unchanged in shape**: both already do
```ts
try {
  const res = await deliverOutbound(config, {...});
  ok = true; providerMessageId = res.providerMessageId;
} catch (e) {
  error = String(e);
  retryable = e instanceof NotificationSendError ? e.retryable : true;
}
```
This block does not need to know a fallback walk happened underneath it — `NotificationSendError`'s
`retryable` already carries decision 4's verdict, computed inside `deliverOutbound`. The ONE new
line at each call site is threading `res.providerName` into the `_markResult`/`sendNow` args
(`compact({ ..., providerName })`), and `modules.ts`'s `_markResult` gains one line writing it on
the success branch only (mirroring exactly how `providerMessageId` is already written there). No
change to `_peekQueued`, `_claimForSend`, `_reclaimStuck`, the backoff math, or the driver's
timer/wake logic — the entire N2 retry/reclaim machinery is invariant under this change, which is
the point of decision 6 (an "attempt" stays one unit).

`webhook.ts`'s `resolveWebhookProvider` becomes `resolveWebhookProviders` (plural), returning the
full ordered `{provider, secret}` candidate list for the channel (primary gets
`config.channels.<ch>.webhookSecret` as its `secret`; every fallback gets `secret: undefined`,
consistent with decision 9 — a fallback is expected to self-contain its own verification material).
`webhookHttp` loops the candidates, calling `.verify()` on each (skipping any without `.webhook`),
and uses the first one that returns true; `.parse()` runs against that same provider. No candidates
verify → 401, unchanged from today's single-provider 401 path.

## Security / correctness

- **The cross-provider double-send boundary (decision 11), stated plainly for docs:** multi-provider
  fallback trades a SMALL increase in duplicate-delivery risk for a LARGE decrease in outage-caused
  non-delivery risk. A duplicate requires the specific sequence "provider A's send actually
  succeeded at the vendor, but our process never observed that success" (network drop / process
  crash between the vendor accepting the request and our code reading the response) FOLLOWED BY
  provider B being tried and also succeeding. This is the same class of risk N2 already accepted for
  provider-Idempotency-Key-unsupported providers (Twilio) retried against THEMSELVES; a fallback to
  a DIFFERENT vendor is strictly less defensible because there is no shared idempotency namespace to
  even attempt dedup across. Not solved; not solvable without a cross-vendor message-id registry no
  real provider offers. Documented, not silently accepted.
- **Signature verification is still mandatory and still precedes any write**, for EVERY candidate
  tried in the webhook loop — a candidate that doesn't verify is simply skipped, never partially
  trusted. The loop terminates on the first success; it never "merges" a body across candidates.
- **No secret leakage**: exactly as N2 established — a provider's own secret lives in its closure,
  never in a row, an error string, or the concatenated multi-provider failure message (each
  provider's own thrown message is under that provider's own control not to leak; this is unchanged
  from before this slice, since `sendVia` still calls the SAME `provider.send` used pre-fallback).
- **`config.retry.maxAttempts` is not silently multiplied.** Because an "attempt" still means one
  pass over the (possibly multi-provider) list, adding fallbacks does not change how many total
  network calls a permanently-broken row can accumulate before N2 dead-letters it in a way that
  breaks the existing bound — worst case is `maxAttempts × providers.length` network calls (small,
  bounded, same order of magnitude as today's `maxAttempts` calls to one provider).
- **A provider-list entry is exactly as trusted as today's single `provider`** — this slice adds no
  new trust boundary; a fallback provider is server-side config, never client-influenced, identical
  to how the primary provider always was.

## Testing

- **Unit (`deliverOutbound`, `render.test.ts`):** a 3-provider list `[retryable-fail,
  non-retryable-fail, ok]` succeeds via the 3rd and returns `providerName` for it (proves the walk
  does not stop on a non-retryable middle failure — decision 3). All-fail with a `[5xx, 4xx]` mix
  throws `retryable: true` (decision 4); all-fail `[4xx, 4xx]` throws `retryable: false`. A
  single-provider list (no `fallbacks` configured) is BYTE-IDENTICAL to pre-feature `deliverOutbound`
  behavior — an explicit regression test, since this is the by-far most common configuration and
  must not visibly change.
- **Component-level (`@stackbase/test`/inline runtime, `fallback-driver.test.ts`):** an email
  channel configured with `provider` = always-fails (retryable) + one `fallbacks` entry that
  succeeds → the row lands `sent` on the FIRST attempt (`attempts` stays 0/absent — no N2 retry ever
  triggered), `providerName` = `"fallback-1"`, and a call-order assertion proves the primary was
  tried before the fallback (a capture provider records call sequence). A second test: both
  providers always fail non-retryably → the row dead-letters on attempt 1 (no N2 retry loop entered,
  matching decision 4's `[4xx,4xx]` case). A third: primary 5xx + fallback 4xx → the row RETRIES
  (N2 backoff) rather than dead-lettering (decision 4's mixed case) — and on the retried attempt,
  the walk restarts from the primary (decision 6), provable if the primary is scripted to succeed on
  its 2nd call.
- **Webhook multi-provider (`fallback-webhook.test.ts`):** two email providers, each with its own
  `webhook` and a DIFFERENT secret, both configured on one channel (`provider` + one `fallbacks`
  entry) — a request signed with the FALLBACK's secret still verifies (the loop reaches it) and
  parses via the fallback's own `.parse`; a request signed with neither secret still 401s.
- **E2E through the real dev server** (`packages/cli/test/notifications-fallback-e2e.test.ts`): a
  capture-email `provider` that ALWAYS throws a retryable `NotificationSendError`, plus a `fallbacks`
  entry that succeeds — `ctx.notifications.send(...)` from an app mutation, and a LIVE status
  subscription on the row observes it land `sent` on the very first driver pass (never transiting
  through a visible `queued`-with-backoff state), with `providerMessageId`/`providerName` from the
  fallback — proving end-to-end that a configured fallback masks what would, pre-feature, have been
  an N2 retry-with-backoff delay. A second E2E case: remove the fallback (single-provider, same
  failing primary) against the SAME test file, confirming the row DOES take the N2 backoff/retry
  path — the contrast is the headline proof that fallback specifically buys latency, not just
  eventual delivery (N2 already guaranteed eventual delivery for a transient failure).

## Docs

Extend `docs/enduser/build/notifications.md`'s existing "Selecting one active provider per channel
is the N1 model (multi-provider fallback is N3)" line (now stale/inaccurate — N3 didn't build it,
this slice does) — replace with a new **"Provider fallback"** section: the `fallbacks` config shape,
the ordered-list-tried-in-full policy (decision 3, with the informal "why not stop on 4xx"
rationale), the `providerName` field, the webhook multi-secret caveat (decision 9 — bake your own
secret into a fallback provider's constructor), and an explicit **clarifying callout** that this is
SAME-CHANNEL provider fallback (Resend→SES), distinct from the still-fully-deferred CROSS-channel
fallback (email→SMS) the "what's deferred" table's example wording had conflated. Update the
"What's deferred" list: move "multi-provider fallback" from deferred to shipped; leave time-based
multi-channel routing and cross-channel fallback as still-deferred, now described unambiguously.

## Non-goals (deferred)

- **Cross-CHANNEL fallback** (retry a failed email over SMS) — a distinct, still-fully-deferred
  feature (different address resolution, different template, different consent/category semantics);
  not touched by this slice.
- **Health-based / weighted / round-robin routing** — the list is walked in the SAME fixed order
  every attempt, forever; no rolling failure counter, no automatic demotion of a chronically-failing
  provider, no traffic splitting. Matches Courier/Novu's own default (their health/weighted modes are
  opt-in extras, not the baseline).
- **Per-provider circuit breaking** ("skip a provider after N consecutive failures") — related to the
  above; genuinely useful at scale, deferred as a follow-up once real failure telemetry exists to
  justify the added state (would need its own small durable counter/table, non-trivial for a v1).
- **An early-exit-on-non-retryable config knob** — decision 3 always walks the full list; a future
  per-channel or per-provider opt-out ("don't try provider B if provider A said this is a permanent
  4xx") is plausible but not built, since no evidence yet shows the default full-walk is wrong for
  real provider pairs.
- **Per-provider `from` address override** — every provider in a channel's list shares the one
  channel-level `from`; a provider needing a distinct verified sending domain must be wired as its
  own separate channel/component composition, not as a `fallbacks` entry, in v1.
- **Per-provider distinct `webhookSecret` config field** — a fallback provider bakes its own secret
  into its own factory, following `twilioSms`'s existing precedent; no new config surface is added
  for this.
- **Per-provider timeout configuration** (Courier's 5 min/provider, 30 min/channel, 72 h/message
  hierarchy) — each provider's own `fetch` call has no added timeout wrapper in v1; a hung `fetch`
  behaves exactly as it does for a single-provider config today (unbounded, inherited platform
  behavior), for every provider in the list.
- **Fleet / multi-node considerations** — inherits N2's single-node reclaim-lease boundary
  unchanged; this slice adds no new durable state beyond one optional success-only field.

## Reference implementations consulted

Courier's [Automated Failover](https://www.courier.com/docs/platform/sending/failover) (provider-
level vs. channel-level failover, `408`/`429`/`5xx` trigger conditions, the timeout hierarchy this
design deliberately diverges from and explains why), Novu's dashboard-configured provider failover
(SendGrid→Resend/SES on 5xx), and this component's own N2 design
(`docs/superpowers/specs/2026-03-20-notifications-reliability-design.md` — the `retryable`
classification, `computeBackoff`, and the `_markResult` retry/dead-letter machinery this slice
plugs into unchanged) and N3 design (`docs/superpowers/specs/2026-03-20-notifications-preferences-
topics-design.md` — the original scope-decision paragraph naming this exact feature as deferred).
