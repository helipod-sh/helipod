# Notifications slice N1 — substrate + reactive inbox (implementation plan)

For agentic workers: use the `superpowers:subagent-driven-development` skill to execute this plan. Tasks are tagged **[CRITICAL-PATH sequential]** (run in order, same worktree — later tasks build on earlier files) or **[PARALLELIZABLE — independent files]** (dispatch concurrently in isolated worktrees; each owns a disjoint file set — see the Parallelism Map). The three provider adapters are the parallel set.

**Goal:** Ship `@stackbase/notifications` — an opt-in component (composed via `stackbase.config.ts`, like scheduler/triggers/workflow) that sends messages across pluggable channels (email, SMS/WhatsApp, in-app) through swappable per-channel provider adapters, with transactional at-most-once delivery and a **reactive in-app inbox** that is nearly free because stored rows are already live-queried.

**Architecture:** `defineNotifications(opts)` (following `defineScheduler`), whose module set is built by `makeSendModules(config)`/`makeInboxModules()` factories closing over the resolved config. A two-layer **Channel × Provider** seam (`EmailProvider`/`SmsProvider`, base `NotificationProvider`) mirrors `DatabaseAdapter`/`BlobStore` — the component never imports a driver. `ctx.notifications.send(...)` runs in a **mutation**: it writes a `messages` row per channel, and for `in_app` also the `notifications` inbox row (the row IS the delivered notification — reactive, no send step), and enqueues email/SMS rows (`status: "queued"`) for a **recurring driver** (the scheduler/reaper pattern — woken by the commit fan-out + a wall-clock timer) to deliver via `provider.send(...)` OUTSIDE the transaction, flipping `queued → sent`/`failed`. At-most-once is a `sendReceipts` row keyed by `idempotencyKey`, recorded transactionally (the scheduler `by_idempotency` insert-or-noop discipline under single-writer OCC), with passthrough to a provider's native `Idempotency-Key`. The reactive inbox is `notifications` + a live `useQuery` feed + `unreadCount` + ownership-checked `markRead`/`markAllRead`, wrapped by a `useNotifications()`/`<Inbox>` React helper.

**Tech Stack:** TypeScript, Bun (runtime/pkg-manager), Turborepo, vitest under Node, `@stackbase/values`/`@stackbase/executor`/`@stackbase/component` engine seams, `@stackbase/test` (`createTestStackbase`) for the E2E, native `fetch` in provider adapters, `@stackbase/client` (+ `/react`) for the inbox hook. No new runtime dependency.

## Global Constraints

Binding values copied **verbatim** from the design spec (`docs/superpowers/specs/2026-03-20-notifications-substrate-design.md`). Do not relitigate while implementing:

