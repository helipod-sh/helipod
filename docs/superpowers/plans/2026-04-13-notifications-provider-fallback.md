# Notifications — Multi-Provider Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A channel (`email`/`sms`) can configure `fallbacks: Provider[]` alongside its existing
`provider`. `deliverOutbound` walks the ordered list `[provider, ...fallbacks]` within ONE N2
delivery attempt, succeeding the moment any provider succeeds; only if every provider fails does
the attempt fail, re-entering N2's unchanged retry/backoff/dead-letter path. See the design spec:
`docs/superpowers/specs/2026-04-13-notifications-provider-fallback-design.md` for full rationale —
this plan implements its 11 locked decisions.

**Architecture:** Concentrates almost entirely in `render.ts`'s `deliverOutbound` (single-provider
call → provider-list walk). `driver.ts` and `facade.ts` (the two call sites) need only one new line
each (thread `providerName` into `_markResult`/mark-args) — their retry/backoff logic is untouched.
`webhook.ts`'s route resolution changes from "the one configured provider" to "loop verify() over
the ordered list, first match wins." One additive schema field (`messages.providerName`).

**Tech Stack:** TypeScript; existing `@stackbase/notifications` seams only — no new dependency, no
new component. Tests: vitest (component-level + `packages/cli` E2E).

## Global Constraints

- **N2's retry/backoff/reclaim machinery is INVARIANT.** Do not touch `_peekQueued`,
  `_claimForSend`, `_reclaimStuck`, `computeBackoff`, or the driver's timer/wake logic. If a task
  step seems to require touching them, stop — the design intentionally keeps "an attempt" meaning
  exactly what it meant before this slice (design decision 6).
- **Full-list walk, never short-circuit on a non-retryable middle failure** (decision 3). The walk
  only stops on the FIRST success, or after every provider has been tried.
- **The overall attempt's `retryable` verdict is OR across all tried providers' classifications**
  (decision 4): `retryable: true` if ANY tried provider's failure was retryable; `false` only if
  ALL were non-retryable.
- **`compact()` at every codec boundary**, exactly as N2 established — a new optional
  `providerName` arg/field must be stripped when undefined before any `runFunction`/`runMutation`/
  `db.insert`/`db.replace` call.
- **Zero behavior change when no `fallbacks` are configured.** Every existing single-provider test
  (N1/N2/N3/N4) must keep passing unmodified — a provider list of length 1 must be byte-identical
  to today's single-`provider.send()` call, including the exact thrown error's message text where
  existing tests assert on it (`sendVia` reuses the existing per-channel `compact({...})` call
  verbatim; only the wrapping loop is new).
- **Webhook route path is unchanged** (`POST /api/notifications/webhooks/:channel`, keyed by
  channel, never by provider) — no existing vendor-dashboard-registered URL needs to change.
- Naming: a provider's diagnostic label defaults to `"primary"` (index 0) / `"fallback-1"` /
  `"fallback-2"` / … when it sets no `.name`.

---

## File Structure

- `components/notifications/src/provider.ts` — MODIFY (T1): add `name?: string` to `EmailProvider`
  and `SmsProvider`.
- `components/notifications/src/config.ts` — MODIFY (T1): add `fallbacks?: EmailProvider[]` to
  `EmailChannelConfig`, `fallbacks?: SmsProvider[]` to `SmsChannelConfig`.
- `components/notifications/src/schema.ts` — MODIFY (T1): add `providerName: v.optional(v.string())`
  to `messages`.
- `components/notifications/src/render.ts` — MODIFY (T2): `deliverOutbound` becomes provider-list-
  aware; new `DeliverOutcome` type; new internal `providerList`/`sendVia` helpers.
- `components/notifications/src/modules.ts` — MODIFY (T3): `_markResult` accepts+writes optional
  `providerName` on the success branch.
- `components/notifications/src/driver.ts` — MODIFY (T3): thread `res.providerName` into the
  `_markResult` call.
- `components/notifications/src/facade.ts` — MODIFY (T3): thread `res.providerName` into
  `sendNow`'s `_markResult` call.
