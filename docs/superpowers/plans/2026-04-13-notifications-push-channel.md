# Notifications — Push Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `"push"` channel to `@stackbase/notifications` — device-token registry + self-only
registration, multi-token/multi-provider fan-out per logical send, and three provider adapters
(`expoPush`, `fcmPush`, `apnsPush`) — reusing the existing queued-delivery driver, N2 retry/backoff,
and N3 preferences/critical-bypass/topics machinery. Full rationale:
`docs/superpowers/specs/2026-04-13-notifications-push-channel-design.md` — read it first; this plan
does not re-derive the decisions, only executes them.

**Architecture:** Push plugs into the SAME `recordSend` chokepoint every other channel uses. The
only genuinely new pieces are (a) the `pushTokens` registry + registration modules, (b) a
push-specific branch inside `recordSend` that snapshots tokens instead of resolving a single
address, (c) a push-specific branch inside the shared `deliverOutbound` that groups tokens by
provider and fans out, and (d) three adapters implementing `PushProvider`. Everything else (the
driver's claim/mark/reclaim loop, N2 backoff, N3 preference gate, topics) needs zero changes beyond
type-widening `Channel` to a 4th member.

**Tech Stack:** TypeScript; `@stackbase/executor` (`mutation`/`query`/`ctx.now`); `@stackbase/values`
(`v`, schema); `jose` (new dependency — ES256/RS256 JWT signing, already used by
`components/auth`); `node:http2` (APNs transport — Apple's provider API is HTTP/2-only, `fetch`
can't do it); vitest.

## Global Constraints

- **Additive schema only.** New `pushTokens` table; `messages.channel` gains a literal, `messages
  .tokens` is a new optional field. No renamed/removed/narrowed field anywhere.
- **`compact()` at EVERY codec boundary** — args, returns, `db.insert`/`db.replace`, and any
  `runMutation`/`runFunction` call with an optional field that may be `undefined`. This bit N1/N2/N3
  repeatedly; it will bite push too if skipped (`tokens`, `providerMessageId`, `invalidTokens`,
  `platform` are all optional).
- **No `Date.now()`/`Math.random()` in a UDF.** `recordSend`'s push branch runs in a mutation — only
  `ctx.now()`/the already-injected `now` param.
- **Self-only client-callable modules; server facade may take `userId?`.** `registerPushToken`/
  `unregisterPushToken` (registered modules) resolve the subject via `callerId(ctx)` ONLY — never
  accept a `userId` arg. The mutation facade's `ctx.notifications.registerPushToken`/
  `unregisterPushToken` MAY take `userId?` (server-controlled), defaulting to the caller — the exact
  `subscribe`/`unsubscribe` split.
- **Single chokepoint discipline**: the push branch lives INSIDE `recordSend` (not a parallel
  function) so the N3 preference gate, `sendReceipts` idempotency, and the return shape
  (`messageIds`/`suppressed`/`deferred`) all apply to push for free. Do not add a second gate.
- **`deliverOutbound` stays the ONE dispatch function** both the driver and `sendNow` call — the
  push branch lives there too, not a separate `deliverPush`.
- Naming: token table `pushTokens`; provider kinds are the literal union `"expo" | "fcm" | "apns"`
  (call this `PushProviderKind` in code — don't inline the union at every use site).

---

## File Structure

- `components/notifications/src/provider.ts` — MODIFY: `PushMessage`, `PushSendResult`,
  `PushProvider`, `PushContent`, widen `NotificationProvider`.
- `components/notifications/src/config.ts` — MODIFY: `Channel` widened to include `"push"`;
  `PushTemplateFn`/`PushTemplates`; `PushChannelConfig`; `NotificationChannels.push?`;
  `InlineTemplate.push?`.
- `components/notifications/src/schema.ts` — MODIFY: `pushTokens` table; `messages.channel` +
  `messages.tokens`.
- `components/notifications/src/render.ts` — MODIFY: `renderPush`; extend `DeliverEntry`/
  `deliverOutbound` with the push branch (grouping + partial-failure policy).
- `components/notifications/src/modules.ts` — MODIFY: `resolveAddress`/`assertConfigured` for
  push; `recordSend`'s push branch (token snapshot + insert); `QueuedMessage` widened;
  `_peekQueued` includes `channel:"push"`; new `_pruneInvalidPushTokens` mutation.
- `components/notifications/src/push.ts` — CREATE: `registerPushTokenImpl`/
  `unregisterPushTokenImpl` (shared by module + facade, the `subscribeImpl`/`unsubscribeImpl`
  pattern) + `makePushModules(config)` (`registerPushToken`/`unregisterPushToken`).
- `components/notifications/src/driver.ts` — MODIFY: after `deliverOutbound`, prune
  `invalidTokens` if present.
- `components/notifications/src/facade.ts` — MODIFY: `sendNow`'s drain loop gets the same
  prune-call; add `registerPushToken`/`unregisterPushToken` to `NotificationsContext` +
  `notificationsContext`; widen `sendToTopic`'s `channels` param type + relax its channel check.
- `components/notifications/src/topics.ts` — MODIFY: widen the `sendToTopic` channel restriction
  message/type (small — the mechanism already works for any userId-addressed channel).
- `components/notifications/src/provider-expo.ts` — CREATE: `expoPush()`.
- `components/notifications/src/provider-fcm.ts` — CREATE: `fcmPush()`.
- `components/notifications/src/provider-apns.ts` — CREATE: `apnsPush()`.
- `components/notifications/src/index.ts` — MODIFY: wire `makePushModules`; export new types +
  the three new adapters.
- `components/notifications/package.json` — MODIFY: add `jose` dependency.
- `packages/client/src/notifications.tsx` — MODIFY: `registerForPush`/`unregisterForPush`; widen
  `NotificationPreference.channel`.
- Tests: `components/notifications/test/push-core.test.ts` (T1-T3), `test/provider-expo.test.ts`
  (T4), `test/provider-fcm.test.ts` (T5), `test/provider-apns.test.ts` (T6),
  `packages/cli/test/notifications-push-e2e.test.ts` (T7).
- `docs/enduser/build/notifications.md` — MODIFY (T7).

**Parallelization:** T1-T3 are SEQUENTIAL (each depends on the last: seam types → registry/schema →
send/driver plumbing). T4/T5/T6 (the three adapters) depend ONLY on T1's `PushProvider`/
`PushMessage`/`PushSendResult` types being frozen — they touch no file T2/T3 touch, so **run T4, T5,
T6 in parallel with each other AND in parallel with T2/T3** once T1 lands. T7 (E2E + docs) is
sequential and depends on everything (needs at least one real adapter wired end-to-end — use the
capture/expo path, so T7 only strictly needs T1-T4, not T5/T6, but should wait for all three to land
so the docs section covers all of them in one pass).

```
T1 (seam types) ──┬── T2 → T3 (registry, send/driver plumbing) ──┐
                   ├── T4 (expoPush)         [parallel] ──────────┤
                   ├── T5 (fcmPush)          [parallel] ──────────┼── T7 (E2E + docs)
                   └── T6 (apnsPush)         [parallel] ──────────┘
```

---

## Task 1: Freeze the seam — provider/config types (prerequisite, sequential)

**Files:** Modify `provider.ts`, `config.ts`.

**Interfaces produced:**
```ts
// provider.ts
export interface PushMessage { to: string[]; title: string; body: string; data?: Record<string, unknown>; idempotencyKey?: string }
export interface PushSendResult extends SendResult { invalidTokens?: string[] }
export interface PushProvider { channel: "push"; send(m: PushMessage): Promise<PushSendResult> }
export interface PushContent { title: string; body: string; data?: Record<string, unknown> }
export type NotificationProvider = EmailProvider | SmsProvider | PushProvider;

// config.ts
export type Channel = "email" | "sms" | "in_app" | "push";
export type PushProviderKind = "expo" | "fcm" | "apns";
export type PushTemplateFn = (data: any) => PushContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type PushTemplates = Record<string, PushTemplateFn>;
export interface PushChannelConfig {
  providers: { expo?: PushProvider; fcm?: PushProvider; apns?: PushProvider };
  templates?: PushTemplates;
}
// NotificationChannels gains: push?: PushChannelConfig;
// InlineTemplate gains: push?: PushContent;
// Recipient is UNCHANGED (push addresses via to.userId, already present).
```

- [ ] **Step 1: Write a type-only smoke test.** Create `components/notifications/test/push-core.test.ts`
  with a first, trivial case that just imports the new types and constructs a minimal `PushProvider`
  inline, to lock the shape before anything depends on it:
```ts
import { describe, it, expect } from "vitest";
import type { PushProvider, PushSendResult } from "../src/provider";

describe("push channel — seam types", () => {
  it("a minimal PushProvider satisfies the interface", async () => {
    const captured: unknown[] = [];
    const provider: PushProvider = {
      channel: "push",
      async send(m): Promise<PushSendResult> { captured.push(m); return { providerMessageId: "x" }; },
    };
    const res = await provider.send({ to: ["tok1"], title: "T", body: "B" });
    expect(res.providerMessageId).toBe("x");
    expect(captured).toHaveLength(1);
  });
});
```
- [ ] **Step 2: Run — expect FAIL** (types don't exist yet). `cd components/notifications && bunx vitest run test/push-core.test.ts`.
- [ ] **Step 3: Add the types to `provider.ts`** — insert after the existing `SmsProvider`/before
  `NotificationProvider`:
```ts
export interface PushMessage {
  to: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
}
export interface PushSendResult extends SendResult {
  /** Tokens the provider reported as permanently unregistered/invalid — pruned by the caller
   *  (the driver / `sendNow`) via `_pruneInvalidPushTokens`, never retried. */
  invalidTokens?: string[];
}
export interface PushProvider {
  channel: "push";
  send(m: PushMessage): Promise<PushSendResult>;
  // no `webhook?` — push invalid-token detection is synchronous (send response), no async webhook.
}
export type NotificationProvider = EmailProvider | SmsProvider | PushProvider;
export interface PushContent {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}
```
- [ ] **Step 4: Add the config types to `config.ts`.** Widen `Channel`:
```ts
export type Channel = "email" | "sms" | "in_app" | "push";
export type PushProviderKind = "expo" | "fcm" | "apns";
```
Add templates + channel config (near `InAppTemplates`/`InAppChannelConfig`):
```ts
export type PushTemplateFn = (data: any) => PushContent; // eslint-disable-line @typescript-eslint/no-explicit-any
export type PushTemplates = Record<string, PushTemplateFn>;
export interface PushChannelConfig {
  /** At least one must be set — `defineNotifications` throws at construction if `push` is
   *  configured with an empty map (see index.ts). Which provider a token routes to is decided by
   *  the token's OWN recorded `provider` field (pushTokens.provider), not by which of these are set. */
  providers: { expo?: PushProvider; fcm?: PushProvider; apns?: PushProvider };
  templates?: PushTemplates;
}
```
Import `PushContent`/`PushProvider` at the top of `config.ts` (extend the existing
`import type { EmailProvider, SmsProvider, EmailContent, InAppContent } from "./provider";` line).
Widen `NotificationChannels`:
```ts
export interface NotificationChannels {
  email?: EmailChannelConfig;
  sms?: SmsChannelConfig;
  in_app?: InAppChannelConfig;
  push?: PushChannelConfig;
}
```
Widen `InlineTemplate`:
```ts
export interface InlineTemplate {
  email?: EmailContent;
  sms?: string;
  in_app?: InAppContent;
  push?: PushContent;
}
```
- [ ] **Step 5: Run — expect PASS.** `bunx vitest run test/push-core.test.ts`; `bunx tsc --noEmit`
  for the whole package (existing N1-N4 code must still typecheck — `Channel`/`NotificationProvider`
  widened is a superset, should be additive-safe; check `preferences.ts`'s `Channel` union literal
  in the schema doesn't need touching yet — that's T2).
- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/provider.ts components/notifications/src/config.ts components/notifications/test/push-core.test.ts
git commit -m "feat(notifications): push channel T1 — seam types (PushProvider/PushMessage/PushSendResult/PushChannelConfig)"
```

---

## Task 2: Device-token registry — schema + registration (self-only)

**Files:** Modify `schema.ts`; Create `push.ts`; Modify `index.ts`, `facade.ts`; Extend
`test/push-core.test.ts`.

**Interfaces produced:**
```ts
export function registerPushTokenImpl(db, now, userId: string, args: { token: string; provider: PushProviderKind; platform?: "ios"|"android"|"web" }): Promise<null>
export function unregisterPushTokenImpl(db, userId: string, args: { token: string }): Promise<null>
export function makePushModules(config: NotificationsConfig): Record<string, RegisteredFunction>  // { registerPushToken, unregisterPushToken }
```

- [ ] **Step 1: Extend the schema.** In `schema.ts`, add (after `digestBuffer`):
```ts
  pushTokens: defineTable({
    userId: v.string(),
    token: v.string(),
    provider: v.union(v.literal("expo"), v.literal("fcm"), v.literal("apns")),
    platform: v.optional(v.union(v.literal("ios"), v.literal("android"), v.literal("web"))),
    createdAt: v.number(),
  })
    .index("byUser", ["userId"])
    .index("byToken", ["token"]),
```
Also widen `messages.channel`'s union (add `v.literal("push")`) and add the transient token
snapshot field (near `payload`):
```ts
    channel: v.union(v.literal("email"), v.literal("sms"), v.literal("in_app"), v.literal("push")),
    // ...
    tokens: v.optional(v.any()), // push-only device-token snapshot, Array<{token,provider}> — see T3
```
- [ ] **Step 2: Write the registration test.** Extend `test/push-core.test.ts`:
```ts
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makePushModules } from "../src/push";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers"; // reuse existing test helper

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({ channels: {} });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePushModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {};

describe("push channel — device-token registry", () => {
  let built: BuiltNotifRuntime;
  afterEach(async () => { await built?.close(); });

  it("registerPushToken is self-only and upserts by token", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("notifications:registerPushToken", { token: "tok1", provider: "expo" }, { identity: "u1" });
    let rows = await built.readTable("notifications/pushTokens");
    expect(rows).toMatchObject([{ userId: "u1", token: "tok1", provider: "expo" }]);

    // Re-registering the SAME token under a different caller reassigns it (device changed owner).
    await built.runtime.run("notifications:registerPushToken", { token: "tok1", provider: "fcm", platform: "android" }, { identity: "u2" });
    rows = await built.readTable("notifications/pushTokens");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u2", token: "tok1", provider: "fcm", platform: "android" });
  });

  it("unregisterPushToken is ownership-checked (a foreign caller's unregister is a no-op)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("notifications:registerPushToken", { token: "tok2", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:unregisterPushToken", { token: "tok2" }, { identity: "u2" }); // foreign — no-op
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(1);
    await built.runtime.run("notifications:unregisterPushToken", { token: "tok2" }, { identity: "u1" }); // owner — removes
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(0);
  });

  it("a client-supplied userId arg is IGNORED on the registered module (self-only)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // No `userId` field even accepted by the type — this proves the RUNTIME behavior: even if an
    // attacker's raw JSON smuggles one in past the type system, callerId (not the arg) wins.
    await built.runtime.run("notifications:registerPushToken", { token: "tok3", provider: "expo", userId: "victim" } as never, { identity: "attacker" });
    const rows = await built.readTable("notifications/pushTokens");
    expect(rows[0]!.userId).toBe("attacker"); // NOT "victim"
  });
});
```
> Implementer: confirm `makeNotifRuntime`/`BuiltNotifRuntime`/`readTable` exist in
> `components/notifications/test/helpers.ts` (used throughout N1-N4 tests) — reuse them verbatim,
> don't reinvent a harness.
- [ ] **Step 3: Run — expect FAIL** (`../src/push` missing). `bunx vitest run test/push-core.test.ts`.
- [ ] **Step 4: Create `push.ts`** (mirrors `topics.ts`'s `subscribeImpl`/`makeTopicModules` shape):
```ts
import { mutation, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { GuestDatabaseWriter } from "@stackbase/executor";
import type { NotificationsConfig, PushProviderKind } from "./config";
import { callerId } from "./inbox";
import { compact } from "./render";

export interface RegisterPushTokenArgs {
  token: string;
  provider: PushProviderKind;
  platform?: "ios" | "android" | "web";
}

/** Upsert BY TOKEN (not by (userId,token)) — a device token identifies one installation; whoever is
 *  currently logged into that device owns it. Shared by the registered `registerPushToken` module
 *  (self-only, caller resolved via `callerId`) and the mutation facade's `registerPushToken`
 *  (server-controlled `userId?`), the same two-transports-one-core split every other N1-N4 write
 *  path (`applySetPreference`, `subscribeImpl`) uses. */
export async function registerPushTokenImpl(db: GuestDatabaseWriter, now: number, userId: string, args: RegisterPushTokenArgs): Promise<null> {
  const [existing] = await db.query("pushTokens", "byToken").eq("token", args.token).take(1).collect();
  if (existing) {
    await db.replace(existing._id as string, compact({ userId, token: args.token, provider: args.provider, platform: args.platform, createdAt: existing.createdAt }));
  } else {
    await db.insert("pushTokens", compact({ userId, token: args.token, provider: args.provider, platform: args.platform, createdAt: now }));
  }
  return null;
}

/** Ownership-checked delete — a foreign or missing token is a silent no-op (mirrors `markRead`'s
 *  ownership check; avoids leaking whether a token string belongs to someone else). */
export async function unregisterPushTokenImpl(db: GuestDatabaseWriter, userId: string, args: { token: string }): Promise<null> {
  const [existing] = await db.query("pushTokens", "byToken").eq("token", args.token).take(1).collect();
  if (existing && (existing.userId as string) === userId) await db.delete(existing._id as string);
  return null;
}

/** `registerPushToken`/`unregisterPushToken` — CLIENT-CALLABLE, hence strictly SELF-ONLY: the
 *  subject is `callerId(ctx)`, never a client-supplied `userId` (the N3 IDOR lesson `subscribe`/
 *  `unsubscribe` already codified). The server-controlled `userId?` override lives ONLY on the
 *  facade (`ctx.notifications.registerPushToken`, `facade.ts`), reachable exclusively from
 *  server-authored mutations. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function makePushModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerPushToken = mutation(async (ctx: any, args: RegisterPushTokenArgs): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    return registerPushTokenImpl((ctx as MutationCtx).db as GuestDatabaseWriter, (ctx as MutationCtx).now(), userId, args);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unregisterPushToken = mutation(async (ctx: any, args: { token: string }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    return unregisterPushTokenImpl((ctx as MutationCtx).db as GuestDatabaseWriter, userId, args);
  });

  return { registerPushToken, unregisterPushToken };
}
```
> Implementer: `config` is currently unused in `makePushModules` — keep the parameter (matches
> `makeTopicModules(config)`'s precedent of an initially-unused config param) with the eslint-disable,
> or drop it if the lint rule for unused params is stricter here; check `.eslintrc`/`biome` config
> for the project's actual convention before deciding.
- [ ] **Step 5: Wire `index.ts`.** Import + spread:
```ts
import { makePushModules } from "./push";
// ...
    modules: { ...makeSendModules(config), ...makeInboxModules(), ...makeWebhookModules(config), ...makePreferenceModules(config), ...makeTopicModules(config), ...makeDigestModules(config), ...makePushModules(config) },
```
- [ ] **Step 6: Add the fail-fast config guard.** In `index.ts`'s `defineNotifications`, alongside
  the existing `hasWebhook`-without-secret warning, add:
```ts
  if (config.channels.push && Object.keys(config.channels.push.providers).length === 0) {
    throw new Error(
      '[notifications] channels.push is configured with an empty `providers` map — set at least one of expo/fcm/apns, or omit `channels.push` entirely.',
    );
  }
```
- [ ] **Step 7: Add facade methods** (`facade.ts`). Add to `NotificationsContext`:
```ts
  registerPushToken(args: { token: string; provider: "expo" | "fcm" | "apns"; platform?: "ios" | "android" | "web"; userId?: string }): Promise<null>;
  unregisterPushToken(args: { token: string; userId?: string }): Promise<null>;
```
Implement in `notificationsContext` (mirrors `subscribe`/`unsubscribe`):
```ts
    async registerPushToken(args) {
      const userId = args.userId ?? (await facadeCallerId(cctx));
      if (!userId) throw new Error("not authenticated");
      return registerPushTokenImpl(cctx.db as GuestDatabaseWriter, cctx.now, userId, args);
    },
    async unregisterPushToken(args) {
      const userId = args.userId ?? (await facadeCallerId(cctx));
      if (!userId) throw new Error("not authenticated");
      return unregisterPushTokenImpl(cctx.db as GuestDatabaseWriter, userId, args);
    },
```
Import `registerPushTokenImpl`/`unregisterPushTokenImpl` from `./push` at the top of `facade.ts`.
- [ ] **Step 8: Run — expect PASS.** `bunx vitest run test/push-core.test.ts`; full package
  `bunx vitest run`; `bunx tsc --noEmit`.
- [ ] **Step 9: Commit.**
```bash
git add components/notifications/src/schema.ts components/notifications/src/push.ts components/notifications/src/index.ts components/notifications/src/facade.ts components/notifications/test/push-core.test.ts
git commit -m "feat(notifications): push channel T2 — pushTokens registry + self-only register/unregister"
```

---

## Task 3: `recordSend` push branch + driver delivery + invalid-token pruning

**Files:** Modify `modules.ts`, `render.ts`, `driver.ts`, `facade.ts`, `topics.ts`; Extend
`test/push-core.test.ts`.

**Interfaces produced:**
```ts
// render.ts
export function renderPush(config: NotificationsConfig, template: string | InlineTemplate, data?: Record<string, unknown>): PushContent
// DeliverEntry gains: channel:"push"; tokens?: Array<{token:string; provider: PushProviderKind}>
// deliverOutbound(config, entry): Promise<PushSendResult>  (widened return; email/sms still return the {providerMessageId?} subset)

// modules.ts
// QueuedMessage.channel: "email" | "sms" | "push"; QueuedMessage.tokens?: Array<{token,provider}>
// recordSend(...) — push branch added to the existing per-channel loop
// _pruneInvalidPushTokens(args: {tokens: string[]}): Promise<null>   — new privileged mutation
```

- [ ] **Step 1: Write the send + delivery test.** Extend `test/push-core.test.ts` with a capture
  `PushProvider` and full send→driver→delivery assertions:
```ts
import { notificationsDriver } from "../src/driver";
import type { PushProvider, PushSendResult } from "../src/provider";

function captureProvider(onSend: (m: { to: string[]; title: string; body: string }) => PushSendResult): PushProvider {
  return { channel: "push", async send(m) { return onSend(m); } };
}

function compWithPush(providers: { expo?: PushProvider; fcm?: PushProvider }): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: { push: { providers, templates: { hi: (d: { name: string }) => ({ title: "Hi", body: `Hello ${d.name}` }) } } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePushModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
    driver: notificationsDriver(config),
  });
}

describe("push channel — send + driver delivery", () => {
  let built: BuiltNotifRuntime;
  afterEach(async () => { await built?.close(); });

  it("one messages row per send, fanned out across 2 providers, delivered by the driver", async () => {
    const calls: Array<{ to: string[] }> = [];
    const expo = captureProvider((m) => { calls.push({ to: m.to }); return { providerMessageId: "exp1" }; });
    const fcm = captureProvider((m) => { calls.push({ to: m.to }); return { providerMessageId: "fcm1" }; });
    built = await makeNotifRuntime(compWithPush({ expo, fcm }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:registerPushToken", { token: "f1", provider: "fcm" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "Ada" } }, { identity: "u1" });

    expect((await built.readTable("notifications/messages")).filter((r) => r.channel === "push")).toHaveLength(1);
    await built.tickDriver(); // existing helper — mirrors N1's driver e2e pattern; adjust to whatever the suite already calls
    expect(calls.map((c) => c.to).sort()).toEqual([["e1"], ["f1"]]);
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent");
  });

  it("zero registered devices: enqueued, then marked sent with NO provider call", async () => {
    const expo = captureProvider(() => { throw new Error("should not be called"); });
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("app:send", { to: { userId: "ghost" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "ghost" });
    await built.tickDriver();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent");
  });

  it("invalid tokens are pruned after delivery", async () => {
    const expo = captureProvider(() => ({ invalidTokens: ["stale1"] }));
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "stale1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await built.tickDriver();
    expect(await built.readTable("notifications/pushTokens")).toHaveLength(0);
  });

  it("one provider group throws, the other succeeds: row is sent (no retry), no duplicate on next tick", async () => {
    let fcmCalls = 0;
    const expo = captureProvider(() => ({ providerMessageId: "ok" }));
    const fcm: PushProvider = { channel: "push", async send() { fcmCalls++; throw new Error("network down"); } };
    built = await makeNotifRuntime(compWithPush({ expo, fcm }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("notifications:registerPushToken", { token: "f1", provider: "fcm" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await built.tickDriver();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("sent"); // partial success = overall ok
    await built.tickDriver(); // a second tick must NOT re-deliver (row is no longer queued)
    expect(fcmCalls).toBe(1);
  });

  it("every provider group throws: retries per N2 backoff", async () => {
    const expo: PushProvider = { channel: "push", async send() { throw new Error("down"); } };
    built = await makeNotifRuntime(compWithPush({ expo }), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    });
    await built.runtime.run("notifications:registerPushToken", { token: "e1", provider: "expo" }, { identity: "u1" });
    await built.runtime.run("app:send", { to: { userId: "u1" }, channels: ["push"], template: "hi", data: { name: "X" } }, { identity: "u1" });
    await built.tickDriver();
    const row = (await built.readTable("notifications/messages")).find((r) => r.channel === "push")!;
    expect(row.status).toBe("queued"); // retrying, not dead-lettered yet (matches N2's email/sms retry test shape)
    expect(row.attempts).toBe(1);
  });
});
```
> Implementer: verify the exact driver-tick test helper — the N1/N2 driver tests likely call
> `notificationsDriver(config).__tick()` directly (see `driver.ts`'s `NotificationsDriver.__tick`
> doc comment) rather than a `built.tickDriver()` convenience; check
> `components/notifications/test/driver.test.ts` (N2) for the established pattern and match it
> exactly instead of inventing a new helper name.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Extend `render.ts`.** Add `renderPush` (mirrors `renderInApp`):
```ts
export function renderPush(config: NotificationsConfig, template: string | InlineTemplate, data: Record<string, unknown> | undefined): PushContent {
  if (typeof template === "string") {
    const fn = config.channels.push?.templates?.[template];
    if (!fn) throw noTemplateError("push", template);
    return fn(data ?? {});
  }
  if (!template.push) throw new Error(`inline template has no "push" content but "push" was in channels`);
  return template.push;
}
```
Extend `DeliverEntry` and `deliverOutbound`:
```ts
export interface PushTokenEntry { token: string; provider: PushProviderKind }

export interface DeliverEntry {
  channel: "email" | "sms" | "push";
  to: string;
  payload: EmailContent | SmsPayload | PushContent;
  tokens?: PushTokenEntry[];   // push only
  idempotencyKey?: string;
}

export async function deliverOutbound(config: NotificationsConfig, e: DeliverEntry): Promise<PushSendResult> {
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
        const res = await provider.send(compact({ to: toks, title: content.title, body: content.body, data: content.data, idempotencyKey: e.idempotencyKey }));
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
  if (e.channel === "email") { /* ...UNCHANGED... */ }
  const ch = config.channels.sms; /* ...UNCHANGED... */
}
```
Import `NotificationSendError`, `PushContent`, `PushProviderKind`, `PushSendResult` at the top.
- [ ] **Step 4: Extend `modules.ts`.**
  - `resolveAddress`: push requires `to.userId` (same branch as in_app — extend the existing
    `if`/`return` chain, don't duplicate the in_app check; e.g. `if (channel === "in_app" ||
    channel === "push") { if (!to.userId) throw ...; return to.userId; }`).
  - `assertConfigured`: add `if (channel === "push" && !config.channels.push) throw new Error(...)`.
  - `QueuedMessage`: widen `channel: "email" | "sms" | "push"`, add `tokens?: PushTokenEntry[]`.
  - `recordSend`'s per-channel loop: add a `channel === "push"` branch BEFORE the existing
    `if (channel === "in_app") {...} else {...}` — reorder to `if (in_app) {...} else if (push)
    {...} else {...}`:
```ts
    } else if (channel === "push") {
      const tokenRows = await db.query("pushTokens", "byUser").eq("userId", to).collect();
      const tokens: PushTokenEntry[] = tokenRows.map((r) => ({ token: r.token as string, provider: r.provider as PushProviderKind }));
      const content = renderPush(config, args.template, args.data);
      const messageId = (await db.insert("messages", compact({
        channel: "push", to, status: "queued", createdAt: now, idempotencyKey: args.idempotencyKey, templateKey, dataHash,
        payload: content as unknown as Value, tokens: tokens.length ? tokens : undefined,
      }))) as string;
      messageIds.push(messageId);
      queued.push({ _id: messageId, channel: "push", to, payload: content, tokens });
    } else {
```
  - `_peekQueued`: change the defensive skip from `r.channel !== "email" && r.channel !== "sms"` to
    also allow `"push"`, and thread `tokens` through into the returned `QueuedMessage`:
```ts
      if (r.channel !== "email" && r.channel !== "sms" && r.channel !== "push") continue;
      // ...
      ready.push({ _id: r._id as string, channel: r.channel as "email" | "sms" | "push", to: r.to as string, payload: r.payload as unknown as EmailContent | SmsPayload | PushContent, tokens: r.tokens as PushTokenEntry[] | undefined });
```
  - Add `_pruneInvalidPushTokens` to `makeSendModules`'s returned module set (near `_markResult`):
```ts
  const _pruneInvalidPushTokens = mutation(async (ctx: MutationCtx, args: { tokens: string[] }): Promise<null> => {
    for (const token of args.tokens) {
      const [row] = await ctx.db.query("notifications/pushTokens", "byToken").eq("token", token).take(1).collect();
      if (row) await ctx.db.delete(row._id as string);
    }
    return null;
  });
  // ...
  return { _enqueueSend, _peekQueued, _claimForSend, _markResult, _reclaimStuck, _pruneInvalidPushTokens };
```
> Note the fully-qualified `"notifications/pushTokens"` literal — matches `_claimForSend`/
> `_markResult`/`_reclaimStuck`'s existing convention for driver-facing internals in this file (see
> `modules.ts`'s own comment on why: these run PRIVILEGED regardless of call site).
- [ ] **Step 5: Wire the prune call in `driver.ts`.** In `runPass`'s per-message try block, right
  after the existing `deliverOutbound(...)` call resolves successfully, before/alongside
  `_markResult`:
```ts
          try {
            const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, tokens: m.tokens, idempotencyKey: `msg:${m._id}` });
            ok = true;
            providerMessageId = res.providerMessageId;
            if (res.invalidTokens?.length) {
              await ctx.runFunction("notifications:_pruneInvalidPushTokens", { tokens: res.invalidTokens });
            }
          } catch (e) { /* ...UNCHANGED... */ }
