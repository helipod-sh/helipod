# Notifications N3 — Preferences + Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user per-category per-channel notification preferences that gate the send path (with a critical-bypass), plus topics (subscribe + a preference-aware `sendToTopic` fan-out), to `@stackbase/notifications` on the merged N2 substrate.

**Architecture:** Preferences gate at the single `recordSend` chokepoint, so every send path (direct/sendNow/topic fan-out) honors consent uniformly; the send RESULT reports suppressed channels (API-additive, no `messages.status` change). Topics are a subscription table + an action-paginated fan-out that reuses the N1 queued-send path (no new driver). Critical categories (config-declared) bypass the gate and can't be opted out.

**Tech Stack:** TypeScript; `@stackbase/executor` (`mutation`/`query`/`ctx.now`, `db.query(...).paginate({cursor,pageSize,maxScan})`), `@stackbase/values` (`v`, schema); vitest.

## Global Constraints

- **Additive schema only.** New tables + new optional fields; no changed/removed field. No new `messages.status` literal (suppression is reported via the send RETURN, not a status).
- **`compact()` at EVERY codec boundary — args AND returns AND `db.insert`/`db.replace`.** The JSON codec rejects an `undefined`-valued key. (This slice hit it repeatedly in N1/N2.)
- **No `Date.now()`/`Math.random()` in a UDF.** All time via `ctx.now()`.
- **Consent honored at the single chokepoint:** the gate lives in `recordSend` only — do NOT add a second gate elsewhere; every caller (`send`, `sendNow`, `sendToTopic`) routes through `recordSend`.
- **Default-allow:** absence of a preference row = opted in. Most-specific wins: channel-specific > category-wide (`channel` absent) > `true`.
- **Critical categories** (`config.categories[cat]?.critical === true`) bypass the gate for every channel AND the setter refuses to disable them.
- **Server-resolved identity for self-service:** `setPreference`/`getPreferences` resolve the caller's own userId (never a client arg), same ownership model as the inbox. `subscribe`/`unsubscribe`/`send`/`sendToTopic` take a server-controlled `userId`/`to` (the app decides who), defaulting to the caller where noted.
- Naming: preference table `notificationPreferences`; topic table `topicSubscriptions`; category defaults to `config.defaultCategory ?? "default"`.

---

## File Structure

- `components/notifications/src/schema.ts` — MODIFY: add `notificationPreferences` + `topicSubscriptions` tables.
- `components/notifications/src/config.ts` — MODIFY: `defaultCategory`/`categories` on options+config+resolve; `SendArgs.category?`.
- `components/notifications/src/preferences.ts` — CREATE: `isCritical`, `resolvePreference` (the gate), `makePreferenceModules` (`setPreference`/`getPreferences`).
- `components/notifications/src/inbox.ts` — MODIFY: `export` the `callerId` helper (reused by preferences/topics).
- `components/notifications/src/modules.ts` — MODIFY: `recordSend` runs the gate + returns `suppressed`; `_enqueueSend` returns `suppressed`.
- `components/notifications/src/facade.ts` — MODIFY: `send`/`sendNow` return `{ messageIds, suppressed }`; add `setPreference`/`getPreferences`/`subscribe`/`unsubscribe` to the mutation context and `sendToTopic` to the action context.
- `components/notifications/src/topics.ts` — CREATE: `makeTopicModules` (`subscribe`/`unsubscribe`/`_recordSendBatch`) + the fan-out mutation.
- `components/notifications/src/index.ts` — MODIFY: spread `makePreferenceModules` + `makeTopicModules`; export types.
- `packages/client/src/notifications.tsx` — MODIFY: add `useNotificationPreferences`; `react.tsx` re-export.
- Tests: `test/preferences.test.ts` (T1+T2), `test/topics.test.ts` (T3+T4), `packages/cli/test/notifications-preferences-e2e.test.ts` (T5).
- `docs/enduser/build/notifications.md` — MODIFY (T5).

**Execution note:** agent worktree-isolation is broken this session — build tasks SEQUENTIALLY in the one worktree. T2 (prefs API) and T3 (topics) are logically independent but both touch `facade.ts`/`index.ts`, so they are serialized in practice; that's fine.

---

## Task 1: Preferences foundation — schema, config, the gate, suppressed result

**Files:** Modify `schema.ts`, `config.ts`, `inbox.ts`; Create `preferences.ts`; Modify `modules.ts`, `facade.ts`; Test `test/preferences.test.ts`.

**Interfaces:**
- Produces: `resolvePreference(db, userId, category, channel): Promise<boolean>`, `isCritical(config, category): boolean`; `NotificationsConfig.defaultCategory: string` + `.categories: Record<string,{critical?:boolean}>`; `SendArgs.category?: string`; `recordSend(...) → { messageIds, deduped, queued, suppressed: Channel[] }`; `send`/`sendNow` → `{ messageIds, suppressed: Channel[] }`; `callerId` exported from `inbox.ts`.

- [ ] **Step 1: Extend the schema.** In `schema.ts`, add two tables to `defineSchema({ ... })` (after `sendReceipts`):

