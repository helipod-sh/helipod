# Notifications N2 — Delivery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add retries+backoff and stuck-`"sending"` reclaim to the queued-send path, inbound delivery webhooks (Resend/Twilio) with signature verification, and two-axis provider-status normalization to `@stackbase/notifications`, on the merged N1 substrate.

**Architecture:** Extends the N1 driver in place (retries are `messages`-row state + the existing sweep, not a scheduler dependency — the scheduler's `computeBackoff` is copied in). Webhooks mount on the engine's `ComponentDefinition.httpRoutes` seam (as auth's OAuth callback does) at `POST /api/notifications/webhooks/:channel`; the provider seam gains an optional `webhook` sub-interface (verify + parse) so signature schemes live in the adapter. A second status axis (`deliveryStatus`) is written monotonically by an internal mutation the webhook route calls.

**Tech Stack:** TypeScript; `@stackbase/component` (`httpRoutes`, `DriverContext`), `@stackbase/executor` (`mutation`/`query`/`httpAction`/`ctx.now`/`ctx.random`), `@stackbase/values` (`v`, schema); `node:crypto`/WebCrypto for HMAC (no new dependency). Tests: vitest.

## Global Constraints

- **Self-contained — no new component dependency.** Copy `computeBackoff` into `components/notifications/src/backoff.ts` (do NOT import from `@stackbase/scheduler`). Same self-containment choice N1 made for `compact`.
- **Additive schema only.** Every new `messages` field is `v.optional(...)`; add one index. No changed/removed field, no new required field (the additive-deploy gate).
- **`compact()` at EVERY codec boundary — args AND returns.** The JSON codec rejects an `undefined`-valued key on `runFunction`/`runMutation` args and on wire/`db.insert`/`db.replace` returns. Strip undefined keys with `compact` (from `./render`) before any such call. (N1 hit this three times.)
- **No wall-clock/`Math.random` in a UDF.** All time via `ctx.now()` (mutation) or a `now` arg passed from the driver (query); backoff jitter via `ctx.random` (the seeded PRNG), never `Math.random`.
- **Signature verification precedes any state change.** A webhook with a missing/invalid signature is rejected (401) before a row is read or written. Constant-time compare; reject stale timestamps.
- **`deliveryStatus` is monotonic** by lifecycle rank — a lower-or-equal-rank event (redelivered / out-of-order) is a no-op.
- **Single-node reclaim.** The reclaim lease is wall-clock, one writer; fleet multi-driver is out of scope (call it out, do not build).
- **`in_app` has no retry/webhook path** — it's written `sent` synchronously and never enters the queue. Reliability applies to `email`/`sms` only.
- Naming: the normalized enum is `DeliveryStatus = "delivered"|"bounced"|"complained"|"opened"|"clicked"|"dropped"|"failed_permanent"`. The send-lifecycle enum (`messages.status`) is unchanged: `"queued"|"sending"|"sent"|"failed"`.

---

## File Structure

- `components/notifications/src/schema.ts` — MODIFY: add `attempts`/`nextAttemptAt`/`claimedAt`/`deliveryStatus`/`deliveryDetail` to `messages`; add `byProviderMessageId` index.
- `components/notifications/src/config.ts` — MODIFY: `RetryOptions`, `retry`/`reclaimLeaseMs` on options+config+resolve; `webhookSecret?` on `EmailChannelConfig`.
- `components/notifications/src/backoff.ts` — CREATE: copied `computeBackoff` (pure).
- `components/notifications/src/provider.ts` — MODIFY: add `NotificationSendError`, `DeliveryStatus`, `WebhookEvent`, `WebhookVerifyArgs`, `ProviderWebhook`; add optional `webhook?` to `EmailProvider`/`SmsProvider`.
- `components/notifications/src/modules.ts` — MODIFY (T2): `_peekQueued` (backoff-aware, returns `{ready, earliestDeferredAt}`, takes `{now}`), `_claimForSend` (stamps `claimedAt`), `_markResult` (retry/dead-letter, takes `retryable`), add `_reclaimStuck`.
- `components/notifications/src/driver.ts` — MODIFY (T2): reclaim pass + backoff-aware peek + earliest-deferred timer.
- `components/notifications/src/provider-resend.ts` — MODIFY (T3a): add `webhook` (Svix) + `NotificationSendError` classification on `send`.
- `components/notifications/src/provider-twilio.ts` — MODIFY (T3b): add `webhook` (`X-Twilio-Signature`) + `NotificationSendError` classification on `send`.
- `components/notifications/src/webhook.ts` — CREATE (T4): `makeWebhookModules(config)` → `{ webhookHttp (httpAction), _applyWebhookEvent (mutation) }`.
- `components/notifications/src/index.ts` — MODIFY (T4): spread `makeWebhookModules`, wire `httpRoutes` when any provider has a `webhook`, export new types.
- Tests: `test/backoff.test.ts` (T1), `test/retry-reclaim.test.ts` (T2), `test/provider-resend-webhook.test.ts` (T3a), `test/provider-twilio-webhook.test.ts` (T3b), `test/webhook-apply.test.ts` (T4), `packages/cli/test/notifications-reliability-e2e.test.ts` (T5).
- `docs/enduser/build/notifications.md` — MODIFY (T5): Delivery-reliability section.

**Parallelism:** T1 is the foundation (sequential, first). After T1, **T2 / T3a / T3b / T4 touch disjoint files and depend only on T1** → parallelizable. T5 is sequential last. (NOTE for the executor: agent worktree-isolation is broken in this session — if you cannot isolate, build T2/T3a/T3b/T4 sequentially in the one worktree; the file-disjointness still holds so ordering is free.)

---

## Task 1: Foundation — schema, config, backoff, seam types

**Files:**
- Modify: `components/notifications/src/schema.ts`
- Modify: `components/notifications/src/config.ts`
- Create: `components/notifications/src/backoff.ts`
- Modify: `components/notifications/src/provider.ts`
- Test: `components/notifications/test/backoff.test.ts`

**Interfaces:**
- Produces: `RetryOptions { maxAttempts; initialBackoffMs; base }`, `NotificationsConfig.retry: RetryOptions`, `NotificationsConfig.reclaimLeaseMs: number`; `EmailChannelConfig.webhookSecret?: string`; `computeBackoff(attempts, rng, o): number`; `NotificationSendError`; `DeliveryStatus`, `WebhookEvent`, `WebhookVerifyArgs`, `ProviderWebhook`; `EmailProvider.webhook?`/`SmsProvider.webhook?`.

- [ ] **Step 1: Extend the schema.** In `schema.ts`, add the five optional fields to `messages` and the index. Replace the `messages` table definition body's field list end (after `payload: v.optional(v.any()),`) and the index chain:

```ts
    payload: v.optional(v.any()), // transient — cleared by `_markResult` on sent/failed (see doc above)
    // N2 delivery reliability (all additive/optional):
    attempts: v.optional(v.number()),        // retryable-failure count (absent = 0)
    nextAttemptAt: v.optional(v.number()),   // earliest sweep time for a backed-off `queued` row (absent = now)
    claimedAt: v.optional(v.number()),       // set on queued→sending; drives stuck-row reclaim
    deliveryStatus: v.optional(v.union(      // axis 2: provider-reported (webhooks), monotonic
      v.literal("delivered"), v.literal("bounced"), v.literal("complained"),
      v.literal("opened"), v.literal("clicked"), v.literal("dropped"), v.literal("failed_permanent"),
    )),
    deliveryDetail: v.optional(v.string()),  // optional provider detail (bounce reason, etc.)
  })
    // Driver sweep: scan `status:"queued"` cheaply (never `"sending"`/`"sent"`/`"failed"`).
    .index("byStatus", ["status"])
    // Dedup diagnostics / lookups by the caller's idempotency key.
    .index("byIdempotencyKey", ["idempotencyKey"])
    // Webhook correlation: resolve the target row from the provider's message id in one lookup.
    .index("byProviderMessageId", ["providerMessageId"]),
```

Also update the schema doc comment's N1 "PRIVACY NOTE" line to note reclaim now clears it: change `— the N2 reclaim reaper is also responsible for redacting/clearing it.` to `— N2's reclaim sweep re-queues or dead-letters it, clearing `payload` when it does.`

- [ ] **Step 2: Extend config.** In `config.ts`, add `webhookSecret` to `EmailChannelConfig`, and the retry/reclaim options+config+defaults. Add after the existing `EmailChannelConfig`:

```ts
export interface EmailChannelConfig {
  provider: EmailProvider;
  from: string;
  templates?: EmailTemplates;
  /** Signing secret for this provider's inbound delivery webhook (e.g. Resend `whsec_…`). */
  webhookSecret?: string;
}
```

And add the retry types + extend the options/config/resolver:

```ts
/** Retry policy for a failed email/SMS send (N2). `maxAttempts` counts total delivery attempts
 *  (the first send + retries) before dead-lettering to `failed`. */
export interface RetryOptions {
  maxAttempts: number;
  initialBackoffMs: number;
  base: number;
}
export const DEFAULT_RETRY: RetryOptions = { maxAttempts: 4, initialBackoffMs: 250, base: 2 };
export const DEFAULT_RECLAIM_LEASE_MS = 60_000;
```

Add to `NotificationsOptions`:
```ts
  retry?: Partial<RetryOptions>;
  /** A `"sending"` row older than this (ms) is reclaimed to `queued` (crash recovery). Default 60000. */
  reclaimLeaseMs?: number;
```
Add to `NotificationsConfig`:
```ts
  retry: RetryOptions;
  reclaimLeaseMs: number;
```
And in `resolveNotificationsConfig`, return them:
```ts
export function resolveNotificationsConfig(opts: NotificationsOptions): NotificationsConfig {
  return {
    channels: opts.channels,
    driverIntervalMs: opts.driverIntervalMs ?? DEFAULT_DRIVER_INTERVAL_MS,
    retry: {
      maxAttempts: opts.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      initialBackoffMs: opts.retry?.initialBackoffMs ?? DEFAULT_RETRY.initialBackoffMs,
      base: opts.retry?.base ?? DEFAULT_RETRY.base,
    },
    reclaimLeaseMs: opts.reclaimLeaseMs ?? DEFAULT_RECLAIM_LEASE_MS,
  };
}
```

- [ ] **Step 3: Write the backoff failing test.** Create `components/notifications/test/backoff.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeBackoff } from "../src/backoff";

describe("computeBackoff", () => {
  it("grows exponentially and applies 50–100% jitter", () => {
    const o = { initialBackoffMs: 250, base: 2 };
    // rng=0 → 50% of raw; rng=1 → 100% of raw. raw(attempts) = initialBackoffMs * base^(attempts+1).
    expect(computeBackoff(1, () => 0, o)).toBe(Math.round(250 * 2 ** 2 * 0.5)); // 500
    expect(computeBackoff(1, () => 1, o)).toBe(250 * 2 ** 2);                    // 1000
    expect(computeBackoff(2, () => 1, o)).toBe(250 * 2 ** 3);                    // 2000
  });
  it("is monotonic in attempts for a fixed rng", () => {
    const o = { initialBackoffMs: 250, base: 2 };
    expect(computeBackoff(3, () => 0.5, o)).toBeGreaterThan(computeBackoff(2, () => 0.5, o));
  });
});
```

- [ ] **Step 4: Run it — expect FAIL** (`../src/backoff` missing). Run: `cd components/notifications && bunx vitest run test/backoff.test.ts` → FAIL.

- [ ] **Step 5: Create `backoff.ts`** (copied from the scheduler, self-contained):

```ts
/**
 * Exponential backoff (with jitter) for a failed email/SMS send's Nth retry. Pure — takes its
 * randomness as an injected `rng` so it's deterministic-for-replay when called with a mutation's
 * seeded `ctx.random` (a mutation and its OCC-conflict replay draw the same sequence). Copied from
 * `@stackbase/scheduler`'s `backoff.ts` to keep `@stackbase/notifications` self-contained (no
 * cross-component dependency), the same choice made for `compact`.
 */
export interface BackoffOptions {
  initialBackoffMs: number;
  base: number;
}

/** `attempts` is the failure count AFTER this failure is recorded (post-increment) — so the first
 *  retry (attempts=1) backs off `initialBackoffMs * base^2`, jittered to 50–100%. */
export function computeBackoff(
  attempts: number,
  rng: () => number = Math.random,
  o: BackoffOptions,
): number {
  const raw = o.initialBackoffMs * o.base ** (attempts + 1);
  return Math.round(raw * (0.5 + 0.5 * rng()));
}
```

- [ ] **Step 6: Run it — expect PASS.** Run: `bunx vitest run test/backoff.test.ts` → PASS (2/2).

- [ ] **Step 7: Extend the provider seam.** In `provider.ts`, add at the end of the file:

```ts
/** Thrown by a provider `send` to signal whether the failure should be retried. A plain `Error`
 *  throw is treated as retryable by default; throw `new NotificationSendError(msg, {retryable:false})`
 *  for a permanent failure (e.g. a 4xx bad-recipient) so the driver dead-letters immediately. */
export class NotificationSendError extends Error {
  readonly retryable: boolean;
  constructor(message: string, opts?: { retryable?: boolean }) {
    super(message);
    this.name = "NotificationSendError";
    this.retryable = opts?.retryable ?? true;
  }
}

/** The normalized, cross-provider delivery status (axis 2 — provider-reported via webhooks). */
export type DeliveryStatus =
  | "delivered" | "bounced" | "complained" | "opened" | "clicked" | "dropped" | "failed_permanent";

/** One normalized delivery event parsed from a provider webhook payload. */
export interface WebhookEvent {
  providerMessageId: string;
  deliveryStatus: DeliveryStatus;
  /** Provider event time (ms), if present. */
  at?: number;
  /** Optional detail (bounce reason, etc.). */
  detail?: string;
}

/** Inputs to a provider's webhook signature verification. */
export interface WebhookVerifyArgs {
  headers: Headers;
  rawBody: string;
  url: string;
  /** The configured signing secret for this channel (e.g. Resend `whsec_…`); may be undefined. */
  secret?: string;
}

/** Optional per-provider delivery-webhook support. `verify` MUST return false on any missing/invalid
 *  signature (the route rejects with 401 before any write); `parse` maps the provider's payload to
 *  normalized events (throw on a malformed body → the route answers 400). */
export interface ProviderWebhook {
  verify(args: WebhookVerifyArgs): boolean | Promise<boolean>;
  parse(rawBody: string): WebhookEvent[];
}
```

Then add `webhook?: ProviderWebhook;` to BOTH `EmailProvider` and `SmsProvider`:
```ts
export interface EmailProvider {
  channel: "email";
  send(m: EmailMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
}

export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
  webhook?: ProviderWebhook;
}
```

- [ ] **Step 8: Typecheck + full package.** Run: `cd components/notifications && bunx tsc --noEmit` (expect clean) and `bunx vitest run` (N1 20 + backoff 2 = 22 pass; the new schema/config fields are additive so N1 tests are unaffected).

- [ ] **Step 9: Commit.**
```bash
git add components/notifications/src/schema.ts components/notifications/src/config.ts components/notifications/src/backoff.ts components/notifications/src/provider.ts components/notifications/test/backoff.test.ts
git commit -m "feat(notifications): N2 T1 — retry/reclaim schema+config, backoff, webhook seam types"
```

---

## Task 2: Retry + reclaim driver [PARALLELIZABLE after T1]

**Files:**
- Modify: `components/notifications/src/modules.ts`
- Modify: `components/notifications/src/driver.ts`
- Test: `components/notifications/test/retry-reclaim.test.ts`

**Interfaces:**
- Consumes (T1): `NotificationSendError`, `computeBackoff`, `config.retry`, `config.reclaimLeaseMs`, the new `messages` fields.
- Produces: `_peekQueued(ctx, {now}) → { ready: QueuedMessage[]; earliestDeferredAt: number | null }`; `_claimForSend` stamps `claimedAt`; `_markResult(ctx, {messageId, ok, providerMessageId?, error?, retryable?})`; `_reclaimStuck(ctx) → number`.

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/retry-reclaim.test.ts`. It uses a configurable provider (fail N times then succeed; throw `NotificationSendError({retryable:false})`; a "hang" that leaves the row claimed to test reclaim). Reuse `makeNotifRuntime` from `./helpers`. Because retries use a real backoff `nextAttemptAt`, set `retry.initialBackoffMs: 0` so a retry is immediately eligible, and drive with repeated `__tick()`.

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

/** An email provider whose behavior is scripted per call. */
function scriptedEmail(script: Array<"ok" | "retryable" | "permanent">): { calls: number; provider: EmailProvider } {
  const state = { calls: 0 };
  return {
    get calls() { return state.calls; },
    provider: {
      channel: "email",
      async send() {
        const step = script[Math.min(state.calls, script.length - 1)];
        state.calls++;
        if (step === "ok") return { providerMessageId: `cap-${state.calls}` };
        if (step === "permanent") throw new NotificationSendError("bad recipient", { retryable: false });
        throw new Error("transient 503");
      },
    },
  };
}

function comp(provider: EmailProvider, opts?: { maxAttempts?: number; reclaimLeaseMs?: number }): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { email: { provider, from: "no-reply@test", templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000,
    retry: { maxAttempts: opts?.maxAttempts ?? 4, initialBackoffMs: 0, base: 2 },
    reclaimLeaseMs: opts?.reclaimLeaseMs ?? 60_000,
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

describe("notifications N2 — retry + reclaim", () => {
  it("retries a transient failure with backoff and lands sent", async () => {
    const s = scriptedEmail(["retryable", "retryable", "ok"]);
    built = await makeNotifRuntime(comp(s.provider), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); // attempt 1 → retryable → queued (attempts=1)
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "queued", attempts: 1 });
    await tick(built); // attempt 2 → retryable → queued (attempts=2)
    await tick(built); // attempt 3 → ok → sent
    expect(s.calls).toBe(3);
    const row = (await built.readTable("notifications/messages"))[0]!;
    expect(row).toMatchObject({ status: "sent", providerMessageId: "cap-3" });
    expect(row.payload).toBeUndefined();
  });

  it("dead-letters after maxAttempts on persistent transient failure", async () => {
    const s = scriptedEmail(["retryable"]);
    built = await makeNotifRuntime(comp(s.provider, { maxAttempts: 3 }), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built); await tick(built); await tick(built);
    expect(s.calls).toBe(3);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails immediately (no retry) on a non-retryable error", async () => {
    const s = scriptedEmail(["permanent"]);
    built = await makeNotifRuntime(comp(s.provider), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await tick(built);
    expect(s.calls).toBe(1);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (retry/backoff/attempts not implemented; the row would go straight to `failed`). Run: `bunx vitest run test/retry-reclaim.test.ts`.

- [ ] **Step 3: Update `modules.ts`.** (a) Change `QueuedMessage`/`_peekQueued`: `_peekQueued` now takes `{ now }`, filters by `nextAttemptAt`, and returns `{ ready, earliestDeferredAt }`. Replace the `_peekQueued` definition:

```ts
  // Selects ONLY `status:"queued"` rows that are eligible NOW (nextAttemptAt null or <= now). Returns
  // the earliest FUTURE nextAttemptAt among skipped (backed-off) rows so the driver can arm a precise
  // wake instead of only the interval timer. `now` is passed in (a query has no wall-clock).
  const _peekQueued = query(async (ctx: QueryCtx, args: { now: number }): Promise<{ ready: QueuedMessage[]; earliestDeferredAt: number | null }> => {
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "queued").take(BATCH_CAP).collect();
    const ready: QueuedMessage[] = [];
    let earliestDeferredAt: number | null = null;
    for (const r of rows) {
      if (r.channel !== "email" && r.channel !== "sms") continue; // defensive: in_app is never queued
      const next = r.nextAttemptAt as number | undefined;
      if (next == null || next <= args.now) {
        ready.push({ _id: r._id as string, channel: r.channel as "email" | "sms", to: r.to as string, payload: r.payload as unknown as EmailContent | SmsPayload });
      } else if (earliestDeferredAt === null || next < earliestDeferredAt) {
        earliestDeferredAt = next;
      }
    }
    return { ready, earliestDeferredAt };
  });
```

(Note the `query` import must include `QueryCtx` — it's already imported in `modules.ts`.)

(b) `_claimForSend` stamps `claimedAt`:

```ts
  const _claimForSend = mutation(async (ctx: MutationCtx, args: { messageId: string }): Promise<boolean> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "queued") return false;
    await ctx.db.replace(args.messageId, { ...row, status: "sending", claimedAt: ctx.now() });
    return true;
  });
```

(c) `_markResult` gains retry/dead-letter + `retryable`. Add `computeBackoff` import at the top of `modules.ts`: `import { computeBackoff } from "./backoff";`. Replace `_markResult`:

```ts
  const _markResult = mutation(async (ctx: MutationCtx, args: { messageId: string; ok: boolean; providerMessageId?: string; error?: string; retryable?: boolean }): Promise<null> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "sending") return null; // must be mid-send — defensive
    const now = ctx.now();
    if (args.ok) {
      await ctx.db.replace(args.messageId, compact({ ...row, status: "sent", sentAt: now, providerMessageId: args.providerMessageId, error: undefined, payload: undefined, claimedAt: undefined }));
      return null;
    }
    const attempts = ((row.attempts as number | undefined) ?? 0) + 1;
    if (args.retryable !== false && attempts < config.retry.maxAttempts) {
      // Retry: back to queued with a backoff delay. KEEP payload (needed for the resend). Clear claimedAt.
      const nextAttemptAt = now + computeBackoff(attempts, ctx.random, { initialBackoffMs: config.retry.initialBackoffMs, base: config.retry.base });
      await ctx.db.replace(args.messageId, compact({ ...row, status: "queued", attempts, nextAttemptAt, error: args.error, claimedAt: undefined }));
    } else {
      // Dead-letter: terminal failed. Clear payload (delivered/dead content not retained).
      await ctx.db.replace(args.messageId, compact({ ...row, status: "failed", attempts, error: args.error ?? "send failed", payload: undefined, claimedAt: undefined }));
    }
    return null;
  });
```

(d) Add `_reclaimStuck` (a mutation) and include it in the returned module map. Add before the `return { ... }`:

```ts
  // Reclaim: a row stuck `sending` past the lease (a crash between claim and _markResult) is swept
  // back to `queued`, counting an attempt so a perpetually-crashing row eventually dead-letters
  // instead of looping. Single-node (wall-clock lease). Bounded batch.
  const _reclaimStuck = mutation(async (ctx: MutationCtx): Promise<number> => {
    const now = ctx.now();
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "sending").take(BATCH_CAP).collect();
    let reclaimed = 0;
    for (const row of rows) {
      const claimedAt = row.claimedAt as number | undefined;
      if (claimedAt === undefined || claimedAt + config.reclaimLeaseMs >= now) continue;
      const attempts = ((row.attempts as number | undefined) ?? 0) + 1;
      if (attempts >= config.retry.maxAttempts) {
        await ctx.db.replace(row._id as string, compact({ ...row, status: "failed", attempts, error: "reclaim: stuck sending, max attempts", payload: undefined, claimedAt: undefined }));
      } else {
        const nextAttemptAt = now + computeBackoff(attempts, ctx.random, { initialBackoffMs: config.retry.initialBackoffMs, base: config.retry.base });
        await ctx.db.replace(row._id as string, compact({ ...row, status: "queued", attempts, nextAttemptAt, claimedAt: undefined }));
      }
      reclaimed++;
    }
    return reclaimed;
  });

  return { _enqueueSend, _peekQueued, _claimForSend, _markResult, _reclaimStuck };
```

- [ ] **Step 4: Update `driver.ts`.** The `runPass` gains a reclaim call, the backoff-aware peek (`{now}` arg + `.ready`), and the earliest-deferred timer; `armTimer` takes an optional `earliestDeferredAt`; the per-message loop passes `retryable` to `_markResult` (classified from the throw). Add `import { NotificationSendError } from "./provider";`. Replace `runPass` and `armTimer`:

```ts
  async function runPass(): Promise<void> {
    let earliestDeferredAt: number | null = null;
    do {
      pendingWake = false;
      await ctx.runFunction("notifications:_reclaimStuck", {});
      const now = ctx.now();
      const peek = (await ctx.runFunction("notifications:_peekQueued", { now })) as { ready: QueuedMessage[]; earliestDeferredAt: number | null };
      earliestDeferredAt = peek.earliestDeferredAt;
      for (const m of peek.ready) {
        try {
          const claimed = (await ctx.runFunction("notifications:_claimForSend", { messageId: m._id })) as boolean;
          if (!claimed) continue;
          let ok = false;
          let providerMessageId: string | undefined;
          let error: string | undefined;
          let retryable: boolean | undefined;
          try {
            const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: `msg:${m._id}` });
            ok = true;
            providerMessageId = res.providerMessageId;
          } catch (e) {
            error = String(e);
            retryable = e instanceof NotificationSendError ? e.retryable : true; // plain Error → retryable
          }
          await ctx.runFunction("notifications:_markResult", compact({ messageId: m._id, ok, providerMessageId, error, retryable }) as unknown as JSONValue);
        } catch (e) {
          console.error(`[notifications] driver: message ${m._id} failed mid-pass:`, e);
        }
      }
    } while (pendingWake);
    armTimer(earliestDeferredAt);
  }

  function armTimer(earliestDeferredAt: number | null = null): void {
    if (stopped) return;
    if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    // Wake at the interval, OR sooner if a backed-off row becomes eligible before then.
    const intervalAt = ctx.now() + config.driverIntervalMs;
    const at = earliestDeferredAt !== null && earliestDeferredAt < intervalAt ? earliestDeferredAt : intervalAt;
    timer = ctx.setTimer(at, wake);
  }
```

(`start()`'s `armTimer()` call still works — the parameter defaults to `null`.)

- [ ] **Step 5: Run the retry-reclaim test — expect PASS** (3/3). Run: `bunx vitest run test/retry-reclaim.test.ts`.

- [ ] **Step 6: Add the reclaim test** to the same file (append inside the `describe`). It sends, claims the row via one `__tick` against a provider that "hangs" by throwing after marking — simpler: directly simulate a stuck row by sending with a provider that leaves the row `sending`. Since the driver always calls `_markResult`, to get a stuck `sending` we bypass via a provider whose `send` never resolves is awkward in a sync test. Instead assert reclaim directly by manipulating time: use a `reclaimLeaseMs: 0` config and a provider that throws to force a retry, then verify a row left `sending` (via a direct `_claimForSend` with no mark) is reclaimed. Add:

```ts
  it("reclaims a row stuck in `sending` past the lease", async () => {
    const s = scriptedEmail(["ok"]);
    built = await makeNotifRuntime(comp(s.provider, { reclaimLeaseMs: 0 }), appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    // Claim the row WITHOUT marking it (simulate a crash between claim and _markResult).
    const [row] = await built.readTable("notifications/messages");
    const claimed = await built.runtime.runSystem<boolean>("_system:claim", { messageId: row!._id });
    expect(claimed).toBe(true);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sending" });
    // With reclaimLeaseMs:0 the next pass reclaims it (→ queued), then delivers it (→ sent).
    await tick(built);
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ status: "sent" });
    expect(s.calls).toBe(1);
  });
```

This needs a `_system:claim` privileged helper in `helpers.ts` — add it to the `systemModules()` in `test/helpers.ts` (T2 may edit helpers.ts; it is test-only):

```ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:claim": (await import("@stackbase/executor")).mutation(async (ctx: any, a: { messageId: string }) => {
      const row = await ctx.db.get(a.messageId);
      if (!row || row.status !== "queued") return false;
      await ctx.db.replace(a.messageId, { ...row, status: "sending", claimedAt: ctx.now() });
      return true;
    }),
```

(If a top-level `import { mutation }` is cleaner than the inline `await import`, add `mutation` to the existing `@stackbase/executor` import in `helpers.ts` and use it directly. The `_system:claim` handler must use the FULLY-QUALIFIED behavior — it operates by document id, so no table-name resolution issue.)

- [ ] **Step 7: Run — expect PASS** (4/4). Run: `bunx vitest run test/retry-reclaim.test.ts`.

- [ ] **Step 8: Full package + N1 driver regression.** Run: `bunx vitest run` (N1 driver.test's 3 tests must still pass — the driver's success path is unchanged; N1 send/inbox unaffected). Expect all green. Run `bunx tsc --noEmit` clean.

- [ ] **Step 9: Commit.**
```bash
git add components/notifications/src/modules.ts components/notifications/src/driver.ts components/notifications/test/retry-reclaim.test.ts components/notifications/test/helpers.ts
git commit -m "feat(notifications): N2 T2 — retry with backoff + stuck-sending reclaim in the driver"
```

---

## Task 3a: `resendEmail` delivery webhook (Svix) [PARALLELIZABLE after T1]

**Files:**
- Modify: `components/notifications/src/provider-resend.ts`
- Test: `components/notifications/test/provider-resend-webhook.test.ts`

**Interfaces:**
- Consumes (T1): `ProviderWebhook`, `WebhookEvent`, `WebhookVerifyArgs`, `DeliveryStatus`, `NotificationSendError`.
- Produces: `resendEmail(...).webhook` (Svix verify + parse); `resendEmail(...).send` throws `NotificationSendError` classified by status.

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/provider-resend-webhook.test.ts`. Svix signs `${id}.${timestamp}.${body}` with HMAC-SHA256 keyed by the base64 secret after the `whsec_` prefix; the signature header is `v1,<base64sig>` (space-separated list). Build a correctly-signed fixture using `node:crypto` in the test to prove verify, then tamper it.

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { resendEmail } from "../src/provider-resend";

const SECRET = "whsec_" + Buffer.from("test-signing-key-0123456789").toString("base64");
function sign(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return `v1,${sig}`;
}
function headers(id: string, ts: string, sig: string): Headers {
  return new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": sig });
}

describe("resendEmail.webhook (Svix)", () => {
  const wh = resendEmail({ apiKey: "K" }).webhook!;
  const now = () => Math.floor(1_700_000_000); // fixed ts (seconds)

  it("verifies a correctly-signed payload", async () => {
    const id = "msg_1", ts = String(now());
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const ok = await wh.verify({ headers: headers(id, ts, sign(id, ts, body)), rawBody: body, url: "https://x/api/notifications/webhooks/email", secret: SECRET });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const id = "msg_1", ts = String(now());
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_1" } });
    const sig = sign(id, ts, body);
    const ok = await wh.verify({ headers: headers(id, ts, sig), rawBody: body + "X", url: "https://x", secret: SECRET });
    expect(ok).toBe(false);
  });

  it("rejects a stale timestamp (replay guard)", async () => {
    const id = "msg_1", ts = String(now() - 60 * 60); // 1h old
    const body = "{}";
    const ok = await wh.verify({ headers: headers(id, ts, sign(id, ts, body)), rawBody: body, url: "https://x", secret: SECRET });
    expect(ok).toBe(false);
  });

  it("parses Resend event types to normalized DeliveryStatus", () => {
    const evs = wh.parse(JSON.stringify({ type: "email.bounced", data: { email_id: "re_9" } }));
    expect(evs).toEqual([{ providerMessageId: "re_9", deliveryStatus: "bounced" }]);
    expect(wh.parse(JSON.stringify({ type: "email.opened", data: { email_id: "re_2" } }))[0]!.deliveryStatus).toBe("opened");
    expect(wh.parse(JSON.stringify({ type: "email.complained", data: { email_id: "re_3" } }))[0]!.deliveryStatus).toBe("complained");
  });
});
```

> The verify uses `Date.now()` for the skew check — that is FINE here: webhook verification runs in the httpAction (an action, non-deterministic context), never inside a UDF. The stale-ts test uses a real 1-hour-old timestamp so it fails against the real `Date.now()`.

- [ ] **Step 2: Run it — expect FAIL** (`.webhook` undefined). Run: `bunx vitest run test/provider-resend-webhook.test.ts`.

- [ ] **Step 3: Implement.** In `provider-resend.ts`, import the seam types and add the classification + webhook. Update the import line and the throw, and return a `webhook`:

```ts
import type { EmailProvider, EmailMessage, SendResult, DeliveryStatus, WebhookEvent, WebhookVerifyArgs } from "./provider";
import { NotificationSendError } from "./provider";
import { createHmac, timingSafeEqual } from "node:crypto";

const SVIX_TOLERANCE_S = 5 * 60; // reject timestamps more than 5 minutes from now (replay guard)

/** Map a Resend webhook `type` to a normalized DeliveryStatus (unknown types are ignored). */
const RESEND_STATUS: Record<string, DeliveryStatus> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.delivery_delayed": "dropped",
};

function svixVerify(args: WebhookVerifyArgs): boolean {
  if (!args.secret) return false;
  const id = args.headers.get("svix-id");
  const ts = args.headers.get("svix-timestamp");
  const sigHeader = args.headers.get("svix-signature");
  if (!id || !ts || !sigHeader) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Math.floor(Date.now() / 1000) - tsNum) > SVIX_TOLERANCE_S) return false;
  const key = Buffer.from(args.secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${args.rawBody}`).digest();
  // The header is a space-separated list of `v1,<b64>` — accept if ANY entry matches (constant-time).
  for (const part of sigHeader.split(" ")) {
    const b64 = part.startsWith("v1,") ? part.slice(3) : part.includes(",") ? part.split(",")[1]! : part;
    let got: Buffer;
    try { got = Buffer.from(b64, "base64"); } catch { continue; }
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

export function resendEmail(opts: { apiKey: string; baseUrl?: string }): EmailProvider {
  const base = opts.baseUrl ?? "https://api.resend.com";
  return {
    channel: "email",
    async send(m: EmailMessage): Promise<SendResult> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
      };
      if (m.idempotencyKey) headers["Idempotency-Key"] = m.idempotencyKey;
      const res = await fetch(`${base}/emails`, {
        method: "POST",
        headers,
        body: JSON.stringify({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}) }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 4xx (except 429 rate-limit) is a permanent client error → do not retry. 5xx/429 → retry.
        const retryable = res.status >= 500 || res.status === 429;
        throw new NotificationSendError(`resend send failed (${res.status}): ${body}`, { retryable });
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: json.id };
    },
    webhook: {
      verify: svixVerify,
      parse(rawBody: string): WebhookEvent[] {
        const evt = JSON.parse(rawBody) as { type?: string; data?: { email_id?: string } };
        const ds = evt.type ? RESEND_STATUS[evt.type] : undefined;
        const id = evt.data?.email_id;
        if (!ds || !id) return [];
        return [{ providerMessageId: id, deliveryStatus: ds }];
      },
    },
  };
}
```

- [ ] **Step 4: Run — expect PASS** (4/4). Run: `bunx vitest run test/provider-resend-webhook.test.ts`. Also re-run the N1 `test/provider-resend.test.ts` — the send tests must still pass (the throw message format is unchanged, only the error class changed; the `.rejects.toThrow(/resend send failed \(422\)/)` still matches, and 422 is now non-retryable — no test asserts retryability there).

- [ ] **Step 5: Commit.**
```bash
git add components/notifications/src/provider-resend.ts components/notifications/test/provider-resend-webhook.test.ts
git commit -m "feat(notifications): N2 T3a — resend Svix delivery webhook + retryable send classification"
```

---

## Task 3b: `twilioSms` delivery webhook (X-Twilio-Signature) [PARALLELIZABLE after T1]

**Files:**
- Modify: `components/notifications/src/provider-twilio.ts`
- Test: `components/notifications/test/provider-twilio-webhook.test.ts`

**Interfaces:**
- Consumes (T1): `ProviderWebhook`, `WebhookEvent`, `WebhookVerifyArgs`, `DeliveryStatus`, `NotificationSendError`.
- Produces: `twilioSms(...).webhook` (X-Twilio-Signature verify + parse); classified send errors.

- [ ] **Step 1: Read the current file** `components/notifications/src/provider-twilio.ts` so the edits below match its exact existing `send`/imports (it was written in N1 T2c). The webhook uses Twilio's scheme: HMAC-SHA1 over the full request URL followed by each POST param appended in KEY-SORTED order (`key`+`value`), base64, compared to `X-Twilio-Signature`. Twilio status callbacks are `application/x-www-form-urlencoded` (`MessageSid`, `MessageStatus`).

- [ ] **Step 2: Write the failing test.** Create `components/notifications/test/provider-twilio-webhook.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { twilioSms } from "../src/provider-twilio";

const TOKEN = "test_auth_token";
const URL_ = "https://app.test/api/notifications/webhooks/sms";

function twilioSign(url: string, params: Record<string, string>): string {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return createHmac("sha1", TOKEN).update(data).digest("base64");
}
function form(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

describe("twilioSms.webhook (X-Twilio-Signature)", () => {
  const wh = twilioSms({ accountSid: "AC1", authToken: TOKEN }).webhook!;

  it("verifies a correctly-signed status callback", async () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const sig = twilioSign(URL_, params);
    const ok = await wh.verify({ headers: new Headers({ "x-twilio-signature": sig }), rawBody: form(params), url: URL_, secret: undefined });
    expect(ok).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const ok = await wh.verify({ headers: new Headers({ "x-twilio-signature": "wrong" }), rawBody: form(params), url: URL_, secret: undefined });
    expect(ok).toBe(false);
  });

  it("parses MessageStatus to normalized DeliveryStatus", () => {
    expect(wh.parse(form({ MessageSid: "SM1", MessageStatus: "delivered" }))).toEqual([{ providerMessageId: "SM1", deliveryStatus: "delivered" }]);
    expect(wh.parse(form({ MessageSid: "SM2", MessageStatus: "undelivered" }))[0]!.deliveryStatus).toBe("bounced");
    expect(wh.parse(form({ MessageSid: "SM3", MessageStatus: "failed" }))[0]!.deliveryStatus).toBe("failed_permanent");
    expect(wh.parse(form({ MessageSid: "SM4", MessageStatus: "sent" }))).toEqual([]); // non-terminal → ignored
  });
});
```

- [ ] **Step 3: Run — expect FAIL.** Run: `bunx vitest run test/provider-twilio-webhook.test.ts`.

- [ ] **Step 4: Implement.** Edit `provider-twilio.ts`: import the seam types + `node:crypto`, classify the send throw as `NotificationSendError` (4xx-except-429 non-retryable), and add `webhook`. The Twilio auth token is the HMAC key (the `secret` arg is ignored — Twilio uses the account token the adapter already holds). Keep the existing `send` request shape; only wrap the throw and add `webhook`. Add:

```ts
import type { SmsProvider, SmsMessage, SendResult, DeliveryStatus, WebhookEvent, WebhookVerifyArgs } from "./provider";
import { NotificationSendError } from "./provider";
import { createHmac, timingSafeEqual } from "node:crypto";

const TWILIO_STATUS: Record<string, DeliveryStatus> = {
  delivered: "delivered",
  undelivered: "bounced",
  failed: "failed_permanent",
};

function twilioVerify(authToken: string, args: WebhookVerifyArgs): boolean {
  const provided = args.headers.get("x-twilio-signature");
  if (!provided) return false;
  const params = Object.fromEntries(new URLSearchParams(args.rawBody));
  let data = args.url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

In the `twilioSms` factory return object, wrap the existing non-2xx throw as `throw new NotificationSendError(<existing message>, { retryable: res.status >= 500 || res.status === 429 })` (match the existing message text so the N1 twilio test's `.toThrow` still matches — DO NOT leak the authToken, unchanged), and add:

```ts
    webhook: {
      verify: (args) => twilioVerify(opts.authToken, args),
      parse(rawBody: string): WebhookEvent[] {
        const params = Object.fromEntries(new URLSearchParams(rawBody));
        const ds = params.MessageStatus ? TWILIO_STATUS[params.MessageStatus] : undefined;
        if (!ds || !params.MessageSid) return [];
        return [{ providerMessageId: params.MessageSid, deliveryStatus: ds }];
      },
    },
```

(`opts.authToken` is the adapter's existing option name — confirm against the file read in Step 1 and use the real name.)

- [ ] **Step 5: Run — expect PASS** (3/3). Run: `bunx vitest run test/provider-twilio-webhook.test.ts`. Re-run N1 `test/provider-twilio.test.ts` — the send tests must still pass (message text unchanged).

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/provider-twilio.ts components/notifications/test/provider-twilio-webhook.test.ts
git commit -m "feat(notifications): N2 T3b — twilio X-Twilio-Signature delivery webhook + send classification"
```

---

## Task 4: Webhook route + status normalization [PARALLELIZABLE after T1]

**Files:**
- Create: `components/notifications/src/webhook.ts`
- Modify: `components/notifications/src/index.ts`
- Test: `components/notifications/test/webhook-apply.test.ts`

**Interfaces:**
- Consumes (T1): `ProviderWebhook`, `WebhookEvent`, `DeliveryStatus`, the `byProviderMessageId` index, `NotificationsConfig`.
- Produces: `makeWebhookModules(config) → { webhookHttp, _applyWebhookEvent }`; `index.ts` wires `httpRoutes` + spreads the modules.

- [ ] **Step 1: Write the failing test.** Create `components/notifications/test/webhook-apply.test.ts`. It tests the `_applyWebhookEvent` monotonic mutation directly (correlate by `providerMessageId`, monotonic, unknown-id no-op) via a system helper that seeds a `messages` row and reads it back. It also tests the `webhookHttp` route dispatch with a fake `webhook` provider (verify=true/false, parse → events). Build the component with `makeWebhookModules` and a fake provider.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent } from "@stackbase/component";
import { httpAction, mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeWebhookModules } from "../src/webhook";
import type { EmailProvider, WebhookEvent } from "../src/provider";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

// A fake email provider whose webhook.verify is toggleable and parse returns scripted events.
function fakeProvider(verifyOk: boolean, events: WebhookEvent[]): EmailProvider {
  return {
    channel: "email",
    async send() { return {}; },
    webhook: { verify: () => verifyOk, parse: () => events },
  };
}

function comp(provider: EmailProvider) {
  const config = resolveNotificationsConfig({ channels: { email: { provider, from: "x@test", webhookSecret: "whsec_x" } } });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeWebhookModules(config) }, contextWrite: true,
  });
}

// System helpers: seed a `messages` row with a providerMessageId + read deliveryStatus.
const systemSeed: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "_system:seedMsg": mutation(async (ctx: any, a: { providerMessageId: string }) =>
    (await ctx.db.insert("notifications/messages", { channel: "email", to: "u@test", status: "sent", providerMessageId: a.providerMessageId, createdAt: 0 }))),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

// (webhookHttp is an httpAction; drive it via the runtime's runHttpAction if exposed, else via
//  ctx.runMutation of _applyWebhookEvent directly — the plan's Step 4 confirms the invoke path.)

describe("notifications N2 — webhook apply (status normalization)", () => {
  it("_applyWebhookEvent correlates by providerMessageId and is monotonic", async () => {
    built = await makeNotifRuntime(comp(fakeProvider(true, [])), systemSeed);
    await built.runtime.runSystem("_system:seedMsg", { providerMessageId: "re_1" });
    await built.runtime.run("notifications:_applyWebhookEvent", { providerMessageId: "re_1", deliveryStatus: "delivered" });
    expect((await built.readTable("notifications/messages"))[0]).toMatchObject({ deliveryStatus: "delivered" });
    // A lower-rank event (bounced=2 < delivered=3) is a no-op.
    await built.runtime.run("notifications:_applyWebhookEvent", { providerMessageId: "re_1", deliveryStatus: "bounced" });
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBe("delivered");
    // A higher-rank event (opened=4) applies.
    await built.runtime.run("notifications:_applyWebhookEvent", { providerMessageId: "re_1", deliveryStatus: "opened" });
    expect((await built.readTable("notifications/messages"))[0]!.deliveryStatus).toBe("opened");
  });

  it("_applyWebhookEvent is a no-op for an unknown providerMessageId", async () => {
    built = await makeNotifRuntime(comp(fakeProvider(true, [])), systemSeed);
    await built.runtime.run("notifications:_applyWebhookEvent", { providerMessageId: "nope", deliveryStatus: "delivered" });
    expect((await built.readTable("notifications/messages")).length).toBe(0);
  });
});
```

> The `webhookHttp` httpAction's end-to-end 401/verify path is proven in the T5 E2E through the real server (which has the HTTP router); this component test covers the apply mutation's correctness. If the embedded runtime exposes a direct httpAction invoke in `helpers.ts`, add a route-level verify test here too; otherwise the E2E covers it (note it in the report).

- [ ] **Step 2: Run — expect FAIL** (`../src/webhook` missing). Run: `bunx vitest run test/webhook-apply.test.ts`.

- [ ] **Step 3: Create `webhook.ts`.**

```ts
import { httpAction, mutation, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
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
  // Privileged (fully-qualified table): apply one normalized delivery event to its message row,
  // monotonically. Reachable from the webhook httpAction via `api.runMutation`.
  const _applyWebhookEvent = mutation(async (ctx: MutationCtx, args: { providerMessageId: string; deliveryStatus: DeliveryStatus; detail?: string }): Promise<null> => {
    const [row] = await ctx.db.query("notifications/messages", "byProviderMessageId").eq("providerMessageId", args.providerMessageId).take(1).collect();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx as any).runMutation("notifications:_applyWebhookEvent", compact({ providerMessageId: e.providerMessageId, deliveryStatus: e.deliveryStatus, detail: e.detail }));
    }
    return new Response("ok", { status: 200 }); // ack so the provider stops retrying
  });

  return { webhookHttp, _applyWebhookEvent };
}
```

- [ ] **Step 4: Confirm the httpAction invoke path.** Verify how an httpAction calls an internal mutation: read `components/auth/src/external.ts` (`ctx.runMutation("auth:_startOAuth", ...)`) — the httpAction ctx is an ActionCtx with `runMutation`. Match that exact call shape (the `(ctx as any).runMutation` above is a placeholder; if the ctx is typed `ActionCtx`, cast `ctx as ActionCtx` and call `ctx.runMutation(...)` like auth does). Adjust `webhook.ts` to the real typed call.

- [ ] **Step 5: Wire `index.ts`.** Add the import + spread + `httpRoutes`. Change the `makeInboxModules` import line region to also import `makeWebhookModules`, spread it into `modules`, and conditionally add `httpRoutes`:

```ts
import { makeWebhookModules } from "./webhook";
```
Add exports near the other type exports:
```ts
export type { DeliveryStatus, WebhookEvent, WebhookVerifyArgs, ProviderWebhook } from "./provider";
export { NotificationSendError } from "./provider";
```
In `defineNotifications`, compute the flag and extend the returned component:
```ts
export function defineNotifications(opts: NotificationsOptions): ComponentDefinition {
  const config = resolveNotificationsConfig(opts);
  const hasWebhook = !!(config.channels.email?.provider.webhook || config.channels.sms?.provider.webhook);
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules(), ...makeWebhookModules(config) },
    context: (cctx) => notificationsContext(cctx, config),
    contextType: { import: "@stackbase/notifications", type: "NotificationsContext" },
    contextWrite: true,
    buildAction: (api) => notificationsActionContext(api, config),
    driver: notificationsDriver(config),
    ...(hasWebhook ? { httpRoutes: [{ method: "POST", pathPrefix: "/api/notifications/webhooks/", handler: "webhookHttp" }] } : {}),
  });
}
```

- [ ] **Step 6: Run — expect PASS** (webhook-apply 2/2). Run: `bunx vitest run test/webhook-apply.test.ts`. Full package: `bunx vitest run` (all green). Typecheck: `bunx tsc --noEmit`.

- [ ] **Step 7: Commit.**
```bash
git add components/notifications/src/webhook.ts components/notifications/src/index.ts components/notifications/test/webhook-apply.test.ts
git commit -m "feat(notifications): N2 T4 — webhook route + monotonic deliveryStatus normalization"
```

---

## Task 5: E2E through the real dev server + docs [sequential, last]

**Files:**
- Create: `packages/cli/test/notifications-reliability-e2e.test.ts`
- Modify: `docs/enduser/build/notifications.md`

**Interfaces:**
- Consumes: everything above, through `defineNotifications` + the real dev server (mirror `packages/cli/test/notifications-e2e.test.ts`).

- [ ] **Step 1: Write the E2E.** Mirror the N1 E2E's `bootServer` scaffold. Two proofs: (a) a provider that fails once then succeeds → a live subscription over a status query sees the row retry then reach `sent`; (b) a POST to `/api/notifications/webhooks/email` with a VALID Svix signature flips `deliveryStatus` reactively, and an INVALID signature returns 401 with no change. Use a real `resendEmail`-style webhook by constructing a capture provider that also carries a `webhook` computing a real Svix signature with a known secret (or reuse `resendEmail(...).webhook` verify with a locally-signed body). Compose with `driverIntervalMs: 500`, `retry.initialBackoffMs: 10`.

Full file (adapt paths/imports to the N1 E2E which is the proven reference):

```ts
/**
 * Notifications N2 — E2E through the real dev server: retries land sent reactively, and a
 * signature-verified delivery webhook flips deliveryStatus reactively (invalid signature → 401).
 */
import { describe, it, expect, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications, NotificationSendError, type EmailProvider, type WebhookEvent } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const SECRET = "whsec_" + Buffer.from("n2-e2e-signing-key").toString("base64");
function svixHeaders(body: string): Record<string, string> {
  const id = "msg_e2e", ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}` };
}

// A provider that fails the first send then succeeds, and verifies Svix webhooks with SECRET.
function flakyResend(): { calls: number; provider: EmailProvider } {
  const st = { calls: 0 };
  return {
    get calls() { return st.calls; },
    provider: {
      channel: "email",
      async send() { st.calls++; if (st.calls === 1) throw new Error("transient"); return { providerMessageId: "re_e2e" }; },
      webhook: {
        verify: (a) => {
          const id = a.headers.get("svix-id"), ts = a.headers.get("svix-timestamp"), sig = a.headers.get("svix-signature");
          if (!id || !ts || !sig) return false;
          const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
          const exp = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${a.rawBody}`).digest("base64")}`;
          return sig === exp;
        },
        parse: (raw): WebhookEvent[] => { const e = JSON.parse(raw); return e.data?.email_id ? [{ providerMessageId: e.data.email_id, deliveryStatus: e.type === "email.delivered" ? "delivered" : "bounced" }] : []; },
      },
    },
  };
}

const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });
const appModules = {
  notify: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ping: mutation(async (ctx: any, { userId }: { userId: string }) =>
      ctx.notifications.send({ to: { userId, email: `${userId}@test` }, channels: ["email"], template: { email: { subject: "Hi", text: "hi" } } })),
    // A query over the message rows' status so the client can subscribe reactively.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    statuses: query(async (ctx: any) => (await ctx.db.query("notifications/messages", "byStatus").collect()).map((r: any) => ({ status: r.status, deliveryStatus: r.deliveryStatus ?? null, providerMessageId: r.providerMessageId ?? null }))),
  },
};
const api = anyApi as { notify: { ping: { __path: string }; statuses: { __path: string } } };

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N2 — reliability E2E", () => {
  it("a transient failure retries and lands sent; a signed webhook flips deliveryStatus (bad sig → 401)", async () => {
    const flaky = flakyResend();
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({ channels: { email: { provider: flaky.provider, from: "no-reply@test", webhookSecret: SECRET } }, driverIntervalMs: 500, retry: { initialBackoffMs: 10 } }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
      componentNames: project.componentNames, contextProviders: project.contextProviders,
      bootSteps: project.bootSteps, drivers: project.drivers,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const c = new StackbaseClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    try {
      c.setAuth("user-1");
      const statuses: Array<Array<{ status: string; deliveryStatus: string | null; providerMessageId: string | null }>> = [];
      c.subscribe(api.notify.statuses, {}, (v2) => statuses.push(v2 as never));
      await waitFor(() => statuses.length >= 1);

      await c.mutation(api.notify.ping, { userId: "user-1" });
      // Retry: first send throws (transient), driver retries within backoff+interval → sent.
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.status === "sent"), 8000, "retry→sent");
      expect(flaky.calls).toBeGreaterThanOrEqual(2);

      // Invalid webhook signature → 401, no deliveryStatus change.
      const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_e2e" } });
      const bad = await fetch(`${base}/api/notifications/webhooks/email`, { method: "POST", headers: { "svix-id": "x", "svix-timestamp": "1", "svix-signature": "v1,bad" }, body });
      expect(bad.status).toBe(401);

      // Valid signature → 200, deliveryStatus flips to delivered reactively.
      const good = await fetch(`${base}/api/notifications/webhooks/email`, { method: "POST", headers: { "content-type": "application/json", ...svixHeaders(body) }, body });
      expect(good.status).toBe(200);
      await waitFor(() => (statuses.at(-1) ?? []).some((r) => r.deliveryStatus === "delivered"), 5000, "reactive deliveryStatus");
    } finally {
      c.close();
    }
  });
});

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`); await new Promise<void>((r) => setTimeout(r, 20)); }
}
```

- [ ] **Step 2: Build the deps + run the E2E.** Run: `bun run build` (topological — rebuild notifications+client dist so the CLI resolves them), then `cd packages/cli && bunx vitest run test/notifications-reliability-e2e.test.ts` → PASS (1/1). If the webhook route 404s, confirm `hasWebhook` wiring (Step T4-5) and that `startDevServer` mounts component `httpRoutes` (it does — the same path auth's OAuth callback uses).

- [ ] **Step 3: Update the docs.** In `docs/enduser/build/notifications.md`, add a `## Delivery reliability` section after the providers section: (a) retries — the `retry: { maxAttempts, initialBackoffMs, base }` config, that a transient failure retries with backoff and a permanent one (a provider `NotificationSendError({retryable:false})`) fails fast, dead-lettering at `maxAttempts`; (b) reclaim — a crashed in-flight send is recovered after `reclaimLeaseMs`; (c) webhooks — set the provider's webhook URL to `https://<your-host>/api/notifications/webhooks/email` (or `/sms`), put the signing secret in `email: { …, webhookSecret: process.env.RESEND_WEBHOOK_SECRET }`, and the normalized `deliveryStatus` (`delivered`/`bounced`/`complained`/`opened`/`clicked`) appears on the message row reactively; (d) a note that reliability applies to email/SMS only (in-app is instant). Then move retries + webhooks from the N1 "What's deferred → N2" line to shipped, leaving preferences/routing/topics (N3) and digest/auth-unify (N4).

- [ ] **Step 4: Commit.**
```bash
git add packages/cli/test/notifications-reliability-e2e.test.ts docs/enduser/build/notifications.md
git commit -m "feat(notifications): N2 T5 — reliability E2E through the real dev server + docs"
```

---

## Verification (run after each task; full gate after T5)

```bash
# Component package (after each task):
bun run --filter @stackbase/notifications typecheck
bun run --filter @stackbase/notifications test

# E2E (after T5, once deps are built via dist):
bun run build
cd packages/cli && bunx vitest run test/notifications-reliability-e2e.test.ts

# Whole-repo gate:
bun run build && bun run typecheck && bun run test
```

Remember the **dist-resolution rule**: rebuild `@stackbase/notifications` (and `@stackbase/client`) before the CLI E2E. Remember the **compact-at-every-boundary rule** for any new `runFunction`/`runMutation`/`db.insert`/`db.replace` args or returns.

## Self-Review

- **Spec coverage:** retries+backoff (T2), reclaim (T2), non-retryable classification (T1 error + T2 driver + T3a/b adapters), webhooks+signature (T3a/b verify + T4 route), status normalization two-axis (T1 schema + T4 monotonic apply), `httpRoutes` mount (T4 index), reactive deliveryStatus (T5 E2E), docs (T5). All spec sections map to a task.
- **Type consistency:** `DeliveryStatus`/`WebhookEvent`/`ProviderWebhook`/`WebhookVerifyArgs`/`NotificationSendError` defined once in `provider.ts` (T1), consumed by T2/T3a/T3b/T4; `_peekQueued` return shape `{ready, earliestDeferredAt}` defined and consumed only in T2; `_applyWebhookEvent` args match between `webhook.ts` and the test.
- **Boundary rule applied:** every new `runFunction`/`runMutation`/`db.replace` call in T2/T4 uses `compact`.
- **Reactivity:** `deliveryStatus` is a `messages`-row write → a `byStatus`/message query re-runs (T5 subscribes to prove it).