```
- [ ] **Step 6: Wire the same prune call in `facade.ts`'s `sendNow` drain loop** (the
  `notificationsActionContext` action facade) — identical shape, using `api.runMutation` instead of
  `ctx.runFunction`:
```ts
        try {
          const res = await deliverOutbound(config, { channel: m.channel, to: m.to, payload: m.payload, tokens: m.tokens, idempotencyKey: `msg:${m._id}` });
          ok = true;
          providerMessageId = res.providerMessageId;
          results.push(res);
          if (res.invalidTokens?.length) {
            await api.runMutation("notifications:_pruneInvalidPushTokens", { tokens: res.invalidTokens });
          }
        } catch (e) { error = String(e); }
```
- [ ] **Step 7: Widen `sendToTopic`'s allowed channels** (`facade.ts`). Change the type and the
  guard error message:
```ts
  sendToTopic(args: {
    topic: string;
    /** N3: `in_app`/push ONLY. A topic subscription stores just a `userId`, never an email/phone,
     *  so email/SMS fan-out can't resolve an address — send those directly with `send`/`sendNow`. */
    channels: Array<"in_app" | "push">;
    // ...
  }): Promise<...>;
```
```ts
      if (args.channels.some((c) => c !== "in_app" && c !== "push")) {
        throw new Error('sendToTopic supports only "in_app"/"push" channels (a topic knows a subscriber\'s userId, not their email/phone — send email/SMS directly with send/sendNow)');
      }