- **Two-layer seam: Channel × Provider** (isomorphic to `DatabaseAdapter`/`BlobStore` — the component never imports a driver). A **channel** is a medium (`"email"`, `"sms"`, `"in_app"`; WhatsApp is an SMS-provider variant addressed by the provider, not a separate channel). A **provider** is a swappable adapter for one channel: base `NotificationProvider { channel; send(msg): Promise<SendResult> }` with per-channel message/result types.
- **The seam is shaped auth-compatible, but N1 does NOT touch auth.** The `EmailProvider` shape generalizes `components/auth/src/email/provider.ts` (same `send({to, from, subject, text, html?})` contract) so N4 can unify auth onto it — but N1 modifies **nothing** in `components/auth`. Auth keeps its own seam until N4.
- **Send straddles the mutation/action boundary:** the public `ctx.notifications.send(...)` runs in a MUTATION and (a) writes a `messages` row per channel (`status: "queued"`), (b) for `in_app` the row IS the delivered notification — instantly visible to a live query, no send step, and (c) enqueues the email/SMS rows for a **driver** to actually send via the provider `fetch` OUTSIDE the transaction, updating status `queued → sent`/`failed`. An action-side `ctx.notifications.sendNow(...)` variant sends synchronously (returns the provider result directly).
- **At-most-once via a durable send receipt** (the Receipted-Outbox / scheduler `by_idempotency` discipline): a `sendReceipts` row keyed by `(idempotencyKey)` recorded transactionally before the provider call; a replay short-circuits to the recorded result. Passes the key through to a provider's native `Idempotency-Key` when supported (Resend/Loops) — only 2 of 8 providers have it, so the orchestrator owns dedup. Guarantees an OTP-class message never double-sends when N4 routes auth through here.
- **The reactive in-app inbox is the flagship:** a `notifications` table + a generated `useQuery`-able inbox feed + an `unreadCount` query + a `markRead`/`markAllRead` mutation, with the delivery-status rows reactive too. Ship a small `<Inbox>` / `useNotifications` helper in the React client.
- **Inline typed per-channel templates** (not a markup engine): content is authored per channel — `email: (data) => { subject; html?; text }`, `sms: (data) => string`, `in_app: (data) => { title; body; ...structured }`. A `templateId`+`variables` shape is anticipated in the email message type but not required in N1.
- **Providers shipped in N1:** `consoleEmail()` + `resendEmail()` (reuse/generalize the auth adapters, moved/copied into the notifications provider package — **auth's copies stay untouched**), a `twilioSms()` adapter (SMS + WhatsApp addressing), and the built-in `in_app` writer (not a pluggable provider — the engine writes the row). Provider selection: **one active provider per channel** in N1 (multi-provider fallback is N3).
- **`ctx.now()` in mutations; provider I/O only in the driver/action.** No `Date.now()`/`Math.random()` in the mutation path; timestamps via `ctx.now()`; the message id uses the engine's insert mint.
- **Component surface — config (opt-in, `stackbase.config.ts`):**
  ```ts
  defineNotifications({
    channels: {
      email?: { provider: EmailProvider; from: string; templates?: EmailTemplates },
      sms?:   { provider: SmsProvider;   from: string; templates?: SmsTemplates },
      in_app?: { enabled: true; templates?: InAppTemplates },   // built-in writer
    },
    driverIntervalMs?: number,   // default 5000 — queued-send sweep cadence (plus the commit-fanout wake)
  })
  ```
- **`NotificationProvider` seam (exported for adapters + N4 auth reuse):**
  ```ts
  interface EmailProvider { channel: "email"; send(m: EmailMessage): Promise<SendResult> }
  interface SmsProvider   { channel: "sms";   send(m: SmsMessage):   Promise<SendResult> }
  type EmailMessage = { to: string; from: string; subject: string; text: string; html?: string;
                        templateId?: string; variables?: Record<string, unknown>; idempotencyKey?: string }
  type SmsMessage   = { to: string; from: string; body: string; kind?: "sms" | "whatsapp";
                        idempotencyKey?: string }
  type SendResult   = { providerMessageId?: string }   // throws on failure
  ```
- **Context facade (`ctx.notifications`, always-available on every function ctx when composed, like `ctx.scheduler`):** `send({ to, channels, template, data, idempotencyKey? })` — MUTATION-side. `to` = `{ userId?, email?, phone? }`; `channels` = which configured channels to deliver on; `template` = a registered template key or an inline content object; `data` = the template payload. Writes the `messages` rows + (for in_app) the `notifications` row; enqueues email/SMS. Returns `{ messageIds }`. `sendNow(...)` — ACTION-side synchronous variant.
- **Schema (component tables, namespaced `notifications/*`) — additive:**
  - `messages`: `{ channel, to, status: "queued"|"sent"|"failed", providerMessageId?, error?, idempotencyKey?, templateKey?, dataHash?, createdAt, sentAt? }`, indexes `byStatus` (driver sweep), `byIdempotencyKey` (dedup). One row per (send × channel).
  - `notifications`: the in-app inbox — `{ userId, title, body, data?, read: boolean, readAt?, createdAt, messageId }`, indexes `byUser` (feed / unread count, keeps invalidation scoped to the user), `byUserUnread`. Written synchronously in the send mutation; is the delivered in-app notification.
  - `sendReceipts`: `{ idempotencyKey, messageIds, createdAt }`, index `byKey` — the at-most-once ledger.

  A project without `defineNotifications` composed has zero new tables/surface.
- **Security / correctness:** **No secret leakage** — provider credentials live in the provider closure/config, never in a `messages` row; `dataHash` is a hash of the template payload for dedup, not the payload. **In-app authorization** — the inbox query resolves the caller's identity (`ctx.auth?.getUserId()` when auth is composed, else the raw identity) and returns only that user's rows; `markRead` is ownership-checked. **Idempotency** — the receipt is written in the SAME transaction as the `messages` rows (consume-before-validate); a concurrent duplicate with the same key resolves to one winner under single-writer OCC. **In-app is instant + reactive; email/SMS are queued** — the send mutation never does I/O.
- **DX is the feature:** `ctx.notifications.send` is typed via `contextType` augmentation (the `declare module "@stackbase/executor"` ctx augmentation, exactly like `ctx.scheduler`); the inbox query is typed for consumers by the hand-written `useNotifications()`/`<Inbox>` helper in `@stackbase/client/react` over the well-known `notifications:inbox`/`unreadCount`/`markRead`/`markAllRead` paths.
- **E2E through the real server:** the cross-package proof (`packages/cli/test/notifications-e2e.test.ts`) drives a REAL `@stackbase/client` over a REAL WebSocket against a REAL `stackbase dev` server (`loadProject` + `createEmbeddedRuntime` + `startDevServer`), per the e2e-through-shipped-entrypoint rule.
- **Reference code is FSL-1.1-Apache-2.0 (`.reference/`) — never copy; reimplement.** The reactive in-app inbox is the deliberate differentiator: competitors build a realtime service for it; for us it is a table + a live query.
- **Build ordering / dist resolution:** tests run under Node/vitest; cross-package tests resolve deps via each package's built `dist/`. **After editing a dependency package, run `bun run build` (or `bun run --filter <pkg> build`) before running a dependent's tests.** Component handlers get a deterministic `ctx.now()` (fixed per OCC attempt) — **never `Date.now()` in a query/mutation handler**.

### Resolved spec ambiguities (see §Ambiguities at the end for full rationale)

1. **`messages.payload` field added** (optional, `v.any()`). The verbatim `messages` schema has `templateKey?`/`dataHash?` but no field carrying the content the driver needs to actually send out-of-transaction. Resolution: templates are **pure functions**, so they render inside the mutation (deterministic, no I/O); the rendered per-channel content (`email {subject,text,html?}`, `sms {body,kind?}`) is stored on `messages.payload` for the driver to deliver without re-render and without persisting the raw `data` (possible PII). This is the ONLY field added beyond the verbatim schema.
2. **`in_app` also gets a `messages` row** (`status: "sent"`, `sentAt = now`), alongside the `notifications` inbox row — keeping "one `messages` row per (send × channel)" uniform and letting the delivery-status dashboard reflect in-app too. The `notifications` row is what's reactive/delivered; the `messages` row is the audit/status record.
3. **`sendNow` uses a two-phase internal path** (`_prepareNow` → live `provider.send` → `_finishNow`) that persists email/SMS rows only as **final** (`sent`/`failed`), never `queued` — so the queued-sweep driver can never double-deliver a `sendNow` message. No claim/lease state is added (N1 has no retries; the driver's single-owner flag serializes its own passes).

## Parallelism Map

**Component package root:** `components/notifications/` (new). New client files under `packages/client/`. New E2E + docs under `packages/cli/` + `docs/`.

| Task | Tag | Owns exactly (no other task writes these) |
|------|-----|-------------------------------------------|
| **T1** | CRITICAL-PATH (lands first) | `components/notifications/package.json`, `components/notifications/tsconfig.json`, `components/notifications/src/provider.ts`, `.../src/config.ts`, `.../src/schema.ts`, `.../src/render.ts`, `.../src/index.ts`, `.../test/helpers.ts` |
| **T2a** | PARALLELIZABLE (after T1) | `components/notifications/src/provider-console.ts`, `.../test/provider-console.test.ts` |
| **T2b** | PARALLELIZABLE (after T1) | `components/notifications/src/provider-resend.ts`, `.../test/provider-resend.test.ts` |
| **T2c** | PARALLELIZABLE (after T1) | `components/notifications/src/provider-twilio.ts`, `.../test/provider-twilio.test.ts` |
| **T3** | CRITICAL-PATH | `components/notifications/src/facade.ts`, `.../src/modules.ts`, `.../test/send.test.ts` |
| **T4** | CRITICAL-PATH | `components/notifications/src/driver.ts`, `.../test/driver.test.ts` |
| **T5** | CRITICAL-PATH | `components/notifications/src/inbox.ts`, `.../test/inbox.test.ts`, `packages/client/src/notifications.tsx` (new), `packages/client/src/react.tsx` (append 2 export lines) |
| **T6** | PARALLELIZABLE with T5's client work | `packages/cli/test/notifications-e2e.test.ts`, `docs/enduser/build/notifications.md` |

**Dispatch order for the controller:**
1. Run **T1** first (everything depends on the seam types + schema + config + `index.ts` wiring + `test/helpers.ts`).
2. Then run **T2a, T2b, T2c concurrently in isolated worktrees** (each only needs T1's `provider.ts` seam types; each imports its adapter + `../src/provider` types **directly**, never the package `index.ts`, so it builds/tests independently of the critical chain's progress). In parallel, run the critical chain **T3 → T4 → T5** in a separate worktree (sequential — T4's driver test references `_peekQueued`/`_markResult` from T3's `modules.ts`; T5's inbox composes alongside T3's send modules).
3. Run **T6** after T3+T4+T5 (it needs `defineNotifications` fully wired). T6's docs half can start any time; its E2E needs the chain.
4. **Integration merge:** T1's `index.ts` already contains `export * from "./provider-console"|"./provider-resend"|"./provider-twilio"` — the three adapter files land from T2 into those slots. No task other than its owner writes any adapter file or `index.ts`. `react.tsx` is touched only by T5.

**Why `index.ts` is safe:** T1 writes the complete `index.ts` (all re-exports + full `defineNotifications`) up front, referencing symbols the critical chain (T3/T4/T5) and the adapters (T2) create. T1's package doesn't fully typecheck standalone (it references not-yet-created files) — that's expected of a skeleton; the package goes green once the chain + adapters land. The parallel tasks never touch `index.ts`, so their merges never conflict.

---

## T1 [CRITICAL-PATH] — Package skeleton: seam types, config, schema, render helpers, component registration

**Owns:** `components/notifications/{package.json,tsconfig.json}`, `src/{provider,config,schema,render,index}.ts`, `test/helpers.ts`.

### `components/notifications/package.json`

```json
{
  "name": "@stackbase/notifications", "version": "0.0.0", "private": true,
  "license": "FSL-1.1-Apache-2.0", "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js", "types": "./dist/index.d.ts",
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@stackbase/component": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": {
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@types/node": "catalog:", "tsup": "catalog:", "typescript": "catalog:", "vitest": "catalog:"
  }
}
```

Add a `tsup.config.ts` mirroring the scheduler's (single `src/index.ts` entry). If the scheduler has none and relies on a repo default, copy that exact setup. Minimal:

```ts
// components/notifications/tsup.config.ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], dts: true, clean: true, sourcemap: true });
```

> Confirm at build time whether the scheduler component ships a `tsup.config.ts`; if it does, match its options. If the workspace `tsup` is invoked without a config elsewhere, drop this file. This is the only place the plan defers to the actual scaffold.

### `components/notifications/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

### `components/notifications/src/provider.ts` — the Channel × Provider seam (types only)

```ts
/**
 * The Channel × Provider seam for `@stackbase/notifications` (Global Constraints). A CHANNEL is a
 * medium ("email"/"sms"/"in_app"); a PROVIDER is a swappable adapter for one channel. The base
 * `NotificationProvider` never leaks a driver into the engine — same philosophy as `DatabaseAdapter`
 * /`BlobStore`. Shaped auth-compatible (the `send({to,from,subject,text,html?})` email contract
 * generalizes `components/auth/src/email/provider.ts`) so N4 can unify auth onto it — N1 touches no
 * auth code.
 */

/** Every provider `send` returns this on success and THROWS on failure. */
export interface SendResult {
  providerMessageId?: string;
}

/** The wire message an email provider delivers. `templateId`/`variables` are anticipated for
 *  Loops/SES-template providers (not required in N1); `idempotencyKey` is passed through to a
 *  provider's native Idempotency-Key when supported (Resend/Loops). */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
  templateId?: string;
  variables?: Record<string, unknown>;
  idempotencyKey?: string;
}

/** The wire message an SMS provider delivers. `kind:"whatsapp"` selects WhatsApp addressing at the
 *  provider (Twilio prefixes `whatsapp:`), not a separate channel. */
export interface SmsMessage {
  to: string;
  from: string;
  body: string;
  kind?: "sms" | "whatsapp";
  idempotencyKey?: string;
}

export interface EmailProvider {
  channel: "email";
  send(m: EmailMessage): Promise<SendResult>;
}

export interface SmsProvider {
  channel: "sms";
  send(m: SmsMessage): Promise<SendResult>;
}

/** The base seam: any per-channel provider. `in_app` has no provider — the engine writes the row. */
export type NotificationProvider = EmailProvider | SmsProvider;

/** Rendered per-channel CONTENT (the output of an inline template function). Distinct from the
 *  wire *Message types above (which add `to`/`from`): content is channel payload only. */
export interface EmailContent {
  subject: string;
  text: string;
  html?: string;
}

export interface SmsPayload {
  body: string;
  kind?: "sms" | "whatsapp";
}

export interface InAppContent {
  title: string;
  body: string;
  /** Extra structured fields land on the inbox row's `data`. */
  [key: string]: unknown;
}
```

### `components/notifications/src/config.ts` — `defineNotifications` config + the send-arg shape

```ts
import type { EmailProvider, SmsProvider, EmailContent, InAppContent } from "./provider";

/** Inline typed per-channel templates (Global Constraints — not a markup engine). Keyed by
 *  templateKey; each renders channel content from the send's `data` payload. */
export type EmailTemplateFn = (data: any) => EmailContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type SmsTemplateFn = (data: any) => string; // eslint-disable-line @typescript-eslint/no-explicit-any
export type InAppTemplateFn = (data: any) => InAppContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type EmailTemplates = Record<string, EmailTemplateFn>;
export type SmsTemplates = Record<string, SmsTemplateFn>;
export type InAppTemplates = Record<string, InAppTemplateFn>;

export interface EmailChannelConfig {
  provider: EmailProvider;
  from: string;
  templates?: EmailTemplates;
}
export interface SmsChannelConfig {
  provider: SmsProvider;
  from: string;
  templates?: SmsTemplates;
}
export interface InAppChannelConfig {
  enabled: true;
  templates?: InAppTemplates;
}

export interface NotificationChannels {
  email?: EmailChannelConfig;
  sms?: SmsChannelConfig;
  in_app?: InAppChannelConfig;
}

export interface NotificationsOptions {
  channels: NotificationChannels;
  /** Queued-send sweep cadence (ms); the driver also wakes on the commit fan-out. Default 5000. */
  driverIntervalMs?: number;
}

/** Resolved config (driverIntervalMs defaulted) — closed over by the facade, modules, and driver. */
export interface NotificationsConfig {
  channels: NotificationChannels;
  driverIntervalMs: number;
}

export const DEFAULT_DRIVER_INTERVAL_MS = 5000;

export function resolveNotificationsConfig(opts: NotificationsOptions): NotificationsConfig {
  return {
    channels: opts.channels,
    driverIntervalMs: opts.driverIntervalMs ?? DEFAULT_DRIVER_INTERVAL_MS,
  };
}

/** A channel medium. */
export type Channel = "email" | "sms" | "in_app";

/** A channel-addressed recipient. `userId` for in_app; `email` for email; `phone` for sms. */
export interface Recipient {
  userId?: string;
  email?: string;
  phone?: string;
}

/** Inline content object (the non-registered-key form of `template`) — per-channel content. */
export interface InlineTemplate {
  email?: EmailContent;
  sms?: string;
  in_app?: InAppContent;
}

/** The public `ctx.notifications.send`/`sendNow` argument. */
export interface SendArgs {
  to: Recipient;
  channels: Channel[];
  template: string | InlineTemplate;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}
```

### `components/notifications/src/schema.ts` — component tables (namespaced `notifications/*`)

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

/**
 * The `@stackbase/notifications` schema (namespaced `notifications/*` when composed). All additive:
 * a project without `defineNotifications` gets none of these tables.
 *
 * `messages.payload` (RESOLVED AMBIGUITY, see the plan): the rendered per-channel content the
 * driver delivers out-of-transaction (`email {subject,text,html?}`; `sms {body,kind?}`). Templates
 * are pure functions rendered INSIDE the send mutation (deterministic, no I/O); only the rendered
 * output — never the raw template `data` (possible PII) — is persisted here. Optional/additive.
 */
export const notificationsSchema = defineSchema({
  messages: defineTable({
    channel: v.union(v.literal("email"), v.literal("sms"), v.literal("in_app")),
    to: v.string(),
    status: v.union(v.literal("queued"), v.literal("sent"), v.literal("failed")),
    providerMessageId: v.optional(v.string()),
    error: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    templateKey: v.optional(v.string()),
    dataHash: v.optional(v.string()),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    payload: v.optional(v.any()),
  })
    // Driver sweep: scan `status:"queued"` cheaply.
    .index("byStatus", ["status"])
    // Dedup diagnostics / lookups by the caller's idempotency key.
    .index("byIdempotencyKey", ["idempotencyKey"]),

  notifications: defineTable({
    userId: v.string(),
    title: v.string(),
    body: v.string(),
    data: v.optional(v.any()),
    read: v.boolean(),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
    messageId: v.string(),
  })
    // The inbox feed + unread count — keeps reactive invalidation scoped to ONE user's rows,
    // never a whole-table read-set (a full scan would re-run every user's inbox on every send).
    .index("byUser", ["userId"])
    .index("byUserUnread", ["userId", "read"]),

  sendReceipts: defineTable({
    idempotencyKey: v.string(),
    messageIds: v.array(v.string()),
    createdAt: v.number(),
  }).index("byKey", ["idempotencyKey"]),
});
```

### `components/notifications/src/render.ts` — pure render/dedup/delivery helpers

```ts
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
```

### `components/notifications/src/index.ts` — `defineNotifications` + public re-exports

```ts
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { notificationsSchema } from "./schema";
import { resolveNotificationsConfig, type NotificationsOptions } from "./config";
import { notificationsContext, notificationsActionContext } from "./facade";
import { makeSendModules } from "./modules";
import { makeInboxModules } from "./inbox";
import { notificationsDriver } from "./driver";

// Seam + config + content types (for adapter authors and N4 auth reuse).
export * from "./schema";
export type {
  SendResult, EmailMessage, SmsMessage, EmailProvider, SmsProvider, NotificationProvider,
  EmailContent, SmsPayload, InAppContent,
} from "./provider";
export type {
  NotificationsOptions, NotificationsConfig, NotificationChannels,
  EmailChannelConfig, SmsChannelConfig, InAppChannelConfig,
  EmailTemplates, SmsTemplates, InAppTemplates,
  EmailTemplateFn, SmsTemplateFn, InAppTemplateFn,
  Channel, Recipient, InlineTemplate, SendArgs,
} from "./config";
export { resolveNotificationsConfig, DEFAULT_DRIVER_INTERVAL_MS } from "./config";

// Facade types (contextType target + action facade).
export type { NotificationsContext, NotificationsActionContext } from "./facade";
export { notificationsContext, notificationsActionContext } from "./facade";

// Driver.
export type { NotificationsDriver } from "./driver";
export { notificationsDriver } from "./driver";

// Provider adapters (files land from T2a/T2b/T2c into these slots — index owns the re-export line).
export { consoleEmail, consoleSms } from "./provider-console";
export { resendEmail } from "./provider-resend";
export { twilioSms } from "./provider-twilio";

/**
 * `defineNotifications(opts)` — the `@stackbase/notifications` component: the `messages`/
 * `notifications`/`sendReceipts` schema, the `ctx.notifications` facade (`send`, mutation-side +
 * `sendNow` action-side), the internal send/inbox modules, and the queued-send driver.
 *
 * `contextWrite: true` is load-bearing: `send` writes the `messages`/`notifications`/`sendReceipts`
 * rows through the calling mutation's own transaction (like `ctx.scheduler.runAfter`), so an enqueue
 * rolls back with the mutation and fans out reactively on commit.
 *
 * The module set closes over the resolved config (providers/templates/`from`), following
 * `defineScheduler`'s config-value convention.
 */
export function defineNotifications(opts: NotificationsOptions): ComponentDefinition {
  const config = resolveNotificationsConfig(opts);
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules() },
    context: (cctx) => notificationsContext(cctx, config),
    contextType: { import: "@stackbase/notifications", type: "NotificationsContext" },
    contextWrite: true,
    buildAction: (api) => notificationsActionContext(api, config),
    driver: notificationsDriver(config),
  });
}
```

### `components/notifications/test/helpers.ts` — shared test harness (compose + runtime + capture providers)

```ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type ComponentDefinition, type Driver } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, type SchemaDefinitionJSON } from "@stackbase/values";
import { query, type RegisteredFunction } from "@stackbase/executor";
import type { EmailProvider, SmsProvider, EmailMessage, SmsMessage } from "../src/provider";