```ts
  notificationPreferences: defineTable({
    userId: v.string(),
    category: v.string(),
    channel: v.optional(v.union(v.literal("email"), v.literal("sms"), v.literal("in_app"))), // absent = category-wide
    enabled: v.boolean(),
    updatedAt: v.number(),
  })
    .index("byUser", ["userId"])           // getPreferences: all of a user's rows
    .index("byUserCategory", ["userId", "category"]), // the gate: a user's rows for one category

  topicSubscriptions: defineTable({
    topic: v.string(),
    userId: v.string(),
    createdAt: v.number(),
  })
    .index("byTopic", ["topic"])           // fan-out scan
    .index("byUserTopic", ["userId", "topic"]), // dedup on subscribe / unsubscribe lookup
```

- [ ] **Step 2: Extend config.** In `config.ts`, add `category?` to `SendArgs`:
```ts
export interface SendArgs {
  to: Recipient;
  channels: Channel[];
  template: string | InlineTemplate;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  category?: string;   // N3 — preferences/criticality key; defaults to config.defaultCategory
}
```
Add to `NotificationsOptions`:
```ts
  /** The category a send uses when it names none. Default "default". */
  defaultCategory?: string;
  /** Per-category config; a `critical` category bypasses preferences and can't be opted out. */
  categories?: Record<string, { critical?: boolean }>;
```
Add to `NotificationsConfig`:
```ts
  defaultCategory: string;
  categories: Record<string, { critical?: boolean }>;
```
In `resolveNotificationsConfig`, add to the returned object:
```ts
    defaultCategory: opts.defaultCategory ?? "default",
    categories: opts.categories ?? {},
```