- `components/notifications/src/webhook.ts` — MODIFY (T4): `resolveWebhookProvider` →
  `resolveWebhookProviders` (ordered candidate list); `webhookHttp` loops verify.
- `docs/enduser/build/notifications.md` — MODIFY (T5): new "Provider fallback" section + deferred-
  table update.
- Tests: `components/notifications/test/render-fallback.test.ts` (T2),
  `components/notifications/test/fallback-driver.test.ts` (T3),
  `components/notifications/test/fallback-webhook.test.ts` (T4),
  `packages/cli/test/notifications-fallback-e2e.test.ts` (T5).

**Parallelism:** T1 is the foundation (sequential, first — everything else imports its types). After
T1: T2 must land before T3 (T3 calls the new `deliverOutbound` shape). T4 depends only on T1 (touches
disjoint files from T2/T3) — parallelizable alongside T2/T3. T5 is sequential last (needs T2+T3+T4
composed together for the E2E).

---

## Task 1: Foundation — config, provider seam, schema

**Files:**
- Modify: `components/notifications/src/provider.ts`
- Modify: `components/notifications/src/config.ts`
- Modify: `components/notifications/src/schema.ts`

**Interfaces:**
- Produces: `EmailProvider.name?`, `SmsProvider.name?`; `EmailChannelConfig.fallbacks?:
  EmailProvider[]`, `SmsChannelConfig.fallbacks?: SmsProvider[]`; `messages.providerName?: string`.

- [ ] **Step 1: Add `name?` to the provider seam.** In `provider.ts`, edit `EmailProvider` and
  `SmsProvider`:

```ts
export interface EmailProvider {
  channel: "email";
  send(m: EmailMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
  /** Optional diagnostic label recorded as `messages.providerName` on a successful send via this
   *  provider. Defaults to a positional label ("primary" / "fallback-1" / "fallback-2" / …). */
  name?: string;
}

export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
  name?: string;
}
```

- [ ] **Step 2: Add `fallbacks?` to the channel configs.** In `config.ts`:

```ts
export interface EmailChannelConfig {
  provider: EmailProvider;
  from: string;
  templates?: EmailTemplates;
  webhookSecret?: string;
  /** Additional providers tried, in order, after `provider` fails, within the SAME delivery
   *  attempt (provider-level failover — see the fallback design doc). Effective ordered list is
   *  `[provider, ...fallbacks]`. */
  fallbacks?: EmailProvider[];
}
```
```ts
export interface SmsChannelConfig {
  provider: SmsProvider;
  from: string;
  templates?: SmsTemplates;
  fallbacks?: SmsProvider[];
}
```

(No change needed to `NotificationsOptions`/`NotificationsConfig`/`resolveNotificationsConfig` —
`channels` is passed through as-is already; `fallbacks` rides inside it with no new top-level
resolution step, since it needs no default value beyond "absent = no fallbacks".)

- [ ] **Step 3: Add the schema field.** In `schema.ts`, add to the `messages` table (after
  `deliveryDetail`/`complainedAt`, before the closing `})`):

```ts
    providerName: v.optional(v.string()), // the provider that succeeded a send (fallback observability)
```

- [ ] **Step 4: Typecheck.** Run: `cd components/notifications && bunx tsc --noEmit` — expect clean
  (all three edits are additive-optional; no existing call site is required to change).