/** A privileged raw-table scan so tests can assert on the component's own namespaced tables
 *  (e.g. "notifications/messages"). Mirrors `components/scheduler/test/helpers.ts`. */
function systemModules(): Record<string, RegisteredFunction> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:scan": query(async (ctx: any, args: { table: string }) => await ctx.db.query(args.table, "by_creation").collect()),
  };
}

export interface BuiltNotifRuntime {
  runtime: EmbeddedRuntime;
  driver?: Driver & { __tick?: () => Promise<void> };
  readTable(name: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/**
 * Compose a notifications ComponentDefinition (assembled inline by each test — so a test needs only
 * its own task's files, not the full `defineNotifications`) plus optional app modules, and return a
 * live EmbeddedRuntime. Grabs the notifications driver (if the component declares one) for `__tick`.
 */
export async function makeNotifRuntime(
  component: ComponentDefinition,
  appModules: Record<string, RegisteredFunction> = {},
): Promise<BuiltNotifRuntime> {
  const schemaJson: SchemaDefinitionJSON = defineSchema({}).export();
  const composed = composeComponents({ schemaJson, moduleMap: appModules }, [component]);
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    systemModules: systemModules(), // `_system:*` is off the public `run` surface — reached via `runSystem`
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry,
    policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
    bootSteps: composed.bootSteps,
    drivers: composed.drivers,
    tableNumbers: composed.tableNumbers,
  });
  const driver = composed.drivers.find((d) => d.name === "notifications") as (Driver & { __tick?: () => Promise<void> }) | undefined;
  return {
    runtime,
    driver,
    readTable: async (name) => (await runtime.runSystem<Record<string, unknown>[]>("_system:scan", { table: name })).value ?? [],
    close: async () => { await runtime.stopDrivers(); },
  };
}

/** In-memory capture email provider (never delivers). Records every `send` for assertions. */
export function captureEmail(opts?: { fail?: boolean }): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    provider: {
      channel: "email",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new Error("capture-email forced failure");
        return { providerMessageId: `cap-${sent.length}` };
      },
    },
  };
}

/** In-memory capture SMS provider. */
export function captureSms(opts?: { fail?: boolean }): { sent: SmsMessage[]; provider: SmsProvider } {
  const sent: SmsMessage[] = [];
  return {
    sent,
    provider: {
      channel: "sms",
      async send(m) {
        sent.push(m);
        if (opts?.fail) throw new Error("capture-sms forced failure");
        return { providerMessageId: `sms-${sent.length}` };
      },
    },
  };
}
```

> `runtime.run(path, args, { identity? })` returns a `UdfResult<T>` — read `.value`. `_system:*` is off the public `run` surface (it throws `isInternalPath`), so `readTable` uses `runtime.runSystem` (privileged), exactly as `components/scheduler/test/helpers.ts`'s `readTable` does (`runtime.runSystem<unknown[]>("_system:scan", { table })` → `.value`). The `_system:scan`/`by_creation` idiom is copied verbatim from that file.

**Verify (T1):** `bun run --filter @stackbase/notifications typecheck` will fail only on the not-yet-created `./facade`/`./modules`/`./inbox`/`./driver`/`./provider-*` imports in `index.ts` — expected. `provider.ts`/`config.ts`/`schema.ts`/`render.ts` typecheck standalone.

---

## T2a [PARALLELIZABLE] — `consoleEmail` + `consoleSms` dev providers

**Owns:** `src/provider-console.ts`, `test/provider-console.test.ts`. Imports seam types from `../src/provider` **directly** (not the package index). Touches no other file.

### `components/notifications/src/provider-console.ts`

```ts
import type { EmailProvider, SmsProvider } from "./provider";

/** Zero-config dev default: logs the full email (incl. any code/link) to the server console.
 *  Generalizes `components/auth/src/email/provider.ts`'s `consoleEmail` (auth's copy is untouched). */
export function consoleEmail(): EmailProvider {
  return {
    channel: "email",
    async send(m) {
      console.log(
        `\n[stackbase notifications] email →\n  to:      ${m.to}\n  from:    ${m.from}\n  subject: ${m.subject}\n  ${m.text.replace(/\n/g, "\n  ")}\n`,
      );
      return {};
    },
  };
}

/** Zero-config dev SMS provider: logs the message to the server console (no delivery). */
export function consoleSms(): SmsProvider {
  return {
    channel: "sms",
    async send(m) {
      const kind = m.kind === "whatsapp" ? "whatsapp" : "sms";
      console.log(`\n[stackbase notifications] ${kind} →\n  to:   ${m.to}\n  from: ${m.from}\n  ${m.body.replace(/\n/g, "\n  ")}\n`);
      return {};
    },
  };
}
```

### `components/notifications/test/provider-console.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { consoleEmail, consoleSms } from "../src/provider-console";