```
- [ ] **Step 8: Run — expect PASS.** `bunx vitest run test/push-core.test.ts`; full package
  `bunx vitest run` (N1-N4 suites must still pass — the `_peekQueued`/`deliverOutbound`/`recordSend`
  edits are additive branches, not rewrites of the email/sms paths); `bunx tsc --noEmit`.
- [ ] **Step 9: Commit.**
```bash
git add components/notifications/src/modules.ts components/notifications/src/render.ts components/notifications/src/driver.ts components/notifications/src/facade.ts components/notifications/src/topics.ts components/notifications/test/push-core.test.ts
git commit -m "feat(notifications): push channel T3 — recordSend/driver fan-out + invalid-token pruning + sendToTopic push support"
```

---

## Task 4: `expoPush()` adapter (parallelizable — depends only on T1)

**Files:** Create `provider-expo.ts`, `test/provider-expo.test.ts`.

- [ ] **Step 1: Write the test** (mocked `fetch`, following `provider-resend.ts`'s/
  `provider-twilio.ts`'s existing unit-test shape — check
  `components/notifications/test/provider-resend.test.ts` for the exact mock-fetch harness pattern
  and reuse it):
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { expoPush } from "../src/provider-expo";
import { NotificationSendError } from "../src/provider";

describe("expoPush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends a batch of messages in one POST, parses tickets into invalidTokens", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ status: "ok", id: "receipt1" }, { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = expoPush();
    const res = await provider.send({ to: ["ExponentPushToken[a]", "ExponentPushToken[b]"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["ExponentPushToken[b]"]);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as Array<{ to: string }>;
    expect(body).toHaveLength(2);
  });

  it("chunks a batch larger than 100 into multiple requests", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: Array(100).fill({ status: "ok" }) }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = expoPush();
    const tokens = Array.from({ length: 150 }, (_, i) => `tok${i}`);
    await provider.send({ to: tokens, title: "T", body: "B" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // 100 + 50
  });

  it("throws NotificationSendError on non-2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(expoPush().send({ to: ["t"], title: "T", body: "B" })).rejects.toThrow(NotificationSendError);
  });
});
```
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `provider-expo.ts`.**
```ts
import type { PushProvider, PushMessage, PushSendResult } from "./provider";
import { NotificationSendError } from "./provider";

const CHUNK_SIZE = 100; // Expo's documented per-request message cap

interface ExpoTicket { status: "ok" | "error"; id?: string; message?: string; details?: { error?: string } }

/** Simplest push adapter: ONE HTTP endpoint, no auth required for anonymous sends (an optional
 *  `accessToken` enables Expo's enhanced security / higher rate limits). Auto-chunks a large `to`
 *  array into <=100-message requests (Expo's documented cap) — invisible to the caller, one logical
 *  send still yields one merged result. A per-token "error" ticket with
 *  `details.error === "DeviceNotRegistered"` maps to `invalidTokens`; any other per-ticket error is
 *  logged but not treated as a prunable token (could be transient — rate limit, malformed payload). */
export function expoPush(opts?: { accessToken?: string; baseUrl?: string }): PushProvider {
  const base = opts?.baseUrl ?? "https://exp.host/--/api/v2/push";
  return {
    channel: "push",
    async send(m: PushMessage): Promise<PushSendResult> {
      const invalidTokens: string[] = [];
      let providerMessageId: string | undefined;
      for (let i = 0; i < m.to.length; i += CHUNK_SIZE) {
        const chunk = m.to.slice(i, i + CHUNK_SIZE);
        const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
        if (opts?.accessToken) headers.authorization = `Bearer ${opts.accessToken}`;
        const res = await fetch(`${base}/send`, {
          method: "POST",
          headers,
          body: JSON.stringify(chunk.map((to) => ({ to, title: m.title, body: m.body, data: m.data }))),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new NotificationSendError(`expo push send failed (${res.status}): ${body}`, { retryable: res.status >= 500 || res.status === 429 });
        }
        const json = (await res.json().catch(() => ({}))) as { data?: ExpoTicket[] };
        (json.data ?? []).forEach((ticket, idx) => {
          if (ticket.status === "ok") { providerMessageId ??= ticket.id; return; }
          if (ticket.details?.error === "DeviceNotRegistered") invalidTokens.push(chunk[idx]!);
        });
      }
      return invalidTokens.length ? { providerMessageId, invalidTokens } : { providerMessageId };
    },
  };
}
```
- [ ] **Step 4: Run — expect PASS.** `bunx vitest run test/provider-expo.test.ts`; `bunx tsc --noEmit`.
- [ ] **Step 5: Commit.**
```bash
git add components/notifications/src/provider-expo.ts components/notifications/test/provider-expo.test.ts
git commit -m "feat(notifications): push channel T4 — expoPush adapter (chunked batch send + invalid-token tickets)"
```