- [ ] **Step 5: Full package regression.** Run: `bunx vitest run` — expect all existing tests still
  green (nothing behavioral changed yet).

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/provider.ts components/notifications/src/config.ts components/notifications/src/schema.ts
git commit -m "feat(notifications): fallback T1 — fallbacks config, provider name label, providerName schema field"
```

---

## Task 2: `deliverOutbound` provider-list walk

**Files:**
- Modify: `components/notifications/src/render.ts`
- Test: `components/notifications/test/render-fallback.test.ts`

**Interfaces:**
- Consumes (T1): `EmailChannelConfig.fallbacks`, `SmsChannelConfig.fallbacks`, `EmailProvider.name`/
  `SmsProvider.name`.
- Produces: `DeliverOutcome extends SendResult { providerName: string }`;
  `deliverOutbound(config, entry): Promise<DeliverOutcome>` (walks the full ordered list per
  decision 3; throws a combined `NotificationSendError` per decision 4 if every provider fails).

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/render-fallback.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveNotificationsConfig } from "../src/config";
import { deliverOutbound } from "../src/render";
import { NotificationSendError, type EmailProvider } from "../src/provider";

function scripted(behavior: "ok" | "retryable" | "permanent", label?: string): EmailProvider {
  return {
    channel: "email",
    name: label,
    async send() {
      if (behavior === "ok") return { providerMessageId: `id-${label ?? "x"}` };
      if (behavior === "permanent") throw new NotificationSendError("bad recipient", { retryable: false });
      throw new Error("transient 503");
    },
  };
}

function configWith(provider: EmailProvider, fallbacks: EmailProvider[]) {
  return resolveNotificationsConfig({ channels: { email: { provider, from: "no-reply@test", fallbacks } } });
}

describe("deliverOutbound — provider-list fallback", () => {
  it("succeeds via a later provider after an earlier retryable failure", async () => {
    const config = configWith(scripted("retryable", "primary"), [scripted("ok", "fallback-1")]);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res).toMatchObject({ providerMessageId: "id-fallback-1", providerName: "fallback-1" });
  });

  it("does NOT stop on a middle non-retryable failure — keeps walking to the next provider", async () => {
    const config = configWith(scripted("permanent", "primary"), [scripted("ok", "fallback-1")]);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res.providerName).toBe("fallback-1");
  });

  it("all-fail [5xx, 4xx] → overall retryable:true", async () => {
    const config = configWith(scripted("retryable", "primary"), [scripted("permanent", "fallback-1")]);
    await expect(deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toMatchObject({ retryable: true });
  });

  it("all-fail [4xx, 4xx] → overall retryable:false", async () => {
    const config = configWith(scripted("permanent", "primary"), [scripted("permanent", "fallback-1")]);
    await expect(deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toMatchObject({ retryable: false });
  });

  it("a single-provider list (no fallbacks) is unchanged: success labeled 'primary', failure throws as before", async () => {
    const config = configWith(scripted("ok", "primary"), []);
    const res = await deliverOutbound(config, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } });
    expect(res).toMatchObject({ providerName: "primary" });

    const configFail = configWith(scripted("permanent"), []); // no .name set → defaults to "primary"
    await expect(deliverOutbound(configFail, { channel: "email", to: "u@test", payload: { subject: "s", text: "t" } }))
      .rejects.toThrow(/bad recipient/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (today's `deliverOutbound` ignores `fallbacks` entirely, so
  every "succeeds via a later provider" test fails; `providerName` is not on the return). Run:
  `cd components/notifications && bunx vitest run test/render-fallback.test.ts`.

- [ ] **Step 3: Implement.** In `render.ts`, replace the current `DeliverEntry`/`deliverOutbound`
  block. Import `EmailProvider`/`SmsProvider`/`NotificationSendError` from `./provider` (add to the
  existing import line). Add:

```ts
export interface DeliverOutcome extends SendResult {
  /** The provider that ultimately succeeded (or, if throwing, unused — see the thrown error's
   *  combined message instead). */
  providerName: string;
}

/** The channel's ordered provider list — `[provider, ...fallbacks]` — each paired with its
 *  diagnostic label (its own `.name`, else a positional default). Throws if the channel isn't
 *  configured at all (same guard `deliverOutbound` always had). */
function providerList(config: NotificationsConfig, channel: "email" | "sms"): Array<{ provider: EmailProvider | SmsProvider; label: string }> {
  const ch = channel === "email" ? config.channels.email : config.channels.sms;
  if (!ch) throw new Error(`${channel} channel not configured`);
  const all: Array<EmailProvider | SmsProvider> = [ch.provider, ...((ch as { fallbacks?: Array<EmailProvider | SmsProvider> }).fallbacks ?? [])];
  return all.map((p, i) => ({ provider: p, label: p.name ?? (i === 0 ? "primary" : `fallback-${i}`) }));
}