describe("console providers", () => {
  it("consoleEmail logs the email and returns an empty SendResult", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await consoleEmail().send({ to: "a@b.test", from: "no-reply@x", subject: "Hi", text: "line1\nline2" });
      expect(res).toEqual({});
      expect(spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("stackbase notifications] email") && a.includes("a@b.test") && a.includes("Hi")))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("consoleSms logs whatsapp-kind messages distinctly", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await consoleSms().send({ to: "+1555", from: "+1999", body: "yo", kind: "whatsapp" });
      expect(spy.mock.calls.some((args) => args.some((a) => typeof a === "string" && a.includes("whatsapp →") && a.includes("+1555")))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
```

---

## T2b [PARALLELIZABLE] — `resendEmail` provider (native Idempotency-Key passthrough)

**Owns:** `src/provider-resend.ts`, `test/provider-resend.test.ts`. Imports `../src/provider` only.

### `components/notifications/src/provider-resend.ts`

```ts
import type { EmailProvider, EmailMessage, SendResult } from "./provider";

/** Production email adapter: ONE fetch to the Resend API, zero deps, throws on non-2xx. Passes the
 *  send's `idempotencyKey` through to Resend's native `Idempotency-Key` header (one of the 2/8
 *  providers with native support). Generalizes `components/auth`'s `resendEmail` (auth untouched). */
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
        throw new Error(`resend send failed (${res.status}): ${body}`);
      }
      const json = (await res.json().catch(() => ({}))) as { id?: string };
      return { providerMessageId: json.id };
    },
  };
}
```

### `components/notifications/test/provider-resend.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { resendEmail } from "../src/provider-resend";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, json: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => "err-body", json: async () => json } as unknown as Response;
  }));
  return { calls };
}

describe("resendEmail", () => {
  it("POSTs to /emails with auth, JSON body, and returns the provider id", async () => {
    const { calls } = mockFetch(200, { id: "re_123" });
    const res = await resendEmail({ apiKey: "KEY" }).send({ to: "a@b.test", from: "x@y", subject: "S", text: "T", html: "<b>T</b>" });
    expect(res).toEqual({ providerMessageId: "re_123" });
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer KEY");
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ from: "x@y", to: "a@b.test", subject: "S", text: "T", html: "<b>T</b>" });
  });

  it("passes idempotencyKey through as the Idempotency-Key header", async () => {
    const { calls } = mockFetch(200, { id: "re_9" });
    await resendEmail({ apiKey: "KEY" }).send({ to: "a@b.test", from: "x@y", subject: "S", text: "T", idempotencyKey: "otp-42" });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("otp-42");
  });

  it("throws on non-2xx", async () => {
    mockFetch(422, { message: "bad" });
    await expect(resendEmail({ apiKey: "KEY" }).send({ to: "a@b", from: "x@y", subject: "S", text: "T" })).rejects.toThrow(/resend send failed \(422\)/);
  });
});
```

---

## T2c [PARALLELIZABLE] — `twilioSms` provider (SMS + WhatsApp addressing)

**Owns:** `src/provider-twilio.ts`, `test/provider-twilio.test.ts`. Imports `../src/provider` only.

### `components/notifications/src/provider-twilio.ts`

```ts
import type { SmsProvider, SmsMessage, SendResult } from "./provider";

/** Production SMS adapter: ONE fetch to the Twilio Messages API (Basic auth, form-encoded), throws
 *  on non-2xx. `kind:"whatsapp"` prefixes both `To`/`From` with `whatsapp:` (WhatsApp addressing at
 *  the provider, not a separate channel). Twilio's basic API has no native idempotency key, so
 *  `idempotencyKey` is NOT forwarded — the orchestrator's `sendReceipts` owns dedup (2/8 providers). */
export function twilioSms(opts: { accountSid: string; authToken: string; baseUrl?: string }): SmsProvider {
  const base = opts.baseUrl ?? "https://api.twilio.com";
  return {
    channel: "sms",
    async send(m: SmsMessage): Promise<SendResult> {
      const to = m.kind === "whatsapp" ? `whatsapp:${m.to}` : m.to;
      const from = m.kind === "whatsapp" ? `whatsapp:${m.from}` : m.from;
      const basic = Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64");
      const form = new URLSearchParams({ To: to, From: from, Body: m.body });
      const res = await fetch(`${base}/2010-04-01/Accounts/${opts.accountSid}/Messages.json`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`twilio send failed (${res.status}): ${body}`);
      }
      const json = (await res.json().catch(() => ({}))) as { sid?: string };
      return { providerMessageId: json.sid };
    },
  };
}
```

### `components/notifications/test/provider-twilio.test.ts`

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { twilioSms } from "../src/provider-twilio";

afterEach(() => vi.unstubAllGlobals());

function mockFetch(status: number, json: unknown): { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => "err", json: async () => json } as unknown as Response;
  }));
  return { calls };
}

describe("twilioSms", () => {
  it("POSTs form-encoded to the Messages endpoint with Basic auth and returns the sid", async () => {
    const { calls } = mockFetch(201, { sid: "SM123" });
    const res = await twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1555", from: "+1999", body: "hi" });
    expect(res).toEqual({ providerMessageId: "SM123" });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC1/Messages.json");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("To")).toBe("+1555");
    expect(form.get("From")).toBe("+1999");
    expect(form.get("Body")).toBe("hi");
  });

  it("prefixes whatsapp: on both To and From for kind:whatsapp", async () => {
    const { calls } = mockFetch(201, { sid: "SM9" });
    await twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1555", from: "+1999", body: "hi", kind: "whatsapp" });
    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get("To")).toBe("whatsapp:+1555");
    expect(form.get("From")).toBe("whatsapp:+1999");
  });

  it("throws on non-2xx", async () => {
    mockFetch(400, { message: "bad" });
    await expect(twilioSms({ accountSid: "AC1", authToken: "tok" }).send({ to: "+1", from: "+2", body: "x" })).rejects.toThrow(/twilio send failed \(400\)/);
  });
});
```

---

## T3 [CRITICAL-PATH] — Send facade + record modules (messages/inbox/receipt) + `ctx.notifications`

**Owns:** `src/facade.ts`, `src/modules.ts`, `test/send.test.ts`.

### `components/notifications/src/modules.ts`

```ts
import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction, type GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs, Channel } from "./config";
import type { EmailContent, SmsPayload, SendResult } from "./provider";
import { compact, stableHash, renderEmail, renderSms, renderInApp, deliverOutbound, type DeliverEntry } from "./render";

/** Cap on queued rows a single driver pass drains (bounded work per iteration). */
export const BATCH_CAP = 64;

/** A queued email/SMS row the driver delivers (returned by `_peekQueued`). */
export interface QueuedMessage {
  _id: string;
  channel: "email" | "sms";
  to: string;
  payload: EmailContent | SmsPayload;
  idempotencyKey?: string;
}

/** A rendered-but-not-yet-sent email/SMS the `sendNow` action delivers, carrying the meta
 *  `_finishNow` needs to persist a final `messages` row. */
export interface NowOutbound extends DeliverEntry {
  templateKey?: string;
  dataHash?: string;
}

/** A delivered `sendNow` outcome the action passes back to `_finishNow`. */
export interface NowDelivery extends NowOutbound {
  status: "sent" | "failed";
  providerMessageId?: string;
  error?: string;
}

export interface PrepareNowResult {
  deduped: boolean;
  messageIds: string[];
  outbound: NowOutbound[];
}

function resolveAddress(channel: Channel, to: SendArgs["to"]): string {
  if (channel === "email") { if (!to.email) throw new Error(`send: channel "email" requires to.email`); return to.email; }
  if (channel === "sms") { if (!to.phone) throw new Error(`send: channel "sms" requires to.phone`); return to.phone; }
  if (!to.userId) throw new Error(`send: channel "in_app" requires to.userId`);
  return to.userId;
}

function assertConfigured(config: NotificationsConfig, channel: Channel): void {
  if (channel === "email" && !config.channels.email) throw new Error(`send: "email" channel is not configured on defineNotifications`);
  if (channel === "sms" && !config.channels.sms) throw new Error(`send: "sms" channel is not configured on defineNotifications`);
  if (channel === "in_app" && !config.channels.in_app) throw new Error(`send: "in_app" channel is not configured on defineNotifications`);
}

/**
 * THE shared QUEUE-mode record path — used by both `ctx.notifications.send` (the mutation facade,
 * `facade.ts`) and the `_enqueueSend` internal mutation (the action facade). Writes one `messages`
 * row per channel; for `in_app` also the `notifications` inbox row (status `sent`, instant); for
 * email/SMS the row is `queued` (+ rendered `payload`) for the driver. Records a `sendReceipts` row
 * keyed by `idempotencyKey` in the SAME transaction — a replay short-circuits to the recorded ids.
 *
 * Runs NAMESPACED (bare table names resolve to `notifications/*`) — this is called from the
 * calling mutation's own transaction (the facade's `contextWrite: true` db) or a namespaced internal
 * mutation, never privileged. The `db.query("sendReceipts", "byKey")` read is what makes single-
 * writer OCC catch a concurrent duplicate: the second committer re-validates a now-stale empty read
 * and retries, seeing the winner's receipt (the scheduler `by_idempotency` insert-or-noop discipline).
 */
export async function recordSend(db: GuestDatabaseWriter, now: number, config: NotificationsConfig, args: SendArgs): Promise<{ messageIds: string[]; deduped: boolean }> {
  if (args.idempotencyKey !== undefined) {
    const [existing] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", args.idempotencyKey).take(1).collect();
    if (existing) return { messageIds: existing.messageIds as string[], deduped: true };
  }
  const dataHash = stableHash(args.data);
  const templateKey = typeof args.template === "string" ? args.template : undefined;
  const messageIds: string[] = [];

  for (const channel of args.channels) {
    assertConfigured(config, channel);
    const to = resolveAddress(channel, args.to);
    if (channel === "in_app") {
      const content = renderInApp(config, args.template, args.data);
      const { title, body, ...structured } = content;
      const messageId = (await db.insert("messages", compact({
        channel: "in_app", to, status: "sent", createdAt: now, sentAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash,
      }))) as string;
      await db.insert("notifications", compact({
        userId: to, title, body,
        data: Object.keys(structured).length > 0 ? structured : args.data,
        read: false, createdAt: now, messageId,
      }));
      messageIds.push(messageId);
    } else {
      const payload: EmailContent | SmsPayload = channel === "email" ? renderEmail(config, args.template, args.data) : renderSms(config, args.template, args.data);
      const messageId = (await db.insert("messages", compact({
        channel, to, status: "queued", createdAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash, payload,
      }))) as string;
      messageIds.push(messageId);
    }
  }

  if (args.idempotencyKey !== undefined) {
    await db.insert("sendReceipts", { idempotencyKey: args.idempotencyKey, messageIds, createdAt: now });
  }
  return { messageIds, deduped: false };
}