- [ ] **Step 3: Export `callerId` from inbox.ts.** In `inbox.ts` change `async function callerId(` to `export async function callerId(` (it's reused by preferences and topics — one identity-resolution definition).

- [ ] **Step 4: Write the gate test.** Create `test/preferences.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makePreferenceModules } from "../src/preferences";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";
import type { JSONValue } from "@stackbase/values";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: { channel: "email", async send() { return {}; } }, from: "x@test", templates: { hi: () => ({ subject: "S", text: "T" }) } },
      in_app: { enabled: true, templates: { hi: () => ({ title: "Hi", body: "B" }) } },
    },
    categories: { security: { critical: true } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePreferenceModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}

const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, args: any) => ctx.notifications.send(args)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:setPref": mutation(async (ctx: any, args: any) => ctx.notifications.setPreference(args)),
};
async function runAs(built: BuiltNotifRuntime, identity: string | null, path: string, args: JSONValue): Promise<unknown> {
  return (await built.runtime.run(path, args, { identity })).value;
}

let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N3 — preference gate", () => {
  it("suppresses a channel the user opted out of (and reports it)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // u1 opts out of marketing email.
    await runAs(built, "u1", "app:setPref", { category: "marketing", channel: "email", enabled: false });
    const res = (await runAs(built, "u1", "app:send", {
      to: { userId: "u1", email: "u1@test" }, channels: ["in_app", "email"], template: "hi", category: "marketing",
    })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual(["email"]);
    const rows = await built.readTable("notifications/messages");
    expect(rows.map((r) => r.channel).sort()).toEqual(["in_app"]); // no email row
  });

  it("default-allow: no preference row → the channel sends", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "marketing" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });

  it("a critical category ignores an opt-out and delivers", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    // Even if a stale opt-out row existed, a critical category bypasses it. (The setter refuses to
    // create one — tested in T2 — so we assert the gate side here via a non-critical opt-out that a
    // critical send is unaffected by: opt out of "security" email is impossible, so use the config.)
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "security" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });

  it("a recipient with no userId is never gated", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await runAs(built, null, "app:send", { to: { email: "anon@test" }, channels: ["email"], template: "hi", category: "marketing" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });
});
```

- [ ] **Step 5: Run — expect FAIL** (`../src/preferences` missing; `setPreference`/`suppressed` unimplemented). Run: `cd components/notifications && bunx vitest run test/preferences.test.ts`.

- [ ] **Step 6: Create `preferences.ts`** (gate + `isCritical` + the API modules — the API is used by T1's test's `app:setPref`; `getPreferences`/critical-refuse are exercised further in T2):

```ts
import { mutation, query, type MutationCtx, type QueryCtx, type RegisteredFunction } from "@stackbase/executor";
import type { GuestDatabaseReader } from "@stackbase/executor";
import type { NotificationsConfig, Channel } from "./config";
import { compact } from "./render";
import { callerId } from "./inbox";

/** A category is critical (bypasses preferences, can't be opted out) iff config marks it so. */
export function isCritical(config: NotificationsConfig, category: string): boolean {
  return config.categories[category]?.critical === true;
}

/**
 * Resolve whether `(userId, category, channel)` is enabled. DEFAULT-ALLOW: no matching row → true.
 * Most-specific wins: a channel-specific row's `enabled` > a category-wide row's (channel absent)
 * `enabled` > true. One `byUserCategory` fetch, resolved in memory. Runs namespaced (bare table).
 */
export async function resolvePreference(db: GuestDatabaseReader, userId: string, category: string, channel: Channel): Promise<boolean> {
  const rows = await db.query("notificationPreferences", "byUserCategory").eq("userId", userId).eq("category", category).collect();
  let categoryWide: boolean | undefined;
  for (const r of rows) {
    if (r.channel === channel) return r.enabled as boolean;        // channel-specific — authoritative
    if (r.channel === undefined || r.channel === null) categoryWide = r.enabled as boolean;
  }
  return categoryWide ?? true;
}

/** `setPreference`/`getPreferences` — the caller's OWN preferences (server-resolved identity). */
export function makePreferenceModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setPreference = mutation(async (ctx: any, args: { category: string; channel?: Channel; enabled: boolean }): Promise<null> => {
    const userId = await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    if (isCritical(config, args.category) && !args.enabled) {
      throw new Error(`category "${args.category}" is critical and cannot be disabled`);
    }
    // Upsert the (userId, category, channel|∅) row.
    const rows = await (ctx as MutationCtx).db.query("notificationPreferences", "byUserCategory").eq("userId", userId).eq("category", args.category).collect();
    const existing = rows.find((r) => (r.channel ?? null) === (args.channel ?? null));
    if (existing) {
      await (ctx as MutationCtx).db.replace(existing._id as string, compact({ ...existing, channel: args.channel, enabled: args.enabled, updatedAt: (ctx as MutationCtx).now() }));
    } else {
      await (ctx as MutationCtx).db.insert("notificationPreferences", compact({ userId, category: args.category, channel: args.channel, enabled: args.enabled, updatedAt: (ctx as MutationCtx).now() }));
    }
    return null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getPreferences = query(async (ctx: any): Promise<Array<{ category: string; channel?: Channel; enabled: boolean }>> => {
    const userId = await callerId(ctx);
    if (!userId) return [];
    const rows = await (ctx as QueryCtx).db.query("notificationPreferences", "byUser").eq("userId", userId).collect();
    return rows.map((r) => compact({ category: r.category as string, channel: r.channel as Channel | undefined, enabled: r.enabled as boolean }));
  });

  return { setPreference, getPreferences };
}
```

- [ ] **Step 7: Wire the gate into `recordSend`** (`modules.ts`). Add imports at the top: `import { resolvePreference, isCritical } from "./preferences";`. In `recordSend`, add the `suppressed` accumulator + `category`, and the gate in the loop. The changed parts:

```ts
export async function recordSend(db: GuestDatabaseWriter, now: number, config: NotificationsConfig, args: SendArgs): Promise<{ messageIds: string[]; deduped: boolean; queued: QueuedMessage[]; suppressed: Channel[] }> {
  if (args.idempotencyKey !== undefined) {
    const [existing] = await db.query("sendReceipts", "byKey").eq("idempotencyKey", args.idempotencyKey).take(1).collect();
    if (existing) return { messageIds: existing.messageIds as string[], deduped: true, queued: [], suppressed: [] };
  }
  const dataHash = stableHash(args.data);
  const templateKey = typeof args.template === "string" ? args.template : undefined;
  const category = args.category ?? config.defaultCategory;
  const messageIds: string[] = [];
  const queued: QueuedMessage[] = [];
  const suppressed: Channel[] = [];

  for (const channel of [...new Set(args.channels)]) {
    assertConfigured(config, channel);
    const to = resolveAddress(channel, args.to);
    // N3 preference gate — the SINGLE consent chokepoint. A recipient with a `userId` who opted out
    // of (category, channel) is suppressed, UNLESS the category is critical (OTP/security). No
    // `userId` → no preference identity → send proceeds. Read runs in the calling mutation's txn.
    const userId = args.to.userId;
    if (userId !== undefined && !isCritical(config, category) && !(await resolvePreference(db, userId, category, channel))) {
      suppressed.push(channel);
      continue;
    }
    if (channel === "in_app") {
      // ... UNCHANGED in_app insert block ...
    } else {
      // ... UNCHANGED email/sms insert block ...
    }
  }

  if (args.idempotencyKey !== undefined) {
    await db.insert("sendReceipts", { idempotencyKey: args.idempotencyKey, messageIds, createdAt: now });
  }
  return { messageIds, deduped: false, queued, suppressed };
}
```

(Leave the two insert blocks exactly as they are — only the loop header/gate + the return shape change. Do NOT alter the `compact(...)` inserts.)

Also update `_enqueueSend` in `makeSendModules` to thread `suppressed`:
```ts
  const _enqueueSend = mutation(async (ctx: MutationCtx, args: SendArgs): Promise<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[] }> => {
    const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, args);
    return { messageIds: r.messageIds, queued: r.queued, suppressed: r.suppressed };
  });
```

- [ ] **Step 8: Thread `suppressed` through the facades** (`facade.ts`). Update both context interfaces + impls. `NotificationsContext.send` and `NotificationsActionContext.send` return `{ messageIds: string[]; suppressed: Channel[] }`; `sendNow` returns `{ messageIds: string[]; results: SendResult[]; suppressed: Channel[] }`. Import `Channel`:
```ts
import type { NotificationsConfig, SendArgs, Channel } from "./config";
```
Mutation `send`:
```ts
    async send(args) {
      const r = await recordSend(cctx.db as GuestDatabaseWriter, cctx.now, config, args);
      return { messageIds: r.messageIds, suppressed: r.suppressed };
    },
```
Action `send`:
```ts
    async send(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
      return { messageIds: r.messageIds, suppressed: r.suppressed };
    },
```
Action `sendNow` (capture suppressed from the `_enqueueSend` result, return it):
```ts
    async sendNow(args) {
      const r = await api.runMutation<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[] }>("notifications:_enqueueSend", args as unknown as Record<string, unknown>);
      const results: SendResult[] = [];
      for (const m of r.queued) { /* ...UNCHANGED drain loop... */ }
      return { messageIds: r.messageIds, results, suppressed: r.suppressed };
    },
```
Update the interface signatures to match.

- [ ] **Step 9: Run — expect PASS** (4/4). Run: `bunx vitest run test/preferences.test.ts`. Then the full package `bunx vitest run` — N1/N2 tests must still pass; the send-result shape gained a `suppressed` field but existing tests read `.messageIds`/rows, unaffected. `bunx tsc --noEmit` clean.

- [ ] **Step 10: Commit.**
```bash
git add components/notifications/src/schema.ts components/notifications/src/config.ts components/notifications/src/preferences.ts components/notifications/src/inbox.ts components/notifications/src/modules.ts components/notifications/src/facade.ts components/notifications/test/preferences.test.ts
git commit -m "feat(notifications): N3 T1 — preference gate in recordSend + critical-bypass + suppressed result"
```

---

## Task 2: Preferences API surface + client hook

**Files:** Modify `facade.ts` (context methods), `index.ts` (wire + export), `packages/client/src/notifications.tsx` (+ `react.tsx`); Test: extend `test/preferences.test.ts`.

**Interfaces:**
- Consumes (T1): `makePreferenceModules`, `isCritical`, `callerId`.
- Produces: `ctx.notifications.setPreference`/`getPreferences` (facade); `useNotificationPreferences()` client hook.

- [ ] **Step 1: Add the facade methods** (`facade.ts`). Add to `NotificationsContext` (mutation/query side — these are read/write against the caller's own rows, so they live on the in-txn context):
```ts
  setPreference(args: { category: string; channel?: Channel; enabled: boolean }): Promise<null>;
  getPreferences(): Promise<Array<{ category: string; channel?: Channel; enabled: boolean }>>;
```
Implement them in `notificationsContext` by delegating to the registered modules via the guest ctx. Since the facade already holds `cctx`, call through `cctx` is not how modules are invoked — instead these methods are thin wrappers that the app calls; the actual logic is the registered `setPreference`/`getPreferences` modules. **Simplest correct wiring:** expose them on the context by calling the same helper functions directly. Refactor `makePreferenceModules`' bodies into exported helpers `setPreferenceImpl(db, now, config, userId, args)` / `getPreferencesImpl(db, userId)` in `preferences.ts`, and have BOTH the modules and the facade methods call them. The facade resolves `userId` via `callerId(cctx-like)`.

> Implementer: verify how other facades (e.g. the inbox's) expose caller-scoped reads/writes — the inbox exposes `identity()` and the inbox queries are registered MODULES, not facade methods. **Follow that precedent: do NOT add `setPreference`/`getPreferences` to the facade if the established pattern is registered modules called by the client over well-known paths.** If so, SKIP adding facade methods — the modules from T1 (`notifications:setPreference`/`getPreferences`) are the surface, reached by the client hook (Step 3) exactly like `useNotifications` reaches `notifications:inbox`. Prefer this: it matches N1. In that case this task is just Steps 2-4.

- [ ] **Step 2: Verify `index.ts` registers the preference modules.** `makePreferenceModules(config)` must be spread into `modules`. Add the import + spread:
```ts
import { makePreferenceModules } from "./preferences";
// ...
    modules: { ...makeSendModules(config), ...makeInboxModules(), ...makeWebhookModules(config), ...makePreferenceModules(config) },
```
Export the config types if useful:
```ts
// (categories/defaultCategory already flow via NotificationsOptions/Config exports)
```

- [ ] **Step 3: Add the client hook** (`packages/client/src/notifications.tsx`). Mirror `useNotifications`:
```ts
export interface NotificationPreference {
  category: string;
  channel?: "email" | "sms" | "in_app";
  enabled: boolean;
}
export interface UseNotificationPreferencesResult {
  preferences: NotificationPreference[];
  setPreference: (args: NotificationPreference) => Promise<void>;
}
const PREFS_GET = "notifications:getPreferences";
const PREFS_SET = "notifications:setPreference";
export function useNotificationPreferences(): UseNotificationPreferencesResult {
  const preferences = useQuery<NotificationPreference[]>(PREFS_GET, {}) ?? [];
  const setFn = useMutation<null>(PREFS_SET);
  return { preferences, setPreference: async (args) => { await setFn(args as unknown as Record<string, Value>); } };
}
```
(Add the `Value` import if not present — check the file's existing imports.) In `packages/client/src/react.tsx` add:
```ts
export { useNotificationPreferences } from "./notifications";
export type { NotificationPreference, UseNotificationPreferencesResult } from "./notifications";
```

- [ ] **Step 4: Extend the test.** Add to `test/preferences.test.ts` (a new `describe` or cases): `getPreferences` returns only the caller's rows; setting a critical category disabled throws; a channel-specific opt-out overrides a category-wide allow. Example:
```ts
describe("notifications N3 — preference API", () => {
  it("getPreferences returns the caller's rows; setting a critical category off throws", async () => {
    built = await makeNotifRuntime(comp(), { ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:getPrefs": (await import("@stackbase/executor")).query(async (ctx: any) => ctx.runQuery ? [] : undefined) as never,
    });
    await runAs(built, "u1", "app:setPref", { category: "marketing", channel: "sms", enabled: false });
    const prefs = (await runAs(built, "u1", "notifications:getPreferences", {})) as Array<{ category: string; enabled: boolean }>;
    expect(prefs).toEqual([{ category: "marketing", channel: "sms", enabled: false }]);
    await expect(runAs(built, "u1", "app:setPref", { category: "security", enabled: false })).rejects.toThrow(/critical/);
  });
});
```
> Implementer: `getPreferences`/`setPreference` are `notifications:`-prefixed registered modules (NOT `_`-prefixed), so they ARE client-callable via `runtime.run("notifications:getPreferences", {}, {identity})` — no `app:` wrapper needed for them (unlike `_`-prefixed internals). Simplify the test to call the `notifications:` paths directly with `runAs`.

- [ ] **Step 5: Run + typecheck.** `bunx vitest run test/preferences.test.ts` (all pass); `cd packages/client && bun run build && bunx vitest run` (client builds + dist-browser-clean passes). `bunx tsc --noEmit` in both.

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/facade.ts components/notifications/src/index.ts components/notifications/test/preferences.test.ts packages/client/src/notifications.tsx packages/client/src/react.tsx
git commit -m "feat(notifications): N3 T2 — preference API (getPreferences/setPreference) + useNotificationPreferences hook"
```

---

## Task 3: Topics — subscription model + subscribe/unsubscribe

**Files:** Create `topics.ts`; Modify `facade.ts` (subscribe/unsubscribe), `index.ts`; Test: `test/topics.test.ts`.

**Interfaces:**
- Consumes (T1): `callerId`, the `topicSubscriptions` schema.
- Produces: `subscribe`/`unsubscribe` modules; `_recordSendBatch` (T4 fills the send logic — T3 stubs the subscription mgmt).

- [ ] **Step 1: Write the test.** Create `test/topics.test.ts`: `subscribe` inserts one row (idempotent — a second subscribe is a no-op), `unsubscribe` removes it, both resolve the caller by default and accept an explicit server-controlled `userId`.

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { makeTopicModules } from "../src/topics";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makeTopicModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:sub": mutation(async (ctx: any, a: any) => ctx.notifications.subscribe(a)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:unsub": mutation(async (ctx: any, a: any) => ctx.notifications.unsubscribe(a)),
};
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N3 — topics subscription", () => {
  it("subscribe is idempotent; unsubscribe removes; explicit userId is server-controlled", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:sub", { topic: "news", userId: "u1" });
    await built.runtime.run("app:sub", { topic: "news", userId: "u1" }); // idempotent
    await built.runtime.run("app:sub", { topic: "news", userId: "u2" });
    expect((await built.readTable("notifications/topicSubscriptions")).length).toBe(2);
    await built.runtime.run("app:unsub", { topic: "news", userId: "u1" });
    const rows = await built.readTable("notifications/topicSubscriptions");
    expect(rows.map((r) => r.userId)).toEqual(["u2"]);
  });

  it("subscribe defaults to the caller when userId is omitted", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:sub", { topic: "news" }, { identity: "u9" });
    expect((await built.readTable("notifications/topicSubscriptions"))[0]).toMatchObject({ topic: "news", userId: "u9" });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`../src/topics` missing). Run: `bunx vitest run test/topics.test.ts`.

- [ ] **Step 3: Create `topics.ts`** (subscription mgmt now; T4 adds `_recordSendBatch`):

```ts
import { mutation, type MutationCtx, type RegisteredFunction } from "@stackbase/executor";
import type { NotificationsConfig } from "./config";
import { callerId } from "./inbox";

/** `subscribe`/`unsubscribe` — maintain a topic's subscriber set. `userId` is server-controlled
 *  (the app decides who), defaulting to the caller when omitted. Subscribe is idempotent. */
export function makeTopicModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscribe = mutation(async (ctx: any, args: { topic: string; userId?: string }): Promise<null> => {
    const userId = args.userId ?? await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const [existing] = await (ctx as MutationCtx).db.query("topicSubscriptions", "byUserTopic").eq("userId", userId).eq("topic", args.topic).take(1).collect();
    if (!existing) await (ctx as MutationCtx).db.insert("topicSubscriptions", { topic: args.topic, userId, createdAt: (ctx as MutationCtx).now() });
    return null;
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsubscribe = mutation(async (ctx: any, args: { topic: string; userId?: string }): Promise<null> => {
    const userId = args.userId ?? await callerId(ctx);
    if (!userId) throw new Error("not authenticated");
    const [existing] = await (ctx as MutationCtx).db.query("topicSubscriptions", "byUserTopic").eq("userId", userId).eq("topic", args.topic).take(1).collect();
    if (existing) await (ctx as MutationCtx).db.delete(existing._id as string);
    return null;
  });

  // `_recordSendBatch` (T4) is added here.
  return { subscribe, unsubscribe };
}
```
(`config` is unused until T4 — keep the param so T4 doesn't change the signature; add an `eslint-disable` for unused if needed, or reference it in a no-op. Better: T4 adds the batch mutation that uses it, so leave the param.)

- [ ] **Step 4: Add facade methods** (`facade.ts`). Add to `NotificationsContext`:
```ts
  subscribe(args: { topic: string; userId?: string }): Promise<null>;
  unsubscribe(args: { topic: string; userId?: string }): Promise<null>;
```
> Implementer: same decision as T2 — if the established precedent is registered modules called over well-known paths, and the app calls `ctx.notifications.subscribe`, then the facade DOES need these methods (they're used from a mutation via `ctx.notifications`). Wire them by delegating to shared impl helpers OR by having the facade call the module logic. Follow the send facade's pattern (it calls `recordSend` directly). Extract `subscribeImpl(db, now, userId, topic)`/`unsubscribeImpl` in `topics.ts` and call from both the modules and the facade (which resolves `userId = args.userId ?? cctx.identity`).

- [ ] **Step 5: Wire `index.ts`.** Import + spread `makeTopicModules(config)` into `modules`.

- [ ] **Step 6: Run — expect PASS.** `bunx vitest run test/topics.test.ts`; full package + tsc.

- [ ] **Step 7: Commit.**
```bash
git add components/notifications/src/topics.ts components/notifications/src/facade.ts components/notifications/src/index.ts components/notifications/test/topics.test.ts
git commit -m "feat(notifications): N3 T3 — topic subscriptions (subscribe/unsubscribe)"
```

---

## Task 4: `sendToTopic` — preference-aware paginated fan-out

**Files:** Modify `topics.ts` (`_recordSendBatch`), `facade.ts` (`sendToTopic` action method), `index.ts`; Test: extend `test/topics.test.ts`.

**Interfaces:**
- Consumes: `recordSend` (T1, preference-aware), the `byTopic` index, `db.query(...).paginate({cursor,pageSize,maxScan})` → `{ page, nextCursor, hasMore, scanCapped }`.
- Produces: `_recordSendBatch` mutation; `ctx.notifications.sendToTopic(...)` action → `{ recipientCount, sentCount, suppressedCount }`.

- [ ] **Step 1: Write the test.** Add to `test/topics.test.ts` a fan-out case: subscribe u1,u2,u3 to a topic; u2 opts out of the category; `sendToTopic` writes in_app rows for u1,u3 (not u2), returns `{ recipientCount: 3, sentCount: 2, suppressedCount: 1 }`; a re-run with the same idempotencyKey adds no duplicate rows.

```ts
describe("notifications N3 — sendToTopic fan-out", () => {
  it("fans out to subscribers, honors preferences, dedups on re-run", async () => {
    const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeTopicModules(config), ...makePreferenceModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      buildAction: (api) => notificationsActionContext(api, config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:setPref": mutation(async (ctx: any, a: any) => ctx.notifications.setPreference(a)),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:topicSend": action(async (ctx: any, a: any) => ctx.notifications.sendToTopic(a)),
    });
    for (const u of ["u1", "u2", "u3"]) await built.runtime.run("app:sub", { topic: "news", userId: u });
    await built.runtime.run("app:setPref", { category: "marketing", channel: "in_app", enabled: false }, { identity: "u2" });

    const r1 = (await built.runtime.runAction("app:topicSend", { topic: "news", channels: ["in_app"], template: "hi", category: "marketing", idempotencyKey: "b1" })).value as { recipientCount: number; sentCount: number; suppressedCount: number };
    expect(r1).toEqual({ recipientCount: 3, sentCount: 2, suppressedCount: 1 });
    const inbox = await built.readTable("notifications/notifications");
    expect(inbox.map((r) => r.userId).sort()).toEqual(["u1", "u3"]);

    // Re-run same key → per-subscriber dedup, no new rows.
    await built.runtime.runAction("app:topicSend", { topic: "news", channels: ["in_app"], template: "hi", category: "marketing", idempotencyKey: "b1" });
    expect((await built.readTable("notifications/notifications")).length).toBe(2);
  });
});
```
(Add `action`, `notificationsActionContext`, `makePreferenceModules` imports to the test.)

- [ ] **Step 2: Run — expect FAIL** (`sendToTopic`/`_recordSendBatch` missing).

- [ ] **Step 3: Add `_recordSendBatch` to `topics.ts`.** It paginates one page of subscribers and sends to each via `recordSend` (preference-aware), deriving per-subscriber idempotency keys:

```ts
import { mutation, type MutationCtx, type GuestDatabaseWriter, type RegisteredFunction } from "@stackbase/executor";
import type { NotificationsConfig } from "./config";
import type { SendArgs } from "./config";
import { callerId } from "./inbox";
import { recordSend } from "./modules";
import { compact } from "./render";

// inside makeTopicModules, add:
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _recordSendBatch = mutation(async (ctx: MutationCtx, args: {
    topic: string; channels: SendArgs["channels"]; template: SendArgs["template"]; data?: SendArgs["data"];
    category?: string; idempotencyKey?: string; cursor: string | null; pageSize: number;
  }): Promise<{ count: number; nextCursor: string | null; hasMore: boolean; sentCount: number; suppressedCount: number }> => {
    // Privileged fully-qualified table for the driver-less internal path? No — this is reached from an
    // action's runMutation (non-privileged), so use the BARE table name (namespace resolves it) —
    // same lesson as N2's `_applyWebhookEvent`.
    const res = await (ctx.db.query("topicSubscriptions", "byTopic").eq("topic", args.topic) as unknown as {
      paginate(o: { cursor: string | null; pageSize: number; maxScan: number }): Promise<{ page: Array<Record<string, unknown>>; nextCursor: string | null; hasMore: boolean; scanCapped: boolean }>;
    }).paginate({ cursor: args.cursor, pageSize: args.pageSize, maxScan: args.pageSize * 10 });
    let sentCount = 0, suppressedCount = 0;
    for (const sub of res.page) {
      const userId = sub.userId as string;
      const key = args.idempotencyKey ? `${args.idempotencyKey}:${userId}` : undefined;
      const sendArgs = compact({ to: { userId }, channels: args.channels, template: args.template, data: args.data, category: args.category, idempotencyKey: key }) as unknown as SendArgs;
      const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, sendArgs);
      sentCount += r.messageIds.length;
      suppressedCount += r.suppressed.length;
    }
    return { count: res.page.length, nextCursor: res.hasMore ? res.nextCursor : null, hasMore: res.hasMore, sentCount, suppressedCount };
  });

  return { subscribe, unsubscribe, _recordSendBatch };
```
> Implementer: VERIFY the exact `paginate` signature/return against `packages/admin/src/browse.ts` (it uses `paginate({ cursor, pageSize, maxScan }) → { page, nextCursor, hasMore, scanCapped }`) and `packages/executor/src/guest.ts`. Match it exactly; adjust the inline cast to the real typed `db.query(...).paginate` if the guest db exposes it directly (no cast needed if typed).

- [ ] **Step 4: Add `sendToTopic` to the action facade** (`facade.ts` `notificationsActionContext`). Loop pages until done:
```ts
    async sendToTopic(args: { topic: string; channels: SendArgs["channels"]; template: SendArgs["template"]; data?: SendArgs["data"]; category?: string; idempotencyKey?: string }) {
      let cursor: string | null = null;
      let recipientCount = 0, sentCount = 0, suppressedCount = 0;
      do {
        const page: { count: number; nextCursor: string | null; hasMore: boolean; sentCount: number; suppressedCount: number } =
          await api.runMutation("notifications:_recordSendBatch", compact({ topic: args.topic, channels: args.channels, template: args.template, data: args.data, category: args.category, idempotencyKey: args.idempotencyKey, cursor, pageSize: 100 }) as unknown as Record<string, unknown>);
        recipientCount += page.count; sentCount += page.sentCount; suppressedCount += page.suppressedCount;
        cursor = page.hasMore ? page.nextCursor : null;
      } while (cursor !== null);
      return { recipientCount, sentCount, suppressedCount };
    },
```
Add `sendToTopic` to the `NotificationsActionContext` interface with that return type.

- [ ] **Step 5: `index.ts`** already spreads `makeTopicModules` (T3) — `_recordSendBatch` is now included automatically. No change needed unless T3 didn't spread it; verify.

- [ ] **Step 6: Run — expect PASS.** `bunx vitest run test/topics.test.ts`; full package; tsc.

- [ ] **Step 7: Commit.**
```bash
git add components/notifications/src/topics.ts components/notifications/src/facade.ts components/notifications/test/topics.test.ts
git commit -m "feat(notifications): N3 T4 — sendToTopic preference-aware paginated fan-out"
```

---

## Task 5: E2E through the real dev server + docs

**Files:** Create `packages/cli/test/notifications-preferences-e2e.test.ts`; Modify `docs/enduser/build/notifications.md`.

- [ ] **Step 1: Write the E2E.** Mirror `packages/cli/test/notifications-e2e.test.ts`'s boot. Prove: a client `setPreference` (opt out of a category on a channel) is reflected in a live `getPreferences` subscription; a subsequent `send` on that category suppresses the channel (a live inbox subscription does NOT receive it); a critical-category send still arrives; a `sendToTopic` fans out and skips the opted-out subscriber. Compose `defineNotifications({ channels: { in_app, email }, categories: { security: { critical: true } } })`.

Full test file (adapt imports to the N1 E2E reference which is proven):
```ts
/**
 * Notifications N3 — E2E through the real dev server: a preference opt-out suppresses a category's
 * channel reactively, a critical category bypasses it, and sendToTopic honors each subscriber's prefs.
 */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, action } from "@stackbase/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, anyApi } from "@stackbase/client";
import { defineNotifications } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

async function waitFor(cond: () => boolean, ms = 5000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error(`${label} timed out`); await new Promise<void>((r) => setTimeout(r, 10)); }
}
const appSchema = defineSchema({ pings: defineTable({ by: v.string() }).index("by_by", ["by"]) });
const appModules = {
  n: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    topicSend: action(async (ctx: any, a: any) => ctx.notifications.sendToTopic(a)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sub: mutation(async (ctx: any, a: any) => ctx.notifications.subscribe(a)),
  },
};
const api = anyApi as {
  n: { send: { __path: string }; topicSend: { __path: string }; sub: { __path: string } };
  notifications: { inbox: { __path: string }; unreadCount: { __path: string }; getPreferences: { __path: string }; setPreference: { __path: string } };
};
const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

describe("notifications N3 — preferences + topics E2E", () => {
  it("opt-out suppresses a category channel reactively; critical bypasses; topic fan-out honors prefs", async () => {
    const project = loadProject({ schema: appSchema, modules: appModules }, [
      defineNotifications({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "Hi", body: "hello" }) } } }, categories: { security: { critical: true } } }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: project.catalog, modules: project.moduleMap,
      tableNumbers: project.tableNumbers, componentNames: project.componentNames, contextProviders: project.contextProviders,
      bootSteps: project.bootSteps, drivers: project.drivers,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" }); servers.push(server);
    const c = new StackbaseClient(webSocketTransport(`ws://127.0.0.1:${server.port}/api/sync`, { reconnect: false }));
    try {
      c.setAuth("user-1");
      const inbox: Array<Array<{ body: string }>> = [];
      const prefs: Array<Array<{ category: string }>> = [];
      c.subscribe(api.notifications.inbox, {}, (x) => inbox.push(x as never));
      c.subscribe(api.notifications.getPreferences, {}, (x) => prefs.push(x as never));
      await waitFor(() => inbox.length >= 1 && prefs.length >= 1, 5000, "initial");

      // Opt out of marketing in_app; the live getPreferences subscription reflects it.
      await c.mutation(api.notifications.setPreference, { category: "marketing", channel: "in_app", enabled: false });
      await waitFor(() => (prefs.at(-1) ?? []).some((p) => p.category === "marketing"), 5000, "pref reflected");

      // A marketing in_app send is suppressed — the inbox stays empty for it.
      const r = (await c.mutation(api.n.send, { to: { userId: "user-1" }, channels: ["in_app"], template: "hi", category: "marketing" })) as { suppressed: string[] };
      expect(r.suppressed).toEqual(["in_app"]);
      // A critical (security) send DOES arrive.
      await c.mutation(api.n.send, { to: { userId: "user-1" }, channels: ["in_app"], template: "hi", category: "security" });
      await waitFor(() => (inbox.at(-1)?.length ?? 0) >= 1, 5000, "critical arrives");
      expect(inbox.at(-1)!.length).toBe(1); // exactly the critical one; the marketing one was suppressed

      // Topic fan-out: user-1 (opted out of marketing in_app) is suppressed; user-2 is not subscribed.
      await c.mutation(api.n.sub, { topic: "news", userId: "user-1" });
      const t = (await c.action(api.n.topicSend, { topic: "news", channels: ["in_app"], template: "hi", category: "marketing" })) as { recipientCount: number; sentCount: number; suppressedCount: number };
      expect(t).toEqual({ recipientCount: 1, sentCount: 0, suppressedCount: 1 });
    } finally { c.close(); }
  });
});
```

- [ ] **Step 2: Build + run.** `cd <worktree root> && bun run build`, then `cd packages/cli && bunx vitest run test/notifications-preferences-e2e.test.ts` → 1/1 PASS. (If `getPreferences` subscription errors on an undefined-key wire return, ensure `getPreferences` maps rows through `compact` — it does in T1.)

- [ ] **Step 3: Docs.** In `docs/enduser/build/notifications.md`, add `## Preferences` (categories, default-allow, `setPreference`/`getPreferences`/`useNotificationPreferences`, critical categories via `defineNotifications({ categories: { security: { critical: true } } })`, that a send returns `suppressed`) and `## Topics` (`subscribe`/`unsubscribe`, `sendToTopic` + its preference-aware fan-out and per-subscriber idempotency). Update the scope banner + "what's deferred": preferences + topics → shipped; N4 = digest + auth-unification; provider-fallback + time-based routing noted as deferred delivery-mechanics.