/** One provider's `send` call, exactly the per-channel dispatch `deliverOutbound` always did
 *  (unchanged from pre-fallback: same `compact({...})` shape, same field mapping). */
async function sendVia(provider: EmailProvider | SmsProvider, e: DeliverEntry): Promise<SendResult> {
  if (e.channel === "email") {
    const c = e.payload as EmailContent;
    return (provider as EmailProvider).send(
      compact({ to: e.to, from: (e as unknown as { from?: string }).from ?? "", subject: c.subject, text: c.text, html: c.html, idempotencyKey: e.idempotencyKey }),
    );
  }
  const p = e.payload as SmsPayload;
  return (provider as SmsProvider).send(
    compact({ to: e.to, from: (e as unknown as { from?: string }).from ?? "", body: p.body, kind: p.kind, idempotencyKey: e.idempotencyKey }),
  );
}

/** Resolve the channel's ordered provider list and try each in turn until one succeeds (provider-
 *  level failover — see the fallback design doc, decisions 3/4). Network I/O — called ONLY from the
 *  driver's action context or the action-mode `sendNow`, never a mutation. On a delivery attempt
 *  where EVERY provider fails, throws a combined `NotificationSendError` whose `retryable` is the
 *  OR across every tried provider's own classification (decision 4) — so N2's existing
 *  `_markResult` retry/dead-letter logic needs no change to understand a fallback-aware failure. */
export async function deliverOutbound(config: NotificationsConfig, e: DeliverEntry): Promise<DeliverOutcome> {
  const list = providerList(config, e.channel);
  const failures: string[] = [];
  let anyRetryable = false;
  for (const { provider, label } of list) {
    try {
      const res = await sendVia(provider, e);
      return { ...res, providerName: label };
    } catch (err) {
      const retryable = err instanceof NotificationSendError ? err.retryable : true;
      anyRetryable = anyRetryable || retryable;
      failures.push(`[${label}] ${String(err)}`);
    }
  }
  throw new NotificationSendError(failures.join("; "), { retryable: anyRetryable });
}
```

> **Careful reconciliation note for the implementer:** re-read the CURRENT `deliverOutbound` in
> `render.ts` before editing — it builds the `compact({...})` call INLINE per channel using `e.to`/
> `ch.from`/payload fields (there is no `from` on `DeliverEntry` today; `from` comes from
> `ch.from`, the channel config, not the entry). Preserve that exactly: `sendVia` above is
> illustrative — the real implementation must pull `from` from `config.channels.email.from` /
> `config.channels.sms.from` (resolved once in `deliverOutbound`, passed to `sendVia`, or looked up
> inside `sendVia` from `config` directly) — NOT invent a `from` field on `DeliverEntry`. Adjust the
> snippet accordingly so the actual field mapping is byte-identical to today's, just wrapped in the
> loop. This is exactly the "single-provider list is byte-identical" constraint in Global
> Constraints — verify it by diffing today's `compact({...})` call against the new `sendVia` body
> field-by-field before considering this step done.

- [ ] **Step 4: Run it — expect PASS** (5/5). Run: `bunx vitest run test/render-fallback.test.ts`.

- [ ] **Step 5: Full package regression.** Run: `bunx vitest run` — every N1–N4 test must still pass
  unmodified (single-provider configs are the `fallbacks: []`/unset case). Run `bunx tsc --noEmit`
  clean. Pay special attention to any existing test asserting on `deliverOutbound`'s return shape or
  a thrown message's exact text (e.g. driver/reliability tests) — `providerName` is a NEW field on
  an object those tests may `toMatchObject` against (safe, `toMatchObject` ignores extra fields) but
  a `toEqual` would NOT be (search for any `toEqual` on a `deliverOutbound`/`sendNow` result and fix
  if found).

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/render.ts components/notifications/test/render-fallback.test.ts
git commit -m "feat(notifications): fallback T2 — deliverOutbound walks the ordered provider list"
```