---

## Task 5: `fcmPush()` adapter (parallelizable — depends only on T1)

**Files:** Create `provider-fcm.ts`, `test/provider-fcm.test.ts`; Modify `package.json` (add `jose`).

- [ ] **Step 1: Add the `jose` dependency.** In `components/notifications/package.json`'s
  `dependencies`, add `"jose": "6.2.3"` (pin to the SAME version `components/auth/package.json`
  already uses — no version drift within the monorepo). Run `bun install` at the repo root after.
- [ ] **Step 2: Write the test** (mock both the token endpoint AND the send endpoint):
```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fcmPush } from "../src/provider-fcm";
import { NotificationSendError } from "../src/provider";

const SERVICE_ACCOUNT = {
  client_email: "svc@test.iam.gserviceaccount.com",
  // A real (test-only, not a real credential) PKCS8 RSA private key would go here — generate a
  // throwaway test keypair with `node:crypto`'s `generateKeyPairSync("rsa", {modulusLength:2048})`
  // in a `beforeAll`, export as PKCS8 PEM, and use it as `private_key` (jose's SignJWT needs a real
  // importable key to construct a well-formed JWT even against a mocked token endpoint).
  private_key: "REPLACE_WITH_GENERATED_TEST_KEY_PEM",
};

describe("fcmPush", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exchanges the service-account JWT for an access token, then sends one request per token", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("oauth2.googleapis.com")) return new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ name: "projects/p/messages/1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = fcmPush({ projectId: "p", serviceAccount: SERVICE_ACCOUNT });
    await provider.send({ to: ["fcmtok1", "fcmtok2"], title: "T", body: "B" });
    expect(calls.filter((u) => u.includes("messages:send"))).toHaveLength(2); // one request PER token
  });

  it("caches the access token across sends within its lifetime", async () => {
    const tokenCalls = vi.fn(async () => new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 }));
    const fetchMock = vi.fn(async (url: string) => url.includes("oauth2.googleapis.com") ? tokenCalls() : new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = fcmPush({ projectId: "p", serviceAccount: SERVICE_ACCOUNT });
    await provider.send({ to: ["a"], title: "T", body: "B" });
    await provider.send({ to: ["b"], title: "T", body: "B" });
    expect(tokenCalls).toHaveBeenCalledTimes(1); // second send reuses the cached token
  });

  it("maps UNREGISTERED to invalidTokens without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.includes("oauth2.googleapis.com")
      ? new Response(JSON.stringify({ access_token: "AT1", expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ error: { status: "UNREGISTERED" } }), { status: 404 })));
    const provider = fcmPush({ projectId: "p", serviceAccount: SERVICE_ACCOUNT });
    const res = await provider.send({ to: ["dead"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["dead"]);
  });
});
```
> Implementer: generating a real test RSA keypair is a REQUIRED first sub-step of this test file
> (not optional) — `jose`'s JWT signing will reject a placeholder string. Use a `beforeAll` with
> `node:crypto.generateKeyPairSync` exporting PKCS8, or hardcode one fixed throwaway 2048-bit test
> key as a module-level constant (clearly commented as test-only, never used against a real Google
> project).
- [ ] **Step 3: Run — expect FAIL.**
- [ ] **Step 4: Implement `provider-fcm.ts`.**
```ts
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
 *  provider GROUP regardless of token count). */
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
```
> Note the throw-on-first-non-invalid-error behavior INSIDE the per-token loop: a single bad token
> in a multi-token FCM group that returns a genuine 5xx aborts the REST of that group's loop (the
> remaining tokens in the same provider group are not attempted this pass). This is an accepted v1
> simplification — flag it in a code comment; a future refinement could collect partial results
> per-token instead of throwing on the first hard failure. Do not silently swallow it without
> comment; either behavior needs to be a documented, deliberate choice, not an accident.
- [ ] **Step 5: Run — expect PASS.** `bunx vitest run test/provider-fcm.test.ts`; `bunx tsc --noEmit`.
- [ ] **Step 6: Commit.**
```bash
git add components/notifications/package.json components/notifications/src/provider-fcm.ts components/notifications/test/provider-fcm.test.ts
git commit -m "feat(notifications): push channel T5 — fcmPush adapter (service-account OAuth2 + cached token)"
```