- [ ] **Step 4: Commit.**
```bash
git add packages/cli/test/notifications-preferences-e2e.test.ts docs/enduser/build/notifications.md
git commit -m "feat(notifications): N3 T5 — preferences + topics E2E through the real dev server + docs"
```

---

## Verification (after each task; full gate after T5)

```bash
bun run --filter @stackbase/notifications typecheck
bun run --filter @stackbase/notifications test
bun run build   # then: cd packages/cli && bunx vitest run test/notifications-preferences-e2e.test.ts
bun run build && bun run typecheck && bun run test   # whole-repo gate
```

Dist-resolution rule: rebuild `@stackbase/notifications`/`@stackbase/client` before the CLI E2E. Compact-at-every-boundary rule for any new `runMutation`/`runQuery`/`db.insert`/`db.replace`/wire return.

## Self-Review

- **Spec coverage:** category on send + default (T1 config), default-allow gate + most-specific resolution (T1 `resolvePreference`), critical-bypass at gate + setter (T1 gate + preferences.ts), suppressed result (T1 facade), preference API + hook (T2), topics subscribe/unsubscribe (T3), preference-aware paginated fan-out + per-subscriber idempotency (T4), E2E + docs (T5). All spec sections map.
- **Type consistency:** `resolvePreference`/`isCritical` defined in `preferences.ts` (T1), consumed by `recordSend` (T1) and `_recordSendBatch` (T4); `recordSend`'s `{…, suppressed}` return threaded through `_enqueueSend` + both facades; `Channel` imported where used; `callerId` exported once (T1) and reused (T2/T3/T4); `paginate` signature verified against `browse.ts`.
- **Single chokepoint:** the gate is ONLY in `recordSend`; `sendToTopic` → `_recordSendBatch` → `recordSend`, so fan-out is preference-aware for free (no second gate).
- **Boundary rule:** every new `db.insert`/`db.replace`/`runMutation`/`runQuery`/wire return uses `compact`.