---

## Task 3: Thread `providerName` through the two call sites [after T2]

**Files:**
- Modify: `components/notifications/src/modules.ts`
- Modify: `components/notifications/src/driver.ts`
- Modify: `components/notifications/src/facade.ts`
- Test: `components/notifications/test/fallback-driver.test.ts`

**Interfaces:**
- Consumes (T2): `DeliverOutcome.providerName`.
- Produces: `_markResult` accepts optional `providerName` and writes it ONLY on the success branch;
  `driver.ts`'s `runPass` and `facade.ts`'s `sendNow` both pass it through.

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/fallback-driver.test.ts`
  (mirrors `retry-reclaim.test.ts`'s harness shape — reuse `makeNotifRuntime`/`scriptedEmail`-style
  helpers; a fresh scripted-provider helper that can be configured with a `fallbacks` list):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { NotificationSendError, type EmailProvider } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function failing(label: string, retryable = true): EmailProvider {
  return { channel: "email", name: label, async send() { throw new NotificationSendError(`${label} down`, { retryable }); } };
}
function okOn(label: string, id: string): EmailProvider {
  return { channel: "email", name: label, async send() { return { providerMessageId: id }; } };
}

function comp(provider: EmailProvider, fallbacks: EmailProvider[], maxAttempts = 4): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider, from: "no-reply@test", fallbacks, templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000,
    retry: { maxAttempts, initialBackoffMs: 0, base: 2 },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema, modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true, driver: notificationsDriver(config),
  });
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};
async function tick(b: BuiltNotifRuntime) { await (b.driver as { __tick: () => Promise<void> }).__tick(); }

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications — fallback in the driver", () => {
  it("delivers via the fallback on the FIRST attempt (no N2 retry ever triggers)", async () => {
    built = await makeNotifRuntime(comp(failing("primary"), [okOn("fallback-1", "id-fb1")]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    const row = (await built.readTable("notifications/messages"))[0]!;
    expect(row).toMatchObject({ status: "sent", providerMessageId: "id-fb1", providerName: "fallback-1" });
    expect(row.attempts ?? 0).toBe(0); // never entered N2's retry loop
  });

  it("dead-letters immediately when every provider is non-retryable", async () => {
    built = await makeNotifRuntime(comp(failing("primary", false), [failing("fallback-1", false)]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("retries via N2 backoff when primary is 5xx and fallback is 4xx, then restarts from primary next attempt", async () => {
    let primaryCalls = 0;
    const primary: EmailProvider = {
      channel: "email", name: "primary",
      async send() { primaryCalls++; if (primaryCalls === 1) throw new NotificationSendError("down", { retryable: true }); return { providerMessageId: "id-primary-2" }; },
    };
    built = await makeNotifRuntime(comp(primary, [failing("fallback-1", false)]), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); // attempt 1: primary 5xx, fallback 4xx → overall retryable → queued, attempts=1
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await tick(built); // attempt 2: restarts from primary → ok
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent", providerName: "primary" });
    expect(primaryCalls).toBe(2);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`providerName` isn't written on the row; `_markResult` drops
  it, `driver.ts`/`facade.ts` don't pass it). Run: `bunx vitest run test/fallback-driver.test.ts`.

- [ ] **Step 3: Update `modules.ts`.** `_markResult`'s signature gains `providerName?: string`,
  written ONLY on the success branch (mirrors exactly how `providerMessageId` is handled there —
  find the `args.ok` success-branch `db.replace(... compact({...}))` call and add `providerName:
  args.providerName` alongside the existing `providerMessageId: args.providerMessageId`):

```ts
  const _markResult = mutation(async (ctx: MutationCtx, args: { messageId: string; ok: boolean; providerMessageId?: string; providerName?: string; error?: string; retryable?: boolean }): Promise<null> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "sending") return null;
    const now = ctx.now();
    if (args.ok) {
      await ctx.db.replace(args.messageId, compact({ ...row, status: "sent", sentAt: now, providerMessageId: args.providerMessageId, providerName: args.providerName, error: undefined, payload: undefined, claimedAt: undefined, nextAttemptAt: undefined }));
      return null;
    }
    // ... failure branch UNCHANGED (do not add providerName here — decision 5: success-only) ...
  });