---

## Task 6: `apnsPush()` adapter (parallelizable — depends only on T1)

**Files:** Create `provider-apns.ts`, `test/provider-apns.test.ts`.

- [ ] **Step 1: Write the test against a REAL local `node:http2` server** (not a mocked `fetch` —
  this adapter deliberately does not use `fetch`, so the test must prove the actual HTTP/2
  transport works, per the design doc's testing section):
```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http2 from "node:http2";
import { generateKeyPairSync } from "node:crypto";
import { apnsPush } from "../src/provider-apns";

let server: http2.Http2SecureServer | http2.Http2Server;
let baseUrl: string;
let lastRequest: { path: string; auth: string | undefined; body: string } | null = null;
let responseStatus = 200;
let responseBody: Record<string, unknown> = {};

// APNs' real endpoint is TLS; for a local test, run a PLAINTEXT http2 server (`http2.createServer`,
// not `createSecureServer`) and point the adapter's `baseUrl` at `http://` — verify `apnsPush`
// accepts an http(s)-agnostic baseUrl override for exactly this test seam (production always uses
// the real `https://api.push.apple.com`, hardcoded default).
beforeAll(async () => {
  server = http2.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { path: req.url!, auth: req.headers.authorization, body };
      res.writeHead(responseStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const TEST_KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

describe("apnsPush", () => {
  it("sends a well-formed JWT (kid/iss) and the aps payload, per-token, over http2", async () => {
    responseStatus = 200; responseBody = {};
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl } as never);
    await provider.send({ to: ["devtok1"], title: "T", body: "B" });
    expect(lastRequest?.path).toBe("/3/device/devtok1");
    expect(lastRequest?.auth).toMatch(/^bearer /i);
    const payload = JSON.parse(lastRequest!.body) as { aps: { alert: { title: string; body: string } } };
    expect(payload.aps.alert).toEqual({ title: "T", body: "B" });
  });

  it("maps a 410/Unregistered response to invalidTokens", async () => {
    responseStatus = 410; responseBody = { reason: "Unregistered" };
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl } as never);
    const res = await provider.send({ to: ["devtok1"], title: "T", body: "B" });
    expect(res.invalidTokens).toEqual(["devtok1"]);
  });

  it("throws NotificationSendError on a 5xx", async () => {
    responseStatus = 500; responseBody = { reason: "InternalServerError" };
    const provider = apnsPush({ teamId: "TEAM1", keyId: "KEY1", privateKey: TEST_KEY_PEM, bundleId: "com.test.app", production: false, baseUrl } as never);
    await expect(provider.send({ to: ["devtok1"], title: "T", body: "B" })).rejects.toThrow(/500|InternalServerError/);
  });
});
```
> Implementer: a plaintext `http2.createServer` (no TLS) IS a valid h2 target for Node's
> `http2.connect(url)` client when the url scheme is `http:` (h2c — h2-without-TLS — Node's http2
> client supports it for exactly this kind of local test; the PRODUCTION default must still be
> `https://api.push.apple.com`/`https://api.sandbox.push.apple.com`, TLS always, driven by
> `production?: boolean`). Confirm this works in a throwaway spike before committing to it as the
> test strategy; if Node's http2 client refuses h2c, fall back to `http2.createSecureServer` with a
> locally-generated self-signed cert AND pass that cert's CA explicitly to the client via
> `http2.connect(url, { ca: <the test cert> })` — i.e. the client trusts this ONE test certificate
> by name, same as adding a dev CA to a trust store. Do NOT reach for a global TLS-verification
> disable (`rejectUnauthorized: false` / `NODE_TLS_REJECT_UNAUTHORIZED=0`) even scoped to this test
> file — it's unnecessary (h2c or an explicit `ca` option both work) and is exactly the kind of
> footgun that leaks into production if ever copy-pasted. If neither works cleanly, use an
> http2-mocking library already in the monorepo's devDependencies (check first — don't add a new
> dep for this alone).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `provider-apns.ts`.**
```ts
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
 *  avoid rate-limiting the token-generation endpoint... note: unlike FCM, APNs JWTs are
 *  SELF-SIGNED locally, not exchanged over the network — "refresh" here means re-sign, not re-fetch). */
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
        const status = (req as unknown as { rstCode?: number }).rstCode; // fallback path if headers missed
        void status;
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
        if (errors.length > 0) throw new NotificationSendError(`apns send failed: ${errors.join("; ")}`, { retryable: true });
        return invalidTokens.length ? { providerMessageId, invalidTokens } : { providerMessageId };
      } finally {
        session.close();
      }
    },
  };
}
```
> Implementer: the `http2.ClientHttp2Session` per-send connect/close (rather than a long-lived
> pooled session reused across sends) is a DELIBERATE v1 simplification for correctness-first
> simplicity — flag it in a comment as a known perf follow-up (Apple's guidance is actually to KEEP
> a connection open across many sends; reconnecting per logical send works but is not the
> recommended long-run pattern). Do not over-engineer connection pooling into v1; note it as a
> non-goal in the code comment and move on.
- [ ] **Step 4: Run — expect PASS.** `bunx vitest run test/provider-apns.test.ts`; `bunx tsc --noEmit`.
- [ ] **Step 5: Commit.**
```bash
git add components/notifications/src/provider-apns.ts components/notifications/test/provider-apns.test.ts
git commit -m "feat(notifications): push channel T6 — apnsPush adapter (ES256 JWT + node:http2 transport)"
```