/**
 * The `sendNow` two-phase path, phase 1: dedup check + write `in_app` rows instantly + RENDER
 * email/SMS content WITHOUT persisting a row (so the queued-sweep driver never sees them). Writes
 * the receipt (with the in_app ids) up front so a concurrent same-key `sendNow` dedups under OCC;
 * `_finishNow` appends the email/SMS ids to that receipt after delivery.
 */
async function prepareNow(db: GuestDatabaseWriter, now: number, config: NotificationsConfig, args: SendArgs): Promise<PrepareNowResult> {
  if (args.idempotencyKey !== undefined) {
    const [existing] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", args.idempotencyKey).take(1).collect();
    if (existing) return { deduped: true, messageIds: existing.messageIds as string[], outbound: [] };
  }
  const dataHash = stableHash(args.data);
  const templateKey = typeof args.template === "string" ? args.template : undefined;
  const messageIds: string[] = [];
  const outbound: NowOutbound[] = [];

  for (const channel of args.channels) {
    assertConfigured(config, channel);
    const to = resolveAddress(channel, args.to);
    if (channel === "in_app") {
      const content = renderInApp(config, args.template, args.data);
      const { title, body, ...structured } = content;
      const messageId = (await db.insert("messages", compact({
        channel: "in_app", to, status: "sent", createdAt: now, sentAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash,
      }))) as string;
      await db.insert("notifications", compact({
        userId: to, title, body, data: Object.keys(structured).length > 0 ? structured : args.data, read: false, createdAt: now, messageId,
      }));
      messageIds.push(messageId);
    } else {
      const payload: EmailContent | SmsPayload = channel === "email" ? renderEmail(config, args.template, args.data) : renderSms(config, args.template, args.data);
      outbound.push({ channel, to, payload, idempotencyKey: args.idempotencyKey, templateKey, dataHash });
    }
  }
  if (args.idempotencyKey !== undefined) {
    await db.insert("sendReceipts", { idempotencyKey: args.idempotencyKey, messageIds, createdAt: now });
  }
  return { deduped: false, messageIds, outbound };
}

/** `sendNow` phase 2: persist FINAL email/SMS `messages` rows (never queued → driver never touches
 *  them) and append their ids to the receipt. */
async function finishNow(db: GuestDatabaseWriter, now: number, deliveries: NowDelivery[], idempotencyKey: string | undefined): Promise<{ messageIds: string[] }> {
  const messageIds: string[] = [];
  for (const d of deliveries) {
    const id = (await db.insert("messages", compact({
      channel: d.channel, to: d.to, status: d.status, createdAt: now,
      sentAt: d.status === "sent" ? now : undefined,
      providerMessageId: d.providerMessageId, error: d.error,
      idempotencyKey, templateKey: d.templateKey, dataHash: d.dataHash, payload: d.payload,
    }))) as string;
    messageIds.push(id);
  }
  if (idempotencyKey !== undefined && messageIds.length > 0) {
    const [receipt] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", idempotencyKey).take(1).collect();
    if (receipt) await db.replace(receipt._id as string, { ...receipt, messageIds: [...(receipt.messageIds as string[]), ...messageIds] });
  }
  return { messageIds };
}

/**
 * The send-side module set (registered `notifications:_enqueueSend`/`_prepareNow`/`_finishNow`/
 * `_peekQueued`/`_markResult`). All `_`-prefixed → not client-callable; reachable from the action
 * facade via `api.runMutation` (namespaced) and from the driver via `runFunction` (privileged).
 */
export function makeSendModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // Action-facade `send` delegate — namespaced, bare tables (recordSend).
  const _enqueueSend = mutation(async (ctx: MutationCtx, args: SendArgs): Promise<{ messageIds: string[] }> => {
    const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, args);
    return { messageIds: r.messageIds };
  });

  const _prepareNow = mutation(async (ctx: MutationCtx, args: SendArgs): Promise<PrepareNowResult> =>
    prepareNow(ctx.db as GuestDatabaseWriter, ctx.now(), config, args));

  const _finishNow = mutation(async (ctx: MutationCtx, args: { deliveries: NowDelivery[]; idempotencyKey?: string }): Promise<{ messageIds: string[] }> =>
    finishNow(ctx.db as GuestDatabaseWriter, ctx.now(), args.deliveries, args.idempotencyKey));

  // Driver-facing pair — PRIVILEGED (fully-qualified "notifications/messages"). See the scheduler's
  // modules.ts module doc comment: privileged calls bypass namespace prefixing.
  const _peekQueued = query(async (ctx: QueryCtx): Promise<QueuedMessage[]> => {
    const rows = await ctx.db.query("notifications/messages", "byStatus").eq("status", "queued").take(BATCH_CAP).collect();
    return rows
      .filter((r) => r.channel === "email" || r.channel === "sms") // defensive: in_app is never queued
      .map((r) => ({ _id: r._id as string, channel: r.channel as "email" | "sms", to: r.to as string, payload: r.payload as EmailContent | SmsPayload, idempotencyKey: r.idempotencyKey as string | undefined }));
  });

  const _markResult = mutation(async (ctx: MutationCtx, args: { messageId: string; ok: boolean; providerMessageId?: string; error?: string }): Promise<null> => {
    const row = await ctx.db.get(args.messageId);
    if (row === null || row.status !== "queued") return null; // gone or already finalized — defensive
    const now = ctx.now();
    if (args.ok) {
      await ctx.db.replace(args.messageId, compact({ ...row, status: "sent", sentAt: now, providerMessageId: args.providerMessageId, error: undefined }));
    } else {
      await ctx.db.replace(args.messageId, compact({ ...row, status: "failed", error: args.error ?? "send failed" }));
    }
    return null;
  });

  return { _enqueueSend, _prepareNow, _finishNow, _peekQueued, _markResult };
}

// Re-export the delivery dispatcher + result type so the facade's `sendNow` and the driver share the
// single provider-resolution path.
export { deliverOutbound };
export type { SendResult, DeliverEntry };
```

### `components/notifications/src/facade.ts`

```ts
import type { ComponentContext, ActionApi, GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, SendArgs } from "./config";
import type { SendResult } from "./provider";
import { recordSend, deliverOutbound, type PrepareNowResult, type NowDelivery } from "./modules";

/** `ctx.notifications` in a MUTATION (and query, for `identity()`). `send` writes the messages/inbox/
 *  receipt rows through the calling mutation's own transaction (contextWrite). `identity()` exposes
 *  the ambient caller token as the inbox fallback recipient id (see `inbox.ts`). */
export interface NotificationsContext {
  send(args: SendArgs): Promise<{ messageIds: string[] }>;
  identity(): string | null;
}

export function notificationsContext(cctx: ComponentContext, config: NotificationsConfig): NotificationsContext {
  return {
    async send(args) {
      const r = await recordSend(cctx.db as GuestDatabaseWriter, cctx.now, config, args);
      return { messageIds: r.messageIds };
    },
    identity: () => cctx.identity,
  };
}

/** `ctx.notifications` in an ACTION. `send` delegates to the internal `_enqueueSend` mutation (fresh
 *  top-level txn) — same fire-and-forget queued semantics as the mutation facade. `sendNow` delivers
 *  email/SMS synchronously (network in an action is allowed), returning the provider results. The
 *  two-phase `_prepareNow`/`_finishNow` guarantees at-most-once (dedup precedes the live send) and
 *  never leaves a driver-visible queued row. Portable method signatures mirror `NotificationsContext`
 *  (a `send` call is portable between a mutation and an action). */
export interface NotificationsActionContext {
  send(args: SendArgs): Promise<{ messageIds: string[] }>;
  sendNow(args: SendArgs): Promise<{ messageIds: string[]; results: SendResult[] }>;
}