```

Do NOT touch the failure/retry/dead-letter branch — `providerName` is deliberately never written
there (decision 5); the concatenated `error` string from `deliverOutbound` already names every
provider tried.

- [ ] **Step 4: Update `driver.ts`.** In `runPass`'s per-message loop, the existing
  `try { const res = await deliverOutbound(...); ok = true; providerMessageId = res.providerMessageId; }`
  block gains one variable and one field on the `_markResult` call:

```ts
          let providerName: string | undefined;
          try {
            const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: `msg:${m._id}` });
            ok = true;
            providerMessageId = res.providerMessageId;
            providerName = res.providerName;
          } catch (e) {
            error = String(e);
            retryable = e instanceof NotificationSendError ? e.retryable : true;
          }
          await ctx.runFunction("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, providerName, error, retryable }) as unknown as JSONValue);
```

- [ ] **Step 5: Update `facade.ts`.** In `notificationsActionContext(...).sendNow`, the analogous
  block gains the same one variable + field:

```ts
        let providerMessageId: string | undefined;
        let providerName: string | undefined;
        let error: string | undefined;
        try {
          const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: `msg:${m._id}` });
          ok = true;
          providerMessageId = res.providerMessageId;
          providerName = res.providerName;
          results.push(res);
        } catch (e) {
          error = String(e);
        }
        await api.runMutation("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, providerName, error }) as unknown as Record<string, unknown>);
```

- [ ] **Step 6: Run it — expect PASS** (3/3). Run: `bunx vitest run test/fallback-driver.test.ts`.

- [ ] **Step 7: Full package regression.** Run: `bunx vitest run` (N1–N4 driver/reliability/digest/
  auth-unify tests unaffected — `providerName` is a new optional arg every existing call site
  either omits or passes `undefined`, `compact`-stripped identically to `providerMessageId` today).
  Run `bunx tsc --noEmit` clean.

- [ ] **Step 8: Commit.**
```bash
git add components/notifications/src/modules.ts components/notifications/src/driver.ts components/notifications/src/facade.ts components/notifications/test/fallback-driver.test.ts
git commit -m "feat(notifications): fallback T3 — thread providerName through driver + sendNow"
```

---

## Task 4: Webhook multi-provider verify loop [parallelizable alongside T2/T3, after T1]

**Files:**
- Modify: `components/notifications/src/webhook.ts`
- Test: `components/notifications/test/fallback-webhook.test.ts`

**Interfaces:**
- Consumes (T1): `EmailChannelConfig.fallbacks`/`SmsChannelConfig.fallbacks`.
- Produces: `resolveWebhookProviders(config, channel): Array<{ provider: NotificationProvider;
  secret?: string }>` (replaces the single-provider `resolveWebhookProvider`); `webhookHttp` tries
  `.verify()` over the list, first success wins.

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/fallback-webhook.test.ts`.
  Two fake email providers, each with its own `webhook.verify` keyed to a DIFFERENT expected secret
  string (simulate via a closure comparing `args.secret === "SECRET_A"` for provider A — but per
  decision 9, a fallback is expected to carry its OWN secret internally, not rely on the passed
  `args.secret`, so script the FALLBACK's verify to ignore `args.secret` and instead check a header
  value directly, exactly like `twilioSms` does):

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeWebhookModules } from "../src/webhook";
import type { EmailProvider, WebhookEvent } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function primaryProvider(events: WebhookEvent[]): EmailProvider {
  return {
    channel: "email",
    async send() { return {}; },
    webhook: { verify: (args) => args.secret === "PRIMARY_SECRET", parse: () => events },
  };
}
function fallbackProvider(events: WebhookEvent[]): EmailProvider {
  return {
    channel: "email", name: "fallback-1",
    async send() { return {}; },
    // Bakes its own secret in, ignoring the passed channel-level `secret` (decision 9's precedent).
    webhook: { verify: (args) => args.headers.get("x-fallback-secret") === "FALLBACK_SECRET", parse: () => events },
  };
}