---

## Task 7: `index.ts` exports, client `registerForPush`, E2E, docs (sequential — depends on T1-T6)

**Files:** Modify `index.ts`, `packages/client/src/notifications.tsx`; Create
`packages/cli/test/notifications-push-e2e.test.ts`; Modify `docs/enduser/build/notifications.md`.

- [ ] **Step 1: Wire `index.ts` exports.** Add to the provider-type export block:
```ts
export type {
  SendResult, EmailMessage, SmsMessage, EmailProvider, SmsProvider, PushMessage, PushProvider, PushSendResult, NotificationProvider,
  EmailContent, SmsPayload, InAppContent, PushContent,
  DeliveryStatus, WebhookEvent, WebhookVerifyArgs, ProviderWebhook,
} from "./provider";
```
Add to the config-type export block:
```ts
export type {
  NotificationsOptions, NotificationsConfig, NotificationChannels,
  EmailChannelConfig, SmsChannelConfig, InAppChannelConfig, PushChannelConfig,
  EmailTemplates, SmsTemplates, InAppTemplates, PushTemplates,
  EmailTemplateFn, SmsTemplateFn, InAppTemplateFn, PushTemplateFn,
  Channel, PushProviderKind, Recipient, InlineTemplate, SendArgs,
  DigestFrequency, DigestItem, DigestTemplateFn,
} from "./config";
```
Add the three adapters next to the existing provider export line:
```ts
export { consoleEmail, consoleSms } from "./provider-console";
export { resendEmail } from "./provider-resend";
export { twilioSms } from "./provider-twilio";
export { expoPush } from "./provider-expo";
export { fcmPush } from "./provider-fcm";
export { apnsPush } from "./provider-apns";
```
- [ ] **Step 2: Add `registerForPush`/`unregisterForPush` to the client** (`packages/client/src/
  notifications.tsx`). Check the file's existing imports for however it accesses the raw client
  (the file currently only exposes REACT hooks — `registerForPush` is a plain async function, not a
  hook, since token registration typically happens once at app-boot/permission-grant time, not
  inside a component render; confirm whether `StackbaseClient` is already imported/typed anywhere
  in this file or needs a fresh import from `./client`):