export function notificationsActionContext(api: ActionApi, config: NotificationsConfig): NotificationsActionContext {
  return {
    async send(args) {
      return api.runMutation<{ messageIds: string[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
    },
    async sendNow(args) {
      const prep = await api.runMutation<PrepareNowResult>("notifications:_prepareNow", args as unknown as Record<string, unknown>);
      if (prep.deduped) return { messageIds: prep.messageIds, results: [] };
      const results: SendResult[] = [];
      const deliveries: NowDelivery[] = [];
      for (const o of prep.outbound) {
        try {
          const res = await deliverOutbound(config, o);
          results.push(res);
          deliveries.push({ ...o, status: "sent", providerMessageId: res.providerMessageId });
        } catch (e) {
          deliveries.push({ ...o, status: "failed", error: String(e) });
        }
      }
      const fin = await api.runMutation<{ messageIds: string[] }>("notifications:_finishNow", { deliveries, idempotencyKey: args.idempotencyKey } as unknown as Record<string, unknown>);
      return { messageIds: [...prep.messageIds, ...fin.messageIds], results };
    },
  };
}
```

### `components/notifications/test/send.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, captureEmail, type BuiltNotifRuntime } from "./helpers";

// Assemble a driver-less notifications component (send path only) so this test needs only T1+T3.
function sendOnlyComponent(): { component: ComponentDefinition; captured: ReturnType<typeof captureEmail> } {
  const captured = captureEmail();
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: captured.provider, from: "no-reply@test", templates: { welcome: () => ({ subject: "Welcome", text: "hi" }) } },
      in_app: { enabled: true, templates: { welcome: () => ({ title: "Welcome", body: "hi there", kind: "greeting" }) } },
    },
  });
  const component = defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
  });
  return { component, captured };
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("ctx.notifications.send — record path", () => {
  it("writes a messages row per channel; in_app also writes the inbox row instantly", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const res = (await built.runtime.run("app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["in_app", "email"], template: "welcome", data: { name: "Ann" },
    })).value as { messageIds: string[] };
    expect(res.messageIds.length).toBe(2);

    const messages = await built.readTable("notifications/messages");
    expect(messages.map((m) => `${m.channel}:${m.status}`).sort()).toEqual(["email:queued", "in_app:sent"]);

    const inbox = await built.readTable("notifications/notifications");
    expect(inbox.length).toBe(1);
    expect(inbox[0]).toMatchObject({ userId: "u1", title: "Welcome", body: "hi there", read: false });

    // email row carries the rendered payload for the driver; nothing sent yet (no driver here).
    const emailRow = messages.find((m) => m.channel === "email")!;
    expect(emailRow.payload).toEqual({ subject: "Welcome", text: "hi" });
  });

  it("is transactional — a mutation that throws after send leaves no rows", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:boom": mutation(async (ctx: any) => { await ctx.notifications.send({ to: { userId: "u1" }, channels: ["in_app"], template: "welcome" }); throw new Error("rollback"); }),
    });
    await expect(built.runtime.run("app:boom", {})).rejects.toThrow(/rollback/);
    expect((await built.readTable("notifications/messages")).length).toBe(0);
    expect((await built.readTable("notifications/notifications")).length).toBe(0);
  });

  it("idempotency: a replay with the same key returns the recorded ids and writes no new rows", async () => {
    const { component } = sendOnlyComponent();
    built = await makeNotifRuntime(component, appModules);
    const a = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "welcome", idempotencyKey: "otp-1" })).value as { messageIds: string[] };
    const b = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "welcome", idempotencyKey: "otp-1" })).value as { messageIds: string[] };
    expect(b.messageIds).toEqual(a.messageIds);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
    expect((await built.readTable("notifications/sendReceipts")).length).toBe(1);
  });

  it("rejects a channel that is not configured", async () => {
    const { component } = sendOnlyComponent(); // no sms channel
    built = await makeNotifRuntime(component, appModules);
    await expect(built.runtime.run("app:send", { to: { phone: "+1" }, channels: ["sms"], template: "welcome" })).rejects.toThrow(/"sms" channel is not configured/);
  });
});
```

---

## T4 [CRITICAL-PATH] — Queued-send driver (deliver email/SMS outside the transaction)

**Owns:** `src/driver.ts`, `test/driver.test.ts`. References `notifications:_peekQueued`/`_markResult` (T3 `modules.ts`) by path string.

### `components/notifications/src/driver.ts`

```ts
import type { Driver, DriverContext } from "@stackbase/component";
import type { NotificationsConfig } from "./config";
import { deliverOutbound } from "./render";
import type { QueuedMessage } from "./modules";

/** `notificationsDriver()` exposes `__tick` — a deterministic test seam: one drain pass, awaiting
 *  its real completion, errors propagating (unlike the timer/onCommit path, which swallows+logs).
 *  Mirrors `SchedulerDriver.__tick` / `receiptsReaper.__tick`. */
export interface NotificationsDriver extends Driver {
  __tick: () => Promise<void>;
}

/**
 * The queued-send driver — delivers `status:"queued"` email/SMS `messages` rows via the configured
 * provider OUTSIDE any transaction, then flips each `queued → sent`/`failed`. Two wake sources (the
 * scheduler/reaper pattern): the commit fan-out (`onCommit`, any `notifications/*` write) and a
 * wall-clock timer at `driverIntervalMs`. A single in-process `running` flag serializes passes so a
 * commit racing the timer can't double-dispatch the same row; a wake landing mid-pass sets
 * `pendingWake` so the pass loops once more with a fresh peek instead of stranding a just-enqueued
 * row. `stopped` (set before teardown) prevents any settling pass from re-arming after `stop()`.
 *
 * N1 boundary (per spec): a failed provider send is TERMINAL (`failed`); retries are N2. A driver
 * crash mid-send leaves the row `queued` (re-delivered on restart — "retried once in N2"); a
 * message is marked `sent` only AFTER `provider.send` returns. Fleet multi-driver dedup and mid-send
 * reclaim are N2 (this driver is single-node).
 */
export function notificationsDriver(config: NotificationsConfig): NotificationsDriver {
  let ctx: DriverContext;
  let running = false;
  let pendingWake = false;
  let timer: number | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let unsubscribeCommit: (() => void) | null = null;

  function wake(): void {
    if (stopped) return;
    iterate().catch((e: unknown) => console.error("[notifications] driver iteration failed:", e));
  }

  function iterate(): Promise<void> {
    if (running) { pendingWake = true; return inFlight ?? Promise.resolve(); }
    running = true;
    const pass = runPass().finally(() => {
      running = false;
      inFlight = null;
      if (pendingWake) void wake();
    });
    inFlight = pass;
    return pass;
  }

  async function runPass(): Promise<void> {
    do {
      pendingWake = false;
      const queued = (await ctx.runFunction("notifications:_peekQueued", {})) as QueuedMessage[];
      for (const m of queued) {
        let ok = false;
        let providerMessageId: string | undefined;
        let error: string | undefined;
        try {
          const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, idempotencyKey: m.idempotencyKey });
          ok = true;
          providerMessageId = res.providerMessageId;
        } catch (e) {
          error = String(e);
        }
        await ctx.runFunction("notifications:_markResult", { messageId: m._id, ok, providerMessageId, error });
      }
    } while (pendingWake);
    armTimer();
  }

  function armTimer(): void {
    if (stopped) return;
    if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    timer = ctx.setTimer(ctx.now() + config.driverIntervalMs, wake);
  }

  return {
    name: "notifications",
    start(c) {
      ctx = c;
      unsubscribeCommit = c.onCommit((inv) => { if (inv.tables.some((t) => t.startsWith("notifications/"))) wake(); });
      wake();
      armTimer();
    },
    stop() {
      stopped = true;
      unsubscribeCommit?.();
      unsubscribeCommit = null;
      if (timer !== null) { ctx.clearTimer(timer); timer = null; }
    },
    __tick: () => iterate(),
  };
}
```

> `_markResult`'s args (`providerMessageId`/`error` possibly `undefined`) cross the trusted `runFunction` boundary. `undefined` object properties are dropped by the JSON syscall codec, so `_markResult` reads them as absent — its `compact` handles that. Confirm `runFunction`'s arg serialization drops `undefined` (it does — same codec as every other syscall); if it rejects top-level `undefined` values, omit them at the call site with a `compact`-style spread. Match the scheduler driver's `runFunction` arg shape.

### `components/notifications/test/driver.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { notificationsDriver } from "../src/driver";
import { makeNotifRuntime, captureEmail, type BuiltNotifRuntime } from "./helpers";

function driverComponent(fail = false): { component: ComponentDefinition; captured: ReturnType<typeof captureEmail> } {
  const captured = captureEmail({ fail });
  const config = resolveNotificationsConfig({
    channels: { email: { provider: captured.provider, from: "no-reply@test", templates: { hi: () => ({ subject: "S", text: "T" }) } } },
    driverIntervalMs: 10_000, // long — the test drives via __tick, not the timer
  });
  const component = defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
    driver: notificationsDriver(config),
  });
  return { component, captured };
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications driver — queued-send delivery", () => {
  it("delivers a queued email and marks the row sent with the provider id", async () => {
    const { component, captured } = driverComponent();
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });

    await (built.driver as { __tick: () => Promise<void> }).__tick();

    expect(captured.sent.length).toBe(1);
    expect(captured.sent[0]).toMatchObject({ to: "u@test", from: "no-reply@test", subject: "S", text: "T" });
    const rows = await built.readTable("notifications/messages");
    expect(rows[0]).toMatchObject({ status: "sent", providerMessageId: "cap-1" });
  });

  it("marks the row failed (terminal in N1) when the provider throws", async () => {
    const { component, captured } = driverComponent(true);
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.sent.length).toBe(1);
    const rows = await built.readTable("notifications/messages");
    expect(rows[0]!.status).toBe("failed");
    expect(String(rows[0]!.error)).toContain("forced failure");
  });

  it("a second tick does not re-deliver an already-sent row", async () => {
    const { component, captured } = driverComponent();
    built = await makeNotifRuntime(component, appModules);
    await built.runtime.run("app:send", { to: { email: "u@test" }, channels: ["email"], template: "hi" });
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.sent.length).toBe(1); // _peekQueued only returns "queued"; the row is now "sent"
  });
});
```

---

## T5 [CRITICAL-PATH] — Reactive inbox modules + ownership-checked markRead + React `useNotifications`/`<Inbox>`

**Owns:** `src/inbox.ts`, `test/inbox.test.ts`, `packages/client/src/notifications.tsx` (new), `packages/client/src/react.tsx` (append re-exports).

### `components/notifications/src/inbox.ts`

```ts
import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import { compact } from "./render";

/** An inbox row as returned to the client. */
export interface InboxItem {
  _id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  readAt?: number;
  createdAt: number;
  messageId: string;
}

/** Default inbox page size. */
export const DEFAULT_INBOX_LIMIT = 50;