function comp(fallback: EmailProvider) {
  const config = resolveNotificationsConfig({
    channels: { email: { provider: primaryProvider([]), from: "x@test", webhookSecret: "PRIMARY_SECRET", fallbacks: [fallback] } },
  });
  return defineComponent({ name: "notifications", schema: notificationsSchema, modules: { ...makeWebhookModules(config) }, contextWrite: true });
}

const systemSeed: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "_system:seedMsg": mutation(async (ctx: any, a: { providerMessageId: string }) =>
    (await ctx.db.insert("notifications/messages", { channel: "email", to: "u@test", status: "sent", providerMessageId: a.providerMessageId, createdAt: 0 }))),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications — fallback webhook verify loop", () => {
  it("verifies against the FALLBACK provider's own secret when the primary's doesn't match", async () => {
    built = await makeNotifRuntime(comp(fallbackProvider([{ providerMessageId: "re_1", deliveryStatus: "delivered" }])), { ...systemSeed });
    await built.runtime.runSystem("_system:seedMsg", { providerMessageId: "re_1" });
    const req = new Request("https://app.test/api/notifications/webhooks/email", {
      method: "POST", headers: { "x-fallback-secret": "FALLBACK_SECRET" }, body: "{}",
    });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(200);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
  });

  it("401s when NEITHER provider's verify matches", async () => {
    built = await makeNotifRuntime(comp(fallbackProvider([])), {});
    const req = new Request("https://app.test/api/notifications/webhooks/email", { method: "POST", headers: {}, body: "{}" });
    const res = await built.runtime.runHttpAction("notifications:webhookHttp", req);
    expect(res.status).toBe(401);
  });
});
```

> Confirm the exact runtime-invocation helper name (`runHttpAction` or whatever
> `test/webhook-apply.test.ts` — the N2 webhook test — actually uses) by reading that existing test
> file first; use the SAME helper/pattern here rather than inventing a new one.

- [ ] **Step 2: Run it — expect FAIL** (today's `resolveWebhookProvider` only ever looks at
  `config.channels.email.provider`, never `fallbacks`, so the fallback-secret request 401s). Run:
  `bunx vitest run test/fallback-webhook.test.ts`.

- [ ] **Step 3: Implement.** In `webhook.ts`, replace `resolveWebhookProvider` with a
  list-returning version and update `webhookHttp`'s body:

```ts
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
```

In `webhookHttp`, replace the single `resolveWebhookProvider` call + single `verify` call with a
loop over the candidates, first verified match wins:

```ts
  const webhookHttp = httpAction(async (ctx, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const channel = url.pathname.slice(WEBHOOK_PREFIX.length);
    const candidates = resolveWebhookProviders(config, channel).filter((c) => c.provider.webhook);
    if (candidates.length === 0) return new Response("unknown webhook channel", { status: 404 });
    const rawBody = await request.text();
    const publicUrl = publicUrlOf(request);
    let matched: NotificationProvider | undefined;
    for (const { provider, secret } of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await provider.webhook!.verify({ headers: request.headers, rawBody, url: publicUrl, secret });
      if (ok) { matched = provider; break; }
    }
    if (!matched) return new Response("invalid signature", { status: 401 });
    let events;
    try { events = matched.webhook!.parse(rawBody); } catch { return new Response("bad payload", { status: 400 }); }
    for (const e of events) {
      await (ctx as ActionCtx).runMutation<null>("notifications:_applyWebhookEvent", compact({ providerMessageId: e.providerMessageId, deliveryStatus: e.deliveryStatus, detail: e.detail }));
    }
    return new Response("ok", { status: 200 });
  });