```ts
import type { StackbaseClient } from "./client";

const REGISTER_PUSH_PATH = "notifications:registerPushToken";
const UNREGISTER_PUSH_PATH = "notifications:unregisterPushToken";

/** Register this device's push token for the CURRENT authenticated caller (self-only, server-
 *  resolved — see `docs/superpowers/specs/2026-04-13-notifications-push-channel-design.md`).
 *  Acquiring the actual OS token (Expo `getExpoPushTokenAsync()`, a native FCM/APNs SDK, or a web
 *  `PushManager.subscribe`) is the caller's responsibility — this is a thin wire call, nothing
 *  more, matching `useNotifications`'s scope boundary for the inbox. */
export async function registerForPush(client: StackbaseClient, args: { token: string; provider: "expo" | "fcm" | "apns"; platform?: "ios" | "android" | "web" }): Promise<void> {
  await client.mutation(REGISTER_PUSH_PATH, args as unknown as Record<string, Value>);
}

export async function unregisterForPush(client: StackbaseClient, args: { token: string }): Promise<void> {
  await client.mutation(UNREGISTER_PUSH_PATH, args as unknown as Record<string, Value>);
}
```
Also widen `NotificationPreference.channel` to include `"push"`:
```ts
export interface NotificationPreference {
  category: string;
  channel?: "email" | "sms" | "in_app" | "push";
  enabled: boolean;
}
```
Re-export from `react.tsx` if that's where the file's other exports get re-exported (check the
existing `useNotifications`/`useNotificationPreferences` re-export lines and mirror them).
- [ ] **Step 3: Write the E2E test.** Create `packages/cli/test/notifications-push-e2e.test.ts`,
  mirroring `notifications-e2e.test.ts`'s/`notifications-preferences-e2e.test.ts`'s real-server
  boot pattern (`loadProject`/`createEmbeddedRuntime`/`startDevServer`/`StackbaseClient`+
  `webSocketTransport`). Two cases:
  1. A capture `expoPush` provider composed via `defineNotifications({channels:{push:{providers:
     {expo: capture}}}})`; a client mutation registers a push token (`registerForPush`), then a
     mutation calls `ctx.notifications.send({channels:["push"]})`; assert the capture provider
     receives the exact `{to, title, body, data}` and the `messages` row reaches `status:"sent"`
     (poll via an admin/browse read or a dedicated introspection query — check how
     `notifications-e2e.test.ts` observes driver-delivered status for its email case and mirror it
     exactly).
  2. Invalid-token pruning end-to-end: the capture provider returns `invalidTokens: [token]` on its
     first call; assert a SECOND `send` to the same user finds zero tokens (having been pruned) and
     the capture provider is NOT called a second time (skip-when-empty, decision 6, proven at the
     real-server level, not just the component-test level from T3).