/**
 * Resolve the caller's own user id for in-app authorization: `ctx.auth.getUserId()` when auth is
 * composed (the facade is attached to every ctx), else the raw ambient identity via THIS component's
 * own `ctx.notifications.identity()` facade (also attached to every ctx). A user can therefore only
 * ever read/mutate their own inbox — the recipient id is never a client-supplied argument.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callerId(ctx: any): Promise<string | null> {
  const viaAuth = ctx.auth ? await ctx.auth.getUserId() : null;
  if (viaAuth) return viaAuth as string;
  return (ctx.notifications?.identity?.() as string | null) ?? null;
}

export function makeInboxModules(): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inbox = query(async (ctx: any, args: { limit?: number }): Promise<InboxItem[]> => {
    const userId = await callerId(ctx);
    if (!userId) return [];
    const rows = await (ctx as QueryCtx).db
      .query("notifications", "byUser")
      .eq("userId", userId)
      .order("desc")
      .take(args?.limit ?? DEFAULT_INBOX_LIMIT)
      .collect();
    return rows.map((r) => ({
      _id: r._id as string,
      title: r.title as string,
      body: r.body as string,
      data: r.data as Record<string, unknown> | undefined,
      read: r.read as boolean,
      readAt: r.readAt as number | undefined,
      createdAt: r.createdAt as number,
      messageId: r.messageId as string,
    }));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unreadCount = query(async (ctx: any): Promise<number> => {
    const userId = await callerId(ctx);
    if (!userId) return 0;
    const rows = await (ctx as QueryCtx).db.query("notifications", "byUserUnread").eq("userId", userId).eq("read", false).collect();
    return rows.length;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markRead = mutation(async (ctx: any, args: { id: string }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const row = await (ctx as MutationCtx).db.get(args.id);
    // Ownership check: a missing or foreign row is a not-found reject — a user can't touch another's inbox.
    if (!row || (row.userId as string) !== userId) throw new Error("notification not found");
    if (row.read !== true) await (ctx as MutationCtx).db.replace(args.id, compact({ ...row, read: true, readAt: ctx.now() }));
    return null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markAllRead = mutation(async (ctx: any): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const now = ctx.now();
    const rows = await (ctx as MutationCtx).db.query("notifications", "byUserUnread").eq("userId", userId).eq("read", false).collect();
    for (const r of rows) await (ctx as MutationCtx).db.replace(r._id as string, compact({ ...r, read: true, readAt: now }));
    return null;
  });

  return { inbox, unreadCount, markRead, markAllRead };
}
```

### `packages/client/src/notifications.tsx` — the typed React inbox helper

```tsx
/**
 * `useNotifications()` / `<Inbox>` — the typed reactive in-app inbox helper (Global Constraints:
 * "the reactive in-app inbox is the flagship"). Wraps the well-known `@stackbase/notifications`
 * component query/mutation paths (`notifications:inbox`/`unreadCount`/`markRead`/`markAllRead`) so
 * consumers get a live feed + unread count + typed mark-read callbacks with zero per-app codegen.
 * Component functions aren't in an app's generated `Api`, so typing lives HERE (well-known paths),
 * while the server-side `ctx.notifications.send` is typed via the component's `contextType`
 * augmentation.
 */
import type { ReactNode } from "react";
import { useQuery, useMutation } from "./react";

/** An inbox row as delivered to the UI (mirrors the server `InboxItem`). */
export interface InboxNotification {
  _id: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  readAt?: number;
  createdAt: number;
  messageId: string;
}

export interface UseNotificationsResult {
  notifications: InboxNotification[];
  unreadCount: number;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

const INBOX_PATH = "notifications:inbox";
const UNREAD_PATH = "notifications:unreadCount";
const MARK_READ_PATH = "notifications:markRead";
const MARK_ALL_PATH = "notifications:markAllRead";

/** Live inbox feed + unread count + mark-read callbacks. `undefined` first-frame results coalesce to
 *  `[]`/`0` so consumers never branch on the loading sentinel. */
export function useNotifications(opts?: { limit?: number }): UseNotificationsResult {
  const notifications = useQuery<InboxNotification[]>(INBOX_PATH, { limit: opts?.limit ?? 50 }) ?? [];
  const unreadCount = useQuery<number>(UNREAD_PATH, {}) ?? 0;
  const markReadFn = useMutation<null>(MARK_READ_PATH);
  const markAllFn = useMutation<null>(MARK_ALL_PATH);
  return {
    notifications,
    unreadCount,
    markRead: async (id: string) => { await markReadFn({ id }); },
    markAllRead: async () => { await markAllFn({}); },
  };
}

export interface InboxProps {
  limit?: number;
  /** Render prop — headless: you own the markup, we own the reactive data + callbacks. */
  children: (state: UseNotificationsResult) => ReactNode;
}

/** A headless `<Inbox>` render helper: `<Inbox>{({ notifications, unreadCount, markRead }) => …}</Inbox>`. */
export function Inbox(props: InboxProps): ReactNode {
  return props.children(useNotifications({ limit: props.limit }));
}
```

### `packages/client/src/react.tsx` — append these lines at the end

```tsx
// Reactive in-app inbox helper (@stackbase/notifications) — see ./notifications.
export { useNotifications, Inbox } from "./notifications";
export type { InboxNotification, UseNotificationsResult, InboxProps } from "./notifications";
```

### `components/notifications/test/inbox.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeInboxModules } from "../src/inbox";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function inboxComponent(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { in_app: { enabled: true, templates: { note: (d: { body: string }) => ({ title: "Note", body: d.body }) } } },
  });
  return defineComponent({
    name: "notifications",
    schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeInboxModules() },
    context: (cctx) => notificationsContext(cctx, config),
    contextWrite: true,
  });
}

// App mutation to send an in_app notification to an explicit user (server-controlled recipient).
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:notify": mutation(async (ctx: any, args: { userId: string; body: string }) =>
    ctx.notifications.send({ to: { userId: args.userId }, channels: ["in_app"], template: "note", data: { body: args.body } })),
};

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

// No auth composed → callerId falls back to ctx.notifications.identity() (the ambient token). The
// runtime `run` invoke sets identity; use runtime.run with an identity option to model the caller.
async function runAs(identity: string | null, path: string, args: Record<string, unknown>): Promise<unknown> {
  return (await built.runtime.run(path, args, { identity })).value;
}