```

Add `NotificationProvider` to the existing `./provider` type import at the top of the file.

- [ ] **Step 4: Run it — expect PASS** (2/2). Run: `bunx vitest run test/fallback-webhook.test.ts`.

- [ ] **Step 5: Full package regression + N2 webhook regression.** Run: `bunx vitest run` — the
  existing N2 `test/webhook-apply.test.ts` (single-provider, no `fallbacks`) must still pass
  unmodified (its candidate list is now length 1, same as before). Run `bunx tsc --noEmit` clean.

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/webhook.ts components/notifications/test/fallback-webhook.test.ts
git commit -m "feat(notifications): fallback T4 — webhook route tries every configured provider's verify"
```

---

## Task 5: E2E + docs [after T2, T3, T4]

**Files:**
- Create: `packages/cli/test/notifications-fallback-e2e.test.ts`
- Modify: `docs/enduser/build/notifications.md`

**Interfaces:** none new — this composes T1–T4 through the real `stackbase dev` server, the same
proof style every prior notifications slice used.

- [ ] **Step 1: Write the E2E test.** Model it directly on
  `packages/cli/test/notifications-reliability-e2e.test.ts`'s harness (real dev server, a capture
  email provider composed via `defineNotifications`). Two cases in one file:
  1. **Fallback masks a transient outage — zero visible retry.** Compose notifications with
     `provider` = a capture provider that ALWAYS throws `NotificationSendError({retryable:true})`,
     plus `fallbacks: [captureProviderThatSucceeds]`. Call `ctx.notifications.send(...)` from an app
     mutation. Open a LIVE subscription on the row (or poll the admin browse endpoint reactively, per
     however the reliability E2E observes status) BEFORE the send. Assert the row reaches `status:
     "sent"`, `providerName: "fallback-1"` on the driver's very FIRST pass — `attempts` stays
     0/absent (never visibly `queued` with a backoff `nextAttemptAt` in between).
  2. **Without a fallback, the SAME failing primary takes the N2 backoff path** (contrast case,
     same file, second `defineNotifications` composition with no `fallbacks`): the row transits
     `queued` (with `attempts` incrementing) before eventually landing `sent` (or `failed` at
     `maxAttempts`, if the always-failing behavior doesn't clear) — reuse a scripted provider that
     fails twice then succeeds, matching the existing reliability E2E's shape, to prove eventual
     delivery still works exactly as before. This pairing (with vs. without fallback, same fault) is
     the headline: fallback buys LATENCY, not just eventual delivery (N2 already had that).

- [ ] **Step 2: Run it — expect PASS.** Run: `cd packages/cli && bunx vitest run test/notifications-fallback-e2e.test.ts`.

- [ ] **Step 3: Update the docs.** In `docs/enduser/build/notifications.md`:
  - Replace the stale "Selecting one active provider per channel is the N1 model (multi-provider
    fallback is N3)" line — N3 didn't build it; this slice does. Point it at the new section instead.
  - Add a **"Provider fallback"** section: `fallbacks: [secondaryProvider]` config example: the
    full-list-walk policy in plain language (why a 4xx from one provider still tries the next); the
    `providerName` field and where to see it (dashboard row browse); the multi-webhook-secret
    caveat (bake a fallback's own secret into its own factory args, `twilioSms`-style); an explicit
    callout distinguishing this (same-channel, e.g. Resend→SES) from the STILL-deferred cross-
    channel fallback (email→SMS), since the current doc's deferred-table wording conflates the two.
  - Update "What's deferred": move "multi-provider fallback" from deferred to shipped; leave cross-
    channel fallback and time-based routing listed, now worded unambiguously as distinct from what
    just shipped.

- [ ] **Step 4: Final full-repo check.** Run: `bun run build && bun run typecheck` (or the
  package-scoped equivalents if a full monorepo build is slow) plus `bun run test` for
  `@stackbase/notifications` and `packages/cli` — everything green.

- [ ] **Step 5: Commit.**
```bash
git add packages/cli/test/notifications-fallback-e2e.test.ts docs/enduser/build/notifications.md
git commit -m "feat(notifications): fallback T5 — E2E through the real dev server + docs"
```