- [ ] **Step 4: Build + run.** `cd <worktree root> && bun run build`, then
  `cd packages/cli && bunx vitest run test/notifications-push-e2e.test.ts` → PASS.
- [ ] **Step 5: Docs.** In `docs/enduser/build/notifications.md`, add a `## Push` section per the
  design doc's Docs section: the `channels.push.providers` map + all three adapters' credential
  shapes (Expo access token; FCM service-account JSON `{client_email, private_key}` + `projectId`;
  APNs `{teamId, keyId, privateKey, bundleId, production?}`), `registerPushToken`/`registerForPush`/
  `unregisterForPush`, the token→provider routing rule (by the token's OWN recorded `provider`, not
  OS platform), the "zero devices is not an error" behavior, invalid-token pruning, the partial-
  multi-provider-failure policy, and the honest v1 boundary (link to the design doc's Non-goals:
  no rich payload, no delivery/engagement receipts, no web push).
- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/index.ts packages/client/src/notifications.tsx packages/cli/test/notifications-push-e2e.test.ts docs/enduser/build/notifications.md
git commit -m "feat(notifications): push channel T7 — exports, client registerForPush, E2E through the real dev server, docs"
```

---

## Verification (after each task; full gate after T7)

```bash
bun run --filter @stackbase/notifications typecheck
bun run --filter @stackbase/notifications test
bun run --filter @stackbase/client typecheck
bun run build   # then: cd packages/cli && bunx vitest run test/notifications-push-e2e.test.ts
bun run build && bun run typecheck && bun run test   # whole-repo gate
```

Dist-resolution rule (per project memory: "tests resolve deps via dist"): rebuild
`@stackbase/notifications`/`@stackbase/client` before running the CLI E2E — editing `src/` is a
no-op for a cross-package test until the dependency's `dist/` is rebuilt.

## Self-Review

- **Spec coverage:** seam types + config (T1), device-token registry + self-only registration + the
  IDOR-safe upsert-by-token model (T2), `recordSend`/driver/facade push branch + invalid-token
  pruning + partial-failure policy + `sendToTopic` widening (T3), all three provider adapters (T4/
  T5/T6, parallel), exports + client surface + E2E + docs (T7). Every locked decision in the design
  doc maps to a task.
- **Type consistency:** `Channel`/`NotificationProvider`/`InlineTemplate` widened once (T1),
  consumed everywhere else; `PushProviderKind` defined once (T1: config.ts), reused in
  `pushTokens.provider` (T2 schema), `QueuedMessage.tokens`/`DeliverEntry.tokens` (T3), and every
  adapter's routing (T4-T6 don't need it directly — they only see their OWN token array, routing
  happens in `deliverOutbound`, T3).
- **Single chokepoint preserved:** the push branch lives INSIDE `recordSend` (T3), not a parallel
  function — N3 preferences/critical-bypass and `sendReceipts` idempotency apply to push with zero
  additional code. `deliverOutbound` stays the one dispatch function both the driver and `sendNow`
  call (T3) — no `deliverPush` split.
- **Self-only IDOR guard, explicitly tested:** T2's third test case asserts a smuggled `userId` arg
  on the client-callable module is ignored at RUNTIME, not just absent from the TS type — the
  strongest form of this check available given the type system can't stop a raw-JSON caller.
- **Boundary rule:** every new `db.insert`/`db.replace`/`runMutation`/`runFunction`/wire-return uses
  `compact` (T2's `registerPushTokenImpl`, T3's `recordSend` push branch, `deliverOutbound`'s
  return, `_pruneInvalidPushTokens`'s call sites).
- **Parallelization is real, not cosmetic:** T4/T5/T6 each create a brand-new file and a brand-new
  test file, touching NOTHING T1-T3 touch — three agents/workers can run them concurrently once T1
  lands, with T7 as the sole integration/merge point.