describe("notifications inbox — reactive feed + ownership", () => {
  it("inbox returns only the caller's rows; unread count is correct; markRead flips read", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    // Server sends to u1 and u2.
    await built.runtime.run("app:notify", { userId: "u1", body: "for one" });
    await built.runtime.run("app:notify", { userId: "u2", body: "for two" });

    const u1Inbox = (await runAs("u1", "notifications:inbox", {})) as Array<{ _id: string; body: string; read: boolean }>;
    expect(u1Inbox.map((r) => r.body)).toEqual(["for one"]);
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(1);

    await runAs("u1", "notifications:markRead", { id: u1Inbox[0]!._id });
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(0);
    const after = (await runAs("u1", "notifications:inbox", {})) as Array<{ read: boolean }>;
    expect(after[0]!.read).toBe(true);
  });

  it("markRead is ownership-checked — a foreign row is rejected", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    await built.runtime.run("app:notify", { userId: "u1", body: "secret" });
    const u1Inbox = (await runAs("u1", "notifications:inbox", {})) as Array<{ _id: string }>;
    await expect(runAs("u2", "notifications:markRead", { id: u1Inbox[0]!._id })).rejects.toThrow(/not found/);
  });

  it("markAllRead clears every unread row for the caller", async () => {
    built = await makeNotifRuntime(inboxComponent(), appModules);
    await built.runtime.run("app:notify", { userId: "u1", body: "a" });
    await built.runtime.run("app:notify", { userId: "u1", body: "b" });
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(2);
    await runAs("u1", "notifications:markAllRead", {});
    expect(await runAs("u1", "notifications:unreadCount", {})).toBe(0);
  });
});
```

> Confirmed: `EmbeddedRuntime.run<T>(path, args, { identity? })` returns `UdfResult<T>` and threads `identity` to `cctx.identity` (see `components/auth/test/ctx-auth.test.ts`: `r.run<string|null>("me:get", {}, { identity: token })`). So `ctx.notifications.identity()` resolves the caller here; `runAs` reads `.value`.

---

## T6 [PARALLELIZABLE with T5's client work] — E2E through the real dev server + enduser docs

**Owns:** `packages/cli/test/notifications-e2e.test.ts`, `docs/enduser/build/notifications.md`.

### `packages/cli/test/notifications-e2e.test.ts`

```ts
/**
 * Notifications N1 — E2E through the real `stackbase dev` server (e2e-through-shipped-entrypoint
 * rule). A REAL `@stackbase/client` over a REAL WebSocket to a REAL server with
 * `@stackbase/notifications` composed. The reactive-inbox proof is the headline:
 *  (1) a client mutation calls `ctx.notifications.send` for in_app + email;
 *  (2) a LIVE inbox subscription (opened BEFORE) sees the in_app notification appear reactively;
 *  (3) the driver delivers the email (capture provider records it, woken by the commit fan-out);
 *  (4) `markRead` fans out reactively — the live unread-count subscription drops to 0.
 * No auth composed: the inbox resolves the caller via `ctx.notifications.identity()` (the setAuth
 * token), and the app mutation targets that same id.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications, type EmailMessage, type EmailProvider } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await new Promise<void>((r) => setTimeout(r, 10));
  }
}

function captureEmail(): { sent: EmailMessage[]; provider: EmailProvider } {
  const sent: EmailMessage[] = [];
  return { sent, provider: { channel: "email", async send(m) { sent.push(m); return { providerMessageId: `cap-${sent.length}` }; } } };
}

const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });

const appModules = {
  notify: {
    // The app tells notifications who to notify (server-controlled recipient) — here the caller's own id.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ping: mutation(async (ctx: any, { userId }: { userId: string }) =>
      ctx.notifications.send({
        to: { userId, email: `${userId}@test` },
        channels: ["in_app", "email"],
        template: { in_app: { title: "Hi", body: "hello there" }, email: { subject: "Hi", text: "hello there" } },
      })),
  },
};

const api = anyApi as {
  notify: { ping: { __path: string } };
  notifications: { inbox: { __path: string }; unreadCount: { __path: string }; markRead: { __path: string } };
};

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N1 — E2E through the real dev server", () => {
  it("in_app appears reactively, the driver delivers email, and markRead drops the unread count live", async () => {
    const capture = captureEmail();
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({
        channels: { email: { provider: capture.provider, from: "no-reply@test" }, in_app: { enabled: true } },
        driverIntervalMs: 1000,
      }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
      tableNumbers: project.tableNumbers,
      componentNames: project.componentNames,
      contextProviders: project.contextProviders,
      bootSteps: project.bootSteps,
      drivers: project.drivers,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
    servers.push(server);
    const wsUrl = `ws://127.0.0.1:${server.port}/api/sync`;

    const c = new StackbaseClient(webSocketTransport(wsUrl, { reconnect: false }));
    try {
      c.setAuth("user-1"); // the ambient identity → the inbox recipient id
      const inbox: Array<Array<{ _id: string; body: string }>> = [];
      const unread: number[] = [];
      c.subscribe(api.notifications.inbox, {}, (v2) => inbox.push(v2 as Array<{ _id: string; body: string }>));
      c.subscribe(api.notifications.unreadCount, {}, (v2) => unread.push(v2 as number));
      await waitFor(() => inbox.length >= 1 && unread.length >= 1, 5000, "initial inbox");
      expect(inbox.at(-1)).toEqual([]);
      expect(unread.at(-1)).toBe(0);

      // Send: writes the in_app inbox row (reactive) + a queued email row (driver delivers).
      await c.mutation(api.notify.ping, { userId: "user-1" });

      await waitFor(() => (inbox.at(-1)?.length ?? 0) >= 1, 5000, "reactive in_app");
      expect(inbox.at(-1)![0]!.body).toBe("hello there");
      await waitFor(() => unread.at(-1) === 1, 5000, "unread=1");

      // The driver delivers the email, woken by the send's commit fan-out.
      await waitFor(() => capture.sent.length >= 1, 5000, "email delivered");
      expect(capture.sent[0]).toMatchObject({ to: "user-1@test", from: "no-reply@test", subject: "Hi" });

      // markRead fans out reactively — the unread-count subscription drops to 0.
      const id = inbox.at(-1)![0]!._id;
      await c.mutation(api.notifications.markRead, { id });
      await waitFor(() => unread.at(-1) === 0, 5000, "reactive markRead");
      expect(unread.at(-1)).toBe(0);
    } finally {
      c.close();
    }
  });
});
```

> Confirm `loadProject(app, components[])` accepts the components array (it does — `auth-email-e2e.test.ts` passes `[defineAuth(...)]`) and that `createEmbeddedRuntime` receives `project.drivers` (the notifications driver must be started). If `@stackbase/cli` needs `@stackbase/notifications` as a devDependency to import `defineNotifications` in this test, add it to `packages/cli/package.json` devDependencies (workspace:*) — mirror how `@stackbase/auth` is wired there.

### `docs/enduser/build/notifications.md`

Write the enduser guide (native `@stackbase/*` imports only, no `convex/*`). Sections:

1. **What it is** — an opt-in component for email/SMS/in-app notifications with a reactive in-app inbox that's free because rows are live-queried. Honest N1 boundary up top.
2. **Setup** (`stackbase.config.ts`):
   ```ts
   import { defineConfig } from "@stackbase/component";
   import { defineNotifications, consoleEmail, resendEmail, twilioSms } from "@stackbase/notifications";

   export default defineConfig({
     components: [
       defineNotifications({
         channels: {
           email: { provider: consoleEmail(), from: "no-reply@app.test",
             templates: { welcome: (d) => ({ subject: `Welcome ${d.name}`, text: `Hi ${d.name}!` }) } },
           sms: { provider: twilioSms({ accountSid: process.env.TWILIO_SID!, authToken: process.env.TWILIO_TOKEN! }), from: "+15550000000" },
           in_app: { enabled: true,
             templates: { welcome: (d) => ({ title: "Welcome", body: `Hi ${d.name}!` }) } },
         },
       }),
     ],
   });
   ```
   Note `consoleEmail()` is the zero-config dev provider (logs to the server console); swap `resendEmail({ apiKey })` for real delivery.
3. **Sending** — `ctx.notifications.send({ to, channels, template, data, idempotencyKey? })` from a mutation (transactional enqueue; in-app is instant); the inline-vs-registered `template` forms; `sendNow` from an action for synchronous fire-and-now; the idempotency key (an OTP never double-sends).
4. **The reactive in-app inbox** — `useNotifications()` / `<Inbox>` from `@stackbase/client/react`, unread count, `markRead`/`markAllRead`. Show a small React example.
5. **Providers** — the shipped three + writing your own `{ channel, send }` adapter (the seam).
6. **What's deferred to N2–N4** — webhook ingestion + status normalization + retries (N2); preferences/routing/topics (N3); digest/batching + auth unification (N4); push channel + markup template registry (post-arc). Mirror the spec's Non-goals verbatim.

---

## Verification (run after each task; full gate after T6)

```bash
# Component package (after T1–T5 land + adapters):
bun run --filter @stackbase/notifications build
bun run --filter @stackbase/notifications typecheck
bun run --filter @stackbase/notifications test        # helpers/send/driver/inbox/provider-* tests

# Client (after T5):
bun run --filter @stackbase/client build
bun run --filter @stackbase/client typecheck
bun run --filter @stackbase/client test

# E2E (after building the deps the CLI resolves via dist):
bun run build                                          # topological — rebuild notifications+client dist
bun run --filter @stackbase/cli test -- notifications-e2e

# Whole-repo gate:
bun run build && bun run typecheck && bun run test
```

Per-task local runs: T2a/b/c run `vitest run test/provider-*.test.ts` (self-contained via direct `../src/provider-*` imports). T3/T4/T5 tests import `./helpers` (T1) and assemble their own `defineComponent` inline, so each runs as soon as its own files + T1 exist. Remember the **dist-resolution rule**: rebuild `@stackbase/notifications`/`@stackbase/client` before the CLI E2E.

## Ambiguities resolved (surfaced for review)

1. **`messages.payload` (schema extension).** The verbatim `messages` schema names `templateKey?`/`dataHash?` but carries no field for the content the driver must send out-of-transaction. Resolution: render the pure per-channel template functions INSIDE the send mutation (deterministic, no I/O — the correct place per "no `Date.now()`/side effects in a mutation") and store the rendered content on an added optional `messages.payload` (`v.any()`), so the driver delivers without re-render and without persisting the raw `data` (PII). `dataHash` remains a hash of the raw `data` for dedup diagnostics. This is the only field added beyond the verbatim schema; additive, so the additive-schema gate accepts it.
2. **`in_app` also gets a `messages` row** (`status:"sent"`, `sentAt=now`) beside the `notifications` inbox row — honoring "one row per (send × channel)" and "the delivery-status rows reactive too" (a status dashboard sees in-app too). The `notifications` row is the reactive/delivered artifact; the `messages` row is the audit/status record.
3. **How the driver does I/O in this component model.** Exactly the scheduler/reaper pattern: `defineNotifications` sets `driver: notificationsDriver(config)`; `composeComponents` collects it into `ComposedProject.drivers`; the runtime `start()`s it with a `DriverContext`. The driver taps `ctx.onCommit` (wakes on any `notifications/*` write) + a `ctx.setTimer(now + driverIntervalMs)` fallback, coalescing overlapping wakes with a single `running` flag (+ `pendingWake`, + `stopped`). Each pass: `ctx.runFunction("notifications:_peekQueued", {})` (a QUERY, privileged/fully-qualified, returns queued email/SMS rows with their `payload`), then for each row `await deliverOutbound(config, …)` (**the network `provider.send` — outside any transaction, allowed in the driver's action context**), then `ctx.runFunction("notifications:_markResult", { messageId, ok, providerMessageId?, error? })` (a MUTATION flipping `queued → sent`/`failed`). `_peekQueued`/`_markResult` run privileged (fully-qualified `notifications/messages`); the send/enqueue path runs namespaced (bare names). N1: a failed send is terminal; no claim/lease (retries + reclaim are N2). This matches the spec's stated N1 boundary exactly.
4. **How `ctx.notifications` is attached.** Via `ComponentDefinition.context: (cctx) => notificationsContext(cctx, config)` + `contextWrite: true` (so `cctx.db` is a `GuestDatabaseWriter` scoped to the `notifications` namespace during a mutation — `send` writes rows inside the calling mutation's transaction, exactly like `ctx.scheduler.runAfter`). `composeComponents` turns every `context` into a `ContextProvider` attached as `ctx[name]` to every function's ctx (`InlineUdfExecutor`'s `guestCtx` loop). `buildAction: (api) => notificationsActionContext(api, config)` provides the action-mode `ctx.notifications` (no `db` → `send` delegates to `api.runMutation("notifications:_enqueueSend")`, `sendNow` delivers live via `_prepareNow`/`_finishNow`) — the same facade-delegates-to-internal-mutation pattern the scheduler established. Typed for consumers via `contextType: { import: "@stackbase/notifications", type: "NotificationsContext" }`, which codegen turns into the `declare module "@stackbase/executor" { interface MutationCtx { notifications: … } }` augmentation.
5. **The in-app row + inbox codegen typing.** `send` writes the `notifications` row synchronously in the mutation — it IS the delivered in-app notification, so it's live to any `useQuery("notifications:inbox")` with **no send step**. The inbox query resolves the caller server-side (`ctx.auth?.getUserId()` when auth is composed, else `ctx.notifications.identity()` = the ambient token — both facades are attached to the handler ctx), scoped to `byUser`/`byUserUnread`, so a user only ever sees their own inbox and `markRead` is ownership-checked. **Codegen typing:** component functions are NOT in an app's generated `Api` (the manifest analyzes app modules only — the E2E casts `anyApi` for the well-known paths, exactly as `auth-email-e2e` does). So the inbox's client-facing type lives in the hand-written `useNotifications()`/`<Inbox>` helper in `@stackbase/client/react` (typed `InboxNotification[]`, over the well-known `notifications:inbox`/`unreadCount`/`markRead`/`markAllRead` paths) — no per-app codegen change needed. The server-side `ctx.notifications.send` is the piece codegen types, via the `contextType` module augmentation.
6. **`sendNow` scope.** Spec decision 3 defines it; testing/non-goals are silent. Included, implemented correctly (two-phase, dedup-before-send, never a driver-visible queued row). Kept minimal; the primary path remains the transactional `send` + driver, which is what N4 will route auth through.
7. **Fleet/crash caveats.** Multi-driver (fleet) double-send and mid-send-crash re-send are explicitly N1-out-of-scope (single-node; retries/reclaim are N2), consistent with the spec's driver section. The driver's `running` flag serializes a single node's own passes; `sendNow` avoids the queue entirely, so it never races the driver.
