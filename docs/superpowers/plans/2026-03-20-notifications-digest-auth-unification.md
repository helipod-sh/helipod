# Notifications N4 — Digest + Auth Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route `@stackbase/auth`'s transactional emails through `ctx.notifications` (the one delivery path) when composed, and add an email digest (a category buffers its email sends and a driver flushes a combined per-recipient digest on a rolling window) — the final slice of the notification arc.

**Architecture:** A server-authority `critical` flag on `SendArgs` lets a transactional send bypass the N3 preference gate; auth duck-types `ctx.notifications` and routes through it (`critical: true`) with a fallback to its own `EmailProvider`, gaining no hard dependency. Digest reuses the single `recordSend` chokepoint (buffer instead of enqueue for a digest-category email) and the existing recurring driver (its pass also flushes due digests), with a per-category `digestTemplate` combining buffered items into one email.

**Tech Stack:** TypeScript; `@stackbase/executor` (`mutation`/`query`/`ctx.now`, `db.query(...).paginate`), `@stackbase/values` (`v`, schema); the recurring-driver seam (`DriverContext`); vitest.

## Global Constraints

- **Additive schema only** (`digestBuffer` table + optional fields). No changed/removed field.
- **`compact()` at EVERY codec boundary** — args, returns, `db.insert`/`db.replace`, wire returns. The JSON codec rejects an `undefined`-valued key.
- **No `Date.now()`/`Math.random()` in a UDF** — `ctx.now()` (mutation) or a `now` arg passed from the driver (query).
- **`critical` is SERVER-AUTHORITY** — set only by server code (auth's action / an app mutation), never forwarded from client input (documented like `to.userId`/`category`). A client cannot reach `send` directly.
- **Single chokepoint:** the preference gate + digest-buffer decision live ONLY in `recordSend`; every send path routes through it. Do NOT add a second gate.
- **Auth stays independent:** `@stackbase/auth` must NOT import `@stackbase/notifications`. It duck-types `ctx.notifications` via a minimal local interface; absent → the existing `e.provider.send` fallback (byte-identical to today).
- **Digest is EMAIL-only in N4;** `in_app` is never digested; a critical send/category is never digested. Preferences re-checked AT FLUSH.
- Naming: `SendArgs.critical`; category config `{ critical?, digest? }` with `digest?: "hourly"|"daily"|"weekly"`; `digestTemplates` config (parallel to channel `templates`); `digestBuffer` table; `_flushDue` driver-invoked mutation.

---

## File Structure

- `components/notifications/src/config.ts` — MODIFY: `SendArgs.critical?`; `categories` entry gains `digest?`; add `DigestFrequency`, `digestTemplates?` config, `DigestItem`/`DigestTemplateFn`, `digestWindowMs(config, category)` helper, `deferred` on the send-result shape types.
- `components/notifications/src/modules.ts` — MODIFY: `recordSend` gate honors `critical`; email digest-buffer branch; `deferred: Channel[]` return; `_enqueueSend` threads it.
- `components/notifications/src/facade.ts` — MODIFY: `send`/`sendNow` return `{ …, deferred: Channel[] }`.
- `components/notifications/src/schema.ts` — MODIFY: add `digestBuffer` table.
- `components/notifications/src/digest.ts` — CREATE: `makeDigestModules(config)` → `{ _flushDue }`; `defaultDigestTemplate`.
- `components/notifications/src/driver.ts` — MODIFY: `runPass` also calls `_flushDue`.
- `components/notifications/src/index.ts` — MODIFY: spread `makeDigestModules`; export digest types.
- `components/auth/src/config.ts` — MODIFY: `EmailOptions`/`EmailConfig` gain `notificationCategory?`.
- `components/auth/src/functions.ts` — MODIFY: `requestAction` routes through `ctx.notifications` when present, else `e.provider.send`.
- `components/auth/src/notifications-facade.ts` — CREATE: the minimal `NotificationsSendFacade` interface auth duck-types.
- Tests: `test/critical.test.ts` (T1), `test/digest.test.ts` (T2+T3), `packages/cli/test/notifications-auth-unify-e2e.test.ts` (T4), `packages/cli/test/notifications-digest-e2e.test.ts` (T5); `docs/enduser/build/notifications.md` (T5).

**Execution note:** agent worktree-isolation is broken this session — build tasks SEQUENTIALLY in the one worktree. Order: **T1 → T2 → T3 → T4 → T5** (Part A = T1+T4; Part B = T2+T3+T5; T1 precedes both because A2 needs the `critical` flag and B1 edits the same `recordSend`).

---

## Task 1: `critical` server-authority flag + gate (Part A foundation)

**Files:** Modify `config.ts`, `modules.ts`; Test `test/critical.test.ts`.

**Interfaces:**
- Produces: `SendArgs.critical?: boolean`; `recordSend`'s gate bypasses preferences when `args.critical === true`.

- [ ] **Step 1: Add `critical` to `SendArgs`** (`config.ts`):
```ts
export interface SendArgs {
  to: Recipient;
  channels: Channel[];
  template: string | InlineTemplate;
  data?: Record<string, unknown>;
  idempotencyKey?: string;
  category?: string;
  /** SERVER-AUTHORITY preference-bypass for a transactional send (OTP/security). When true the send
   *  is delivered regardless of the recipient's preferences, exactly like a config-critical category.
   *  Set ONLY by server code (never forward it from client input — same trust boundary as `to`). */
  critical?: boolean;
}
```

- [ ] **Step 2: Write the failing test** (`test/critical.test.ts`): a `critical: true` send to an opted-out `(category, channel)` is NOT suppressed.
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
  const config = resolveNotificationsConfig({ channels: { in_app: { enabled: true, templates: { hi: () => ({ title: "T", body: "B" }) } } } });
  return defineComponent({
    name: "notifications", schema: notificationsSchema,
    modules: { ...makeSendModules(config), ...makePreferenceModules(config) },
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:setPref": mutation(async (ctx: any, a: any) => ctx.notifications.setPreference(a)),
};
async function runAs(b: BuiltNotifRuntime, id: string | null, p: string, a: JSONValue) { return (await b.runtime.run(p, a, { identity: id })).value; }
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N4 — critical server-authority bypass", () => {
  it("critical:true delivers to an opted-out (category, channel)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await runAs(built, "u1", "app:setPref", { category: "security", channel: "in_app", enabled: false });
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1" }, channels: ["in_app"], template: "hi", category: "security", critical: true })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual([]);            // NOT suppressed despite the opt-out
    expect((await built.readTable("notifications/messages")).length).toBe(1);
  });
  it("without critical, the same opt-out suppresses", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await runAs(built, "u1", "app:setPref", { category: "security", channel: "in_app", enabled: false });
    const res = (await runAs(built, "u1", "app:send", { to: { userId: "u1" }, channels: ["in_app"], template: "hi", category: "security" })) as { messageIds: string[]; suppressed: string[] };
    expect(res.suppressed).toEqual(["in_app"]);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (critical not honored). Run: `cd components/notifications && bunx vitest run test/critical.test.ts`.

- [ ] **Step 4: Honor `critical` in the gate** (`modules.ts` `recordSend`). Change the gate condition (currently `if (userId !== undefined && !isCritical(config, category) && !(await resolvePreference(...)))`) to add `&& args.critical !== true`:
```ts
    if (userId !== undefined && !isCritical(config, category) && args.critical !== true && !(await resolvePreference(db, userId, category, channel))) {
      suppressed.push(channel);
      continue;
    }
```

- [ ] **Step 5: Run — expect PASS** (2/2). Full package (`bunx vitest run`) + `bunx tsc --noEmit` clean (existing tests unaffected — `critical` defaults undefined).

- [ ] **Step 6: Commit.**
```bash
git add components/notifications/src/config.ts components/notifications/src/modules.ts components/notifications/test/critical.test.ts
git commit -m "feat(notifications): N4 T1 — server-authority critical flag bypasses the preference gate"
```

---

## Task 2: Email digest — schema, config, buffer-on-send (Part B foundation)

**Files:** Modify `schema.ts`, `config.ts`, `modules.ts`, `facade.ts`; Test `test/digest.test.ts`.

**Interfaces:**
- Consumes (T1): the `critical`-aware gate.
- Produces: `digestBuffer` table; `DigestFrequency`, `digestWindowMs(config, category): number | null`, `DigestItem`, `DigestTemplateFn`, `config.digestTemplates`; `recordSend` buffers a digest-category email + returns `deferred: Channel[]`.

- [ ] **Step 1: Add the schema** (`schema.ts`) — a new table in `defineSchema`:
```ts
  digestBuffer: defineTable({
    recipientKey: v.string(),       // grouping key = to.email (email digest)
    email: v.string(),              // the address the flushed digest is sent to
    userId: v.optional(v.string()), // for the preference re-check at flush
    category: v.string(),
    subject: v.string(),
    text: v.string(),
    html: v.optional(v.string()),
    createdAt: v.number(),
    flushedAt: v.optional(v.number()), // set when the digest driver claims+flushes it
  })
    .index("byUnflushed", ["flushedAt"])                    // driver scans flushedAt = undefined
    .index("byRecipientCategory", ["recipientKey", "category"]),
```

- [ ] **Step 2: Extend config** (`config.ts`):
```ts
export type DigestFrequency = "hourly" | "daily" | "weekly";
export interface DigestItem { subject: string; text: string; html?: string; createdAt: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DigestTemplateFn = (items: DigestItem[]) => EmailContent; // EmailContent from ./provider
```
Change the `categories` value type (both `NotificationsOptions` and `NotificationsConfig`) from `{ critical?: boolean }` to `{ critical?: boolean; digest?: DigestFrequency }`. Add to `NotificationsOptions`:
```ts
  /** Per-category digest renderer (category → combine buffered items into one email). A category with
   *  `digest` set but no template here uses the built-in `defaultDigestTemplate`. */
  digestTemplates?: Record<string, DigestTemplateFn>;
```
Add to `NotificationsConfig`: `digestTemplates: Record<string, DigestTemplateFn>;` and in `resolveNotificationsConfig` return `digestTemplates: opts.digestTemplates ?? {}`. Add the window helper (import `DigestFrequency`):
```ts
const DIGEST_WINDOW_MS: Record<DigestFrequency, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
/** The rolling-window ms for a category's digest, or null if the category doesn't digest. */
export function digestWindowMs(config: NotificationsConfig, category: string): number | null {
  const f = config.categories[category]?.digest;
  return f ? DIGEST_WINDOW_MS[f] : null;
}
```
Import `EmailContent` at the top of config.ts: `import type { EmailContent } from "./provider";`.

- [ ] **Step 3: Write the failing test** (`test/digest.test.ts`) — the buffer half (the driver flush is T3):
```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineComponent, type ComponentDefinition } from "@stackbase/component";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { notificationsSchema } from "../src/schema";
import { resolveNotificationsConfig } from "../src/config";
import { makeSendModules } from "../src/modules";
import { notificationsContext } from "../src/facade";
import { makeNotifRuntime, type BuiltNotifRuntime } from "./helpers";

function comp(): ComponentDefinition {
  const config = resolveNotificationsConfig({
    channels: {
      email: { provider: { channel: "email", async send() { return {}; } }, from: "x@test", templates: { hi: () => ({ subject: "S", text: "T" }) } },
      in_app: { enabled: true, templates: { hi: () => ({ title: "Ti", body: "B" }) } },
    },
    categories: { updates: { digest: "daily" } },
  });
  return defineComponent({
    name: "notifications", schema: notificationsSchema, modules: makeSendModules(config),
    context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
  });
}
const appModules: Record<string, RegisteredFunction> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  "app:send": mutation(async (ctx: any, a: any) => ctx.notifications.send(a)),
};
let built: BuiltNotifRuntime;
afterEach(async () => { await built?.close(); });

describe("notifications N4 — email digest buffering", () => {
  it("a digest-category email is buffered (no messages row) and reported deferred", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    const res = (await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "updates" })).value as { messageIds: string[]; deferred: string[] };
    expect(res.deferred).toEqual(["email"]);
    expect((await built.readTable("notifications/messages")).length).toBe(0);   // NOT enqueued
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(1);
    expect((await built.readTable("notifications/digestBuffer"))[0]).toMatchObject({ email: "u1@test", category: "updates", subject: "S" });
  });
  it("in_app on a digest category is immediate (not buffered)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["in_app"], template: "hi", category: "updates" });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(0);
    expect((await built.readTable("notifications/notifications")).length).toBe(1);   // inbox row, immediate
  });
  it("a critical digest-category email is immediate (not buffered)", async () => {
    built = await makeNotifRuntime(comp(), appModules);
    await built.runtime.run("app:send", { to: { userId: "u1", email: "u1@test" }, channels: ["email"], template: "hi", category: "updates", critical: true });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(0);
    expect((await built.readTable("notifications/messages")).length).toBe(1);        // queued, immediate
  });
});
```

- [ ] **Step 4: Run — expect FAIL.** Run: `bunx vitest run test/digest.test.ts`.

- [ ] **Step 5: Buffer-on-send in `recordSend`** (`modules.ts`). Add imports: `import { digestWindowMs } from "./config";`. Add a `deferred: Channel[]` accumulator + the buffer branch. In `recordSend`: declare `const deferred: Channel[] = [];` next to `suppressed`. After the preference gate (so an opted-out user is suppressed, not buffered), before the `if (channel === "in_app")` block, add the digest-buffer branch:
```ts
      // N4 digest: a non-critical EMAIL send on a digest-configured category is BUFFERED (a
      // `digestBuffer` row) instead of enqueued — the digest driver flushes a combined email per
      // recipient on the category's rolling window. in_app is never digested (the inbox is the live
      // view); a critical send is never digested (immediate). Rendered here (deterministic, no I/O).
      if (channel === "email" && args.critical !== true && !isCritical(config, category) && digestWindowMs(config, category) !== null) {
        const content = renderEmail(config, args.template, args.data);
        const email = args.to.email!;                 // resolveAddress already asserted it for "email"
        await db.insert("digestBuffer", compact({
          recipientKey: email, email, userId: args.to.userId, category,
          subject: content.subject, text: content.text, html: content.html, createdAt: now,
        }));
        deferred.push(channel);
        continue;
      }
```
Change the return type + all returns to include `deferred`:
```ts
export async function recordSend(...): Promise<{ messageIds: string[]; deduped: boolean; queued: QueuedMessage[]; suppressed: Channel[]; deferred: Channel[] }> {
  // dedup early-return: add `deferred: []`
  // final return: `return { messageIds, deduped: false, queued, suppressed, deferred };`
```
Thread `deferred` through `_enqueueSend`:
```ts
  const _enqueueSend = mutation(async (ctx, args): Promise<{ messageIds: string[]; queued: QueuedMessage[]; suppressed: Channel[]; deferred: Channel[] }> => {
    const r = await recordSend(ctx.db as GuestDatabaseWriter, ctx.now(), config, args);
    return { messageIds: r.messageIds, queued: r.queued, suppressed: r.suppressed, deferred: r.deferred };
  });
```

- [ ] **Step 6: Thread `deferred` through the facades** (`facade.ts`). `send`/`sendNow` return `{ …, deferred: Channel[] }`. Mutation `send`: `return { messageIds: r.messageIds, suppressed: r.suppressed, deferred: r.deferred };`. Action `send`/`sendNow`: capture `deferred` from the `_enqueueSend` result and include it. Update the interface signatures (`NotificationsContext.send`, `NotificationsActionContext.send`/`sendNow`) to add `deferred: Channel[]`.

- [ ] **Step 7: Run — expect PASS** (3/3). Full package + tsc clean (existing tests read `.messageIds`/rows/`.suppressed`, unaffected by the new `deferred` field).

- [ ] **Step 8: Commit.**
```bash
git add components/notifications/src/schema.ts components/notifications/src/config.ts components/notifications/src/modules.ts components/notifications/src/facade.ts components/notifications/test/digest.test.ts
git commit -m "feat(notifications): N4 T2 — email digest buffering (buffer a digest-category email, deferred result)"
```

---

## Task 3: Digest driver flush + digest template (Part B)

**Files:** Create `digest.ts`; Modify `driver.ts`, `index.ts`; Test: extend `test/digest.test.ts`.

**Interfaces:**
- Consumes (T2): `digestBuffer`, `digestWindowMs`, `config.digestTemplates`, `DigestItem`, `recordSend`.
- Produces: `makeDigestModules(config)` → `{ _flushDue }`; `defaultDigestTemplate`; the driver's `runPass` calls `_flushDue`.

- [ ] **Step 1: Write the flush test** (append to `test/digest.test.ts`). Uses a capture-ish setup: the driver's `__tick` flushes due groups. Because a digest window is large (daily=24h), the test config uses a tiny window by monkeypatching? No — set `categories: { updates: { digest: "hourly" } }` and manually backdate the buffer's `createdAt` via a `_system` helper so it's "past window", OR use the driver with a real `now` far in the future. Simplest: a `_system:backdate` helper sets `createdAt` to 0, so any `now` is past the window. Add the helper to `helpers.ts` `systemModules` (test-only). Then `__tick` flushes.
```ts
describe("notifications N4 — digest flush", () => {
  it("flushes buffered items past the window into one combined email; no re-flush", async () => {
    const captured: Array<{ subject: string; text: string }> = [];
    const config = resolveNotificationsConfig({
      channels: { email: { provider: { channel: "email", async send(m) { captured.push({ subject: m.subject, text: m.text }); return { providerMessageId: `cap-${captured.length}` }; } }, from: "x@test", templates: { hi: (d: { n: number }) => ({ subject: `S${d.n}`, text: `body ${d.n}` }) } } },
      categories: { updates: { digest: "hourly" } },
      driverIntervalMs: 10_000,
    });
    const component = defineComponent({
      name: "notifications", schema: notificationsSchema,
      modules: { ...makeSendModules(config), ...makeDigestModules(config) },
      context: (cctx) => notificationsContext(cctx, config), contextWrite: true,
      driver: notificationsDriver(config),
    });
    built = await makeNotifRuntime(component, {
      ...appModules,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      "app:sendN": mutation(async (ctx: any, a: any) => ctx.notifications.send({ to: { email: "u1@test" }, channels: ["email"], template: "hi", data: { n: a.n }, category: "updates" })),
    });
    for (const n of [1, 2, 3]) await built.runtime.run("app:sendN", { n });
    expect((await built.readTable("notifications/digestBuffer")).length).toBe(3);
    // Backdate all buffer rows so they're past the hourly window, then tick.
    await built.runtime.runSystem("_system:backdateDigest", {});
    await (built.driver as { __tick: () => Promise<void> }).__tick();  // flush → one queued email → delivered
    await (built.driver as { __tick: () => Promise<void> }).__tick();  // deliver the flushed email
    expect(captured.length).toBe(1);                                    // ONE combined email
    expect(captured[0]!.text).toContain("body 1");
    expect(captured[0]!.text).toContain("body 3");
    // All buffer rows are flushed; a second flush does not re-send.
    expect((await built.readTable("notifications/digestBuffer")).every((r) => r.flushedAt != null)).toBe(true);
    await (built.driver as { __tick: () => Promise<void> }).__tick();
    expect(captured.length).toBe(1);
  });
});
```
Add to `helpers.ts` `systemModules()`:
```ts
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "_system:backdateDigest": (await import("@stackbase/executor")).mutation(async (ctx: any) => {
      const rows = await ctx.db.query("notifications/digestBuffer", "byUnflushed").collect();
      for (const r of rows) await ctx.db.replace(r._id, { ...r, createdAt: 0 });
      return null;
    }),
```
(Import `makeDigestModules` in the test.)

- [ ] **Step 2: Run — expect FAIL** (`../src/digest` missing). Run: `bunx vitest run test/digest.test.ts`.

- [ ] **Step 3: Create `digest.ts`.**
```ts
import { mutation, type MutationCtx, type GuestDatabaseWriter, type RegisteredFunction } from "@stackbase/executor";
import type { NotificationsConfig, DigestItem } from "./config";
import { digestWindowMs } from "./config";
import type { EmailContent } from "./provider";
import { recordSend } from "./modules";
import { compact } from "./render";

/** The built-in digest renderer used when a digest category configures no `digestTemplate`: a plain
 *  concatenation of the buffered items. */
export function defaultDigestTemplate(items: DigestItem[]): EmailContent {
  const subject = `You have ${items.length} update${items.length === 1 ? "" : "s"}`;
  const text = items.map((i) => `• ${i.subject}\n${i.text}`).join("\n\n");
  return { subject, text };
}

const FLUSH_BATCH = 200; // bounded scan of unflushed buffer rows per pass

/** `_flushDue` — driver-invoked (privileged `runFunction`, fully-qualified tables): scan un-flushed
 *  `digestBuffer` rows, group by (recipientKey, category), and for a group whose OLDEST item is past
 *  the category's rolling window, CLAIM its items (`flushedAt = now`, one txn — the crash-safe claim),
 *  render a combined email via the category's `digestTemplate` (or the default), and `recordSend` ONE
 *  email to the recipient (preference-checked at flush by `recordSend`'s own gate). Bounded per pass. */
export function makeDigestModules(config: NotificationsConfig): Record<string, RegisteredFunction> {
  const _flushDue = mutation(async (ctx: MutationCtx, args: { now: number }): Promise<number> => {
    const now = args.now;
    const rows = await ctx.db.query("notifications/digestBuffer", "byUnflushed").eq("flushedAt", undefined).take(FLUSH_BATCH).collect();
    // Group un-flushed rows by recipientKey+category.
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      const key = `${r.recipientKey as string} ${r.category as string}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }
    let flushed = 0;
    for (const items of groups.values()) {
      const category = items[0]!.category as string;
      const window = digestWindowMs(config, category);
      if (window === null) continue; // category no longer digests — leave buffered (config changed)
      const oldest = Math.min(...items.map((i) => i.createdAt as number));
      if (now - oldest < window) continue; // not due yet
      // CLAIM: mark all items flushed in THIS txn before rendering (crash-safe — no double-flush).
      for (const it of items) await ctx.db.replace(it._id as string, { ...it, flushedAt: now });
      const digestItems: DigestItem[] = items
        .sort((a, b) => (a.createdAt as number) - (b.createdAt as number))
        .map((i) => compact({ subject: i.subject as string, text: i.text as string, html: i.html as string | undefined, createdAt: i.createdAt as number }) as unknown as DigestItem);
      const render = config.digestTemplates[category] ?? defaultDigestTemplate;
      const content = render(digestItems);
      // Send ONE combined email via the single chokepoint (preference-checked at flush). An inline
      // template carries the rendered content; a per-flush idempotency key dedups a driver re-run.
      await recordSend(ctx.db as GuestDatabaseWriter, now, config, {
        to: compact({ userId: items[0]!.userId as string | undefined, email: items[0]!.email as string }),
        channels: ["email"],
        template: { email: content },
        category,
        idempotencyKey: `digest:${items[0]!.recipientKey}:${category}:${oldest}`,
      });
      flushed++;
    }
    return flushed;
  });
  return { _flushDue };
}
```
> Implementer: VERIFY the `byUnflushed` index equality on `flushedAt === undefined` works — mirror how N2's `_peekQueued` filters an optional field, or (if `.eq("flushedAt", undefined)` isn't supported) scan `byUnflushed` and filter `r.flushedAt == null` in memory (bounded by `take(FLUSH_BATCH)`). Match the engine's real optional-index semantics; adjust if needed and note it.

- [ ] **Step 4: Fold the flush into the driver pass** (`driver.ts`). In `runPass`, after `_reclaimStuck` and before/after the queued send loop, add a digest flush call. Add near the top of the `do` body (after the reclaim call):
```ts
      await ctx.runFunction("notifications:_flushDue", { now: ctx.now() });
```
(The existing driver already runs on `driverIntervalMs` + commit wakes; `_flushDue` is bounded and no-ops when nothing is due. Its `recordSend` writes a queued `messages` row, which the same pass's peek then delivers — the loop's `pendingWake`/`do..while` already handles the fresh row.)

- [ ] **Step 5: Wire `index.ts`.** Import + spread `makeDigestModules(config)` into `modules`:
```ts
import { makeDigestModules } from "./digest";
// modules: { ...makeSendModules(config), ...makeInboxModules(), ...makeWebhookModules(config), ...makePreferenceModules(config), ...makeTopicModules(config), ...makeDigestModules(config) },
```
Export digest types (`DigestFrequency`, `DigestItem`, `DigestTemplateFn`) from the config type-export block; export `defaultDigestTemplate`.

- [ ] **Step 6: Run — expect PASS.** `bunx vitest run test/digest.test.ts` (all pass); full package + tsc clean. (N1/N2 driver tests must stay green — `_flushDue` is inert when no digest categories exist / no buffer rows.)

- [ ] **Step 7: Commit.**
```bash
git add components/notifications/src/digest.ts components/notifications/src/driver.ts components/notifications/src/index.ts components/notifications/test/digest.test.ts components/notifications/test/helpers.ts
git commit -m "feat(notifications): N4 T3 — digest driver flush + combined digest template"
```

---

## Task 4: Auth unification — route auth emails through notifications (Part A)

**Files:** Create `components/auth/src/notifications-facade.ts`; Modify `components/auth/src/config.ts`, `components/auth/src/functions.ts`; Test `packages/cli/test/notifications-auth-unify-e2e.test.ts`.

**Interfaces:**
- Consumes (T1): the `critical` flag on the notifications send.
- Produces: `requestAction` routes through `ctx.notifications` when present.

- [ ] **Step 1: The minimal facade interface** (`components/auth/src/notifications-facade.ts`) — auth duck-types this; NO import of `@stackbase/notifications`:
```ts
/** The one method auth calls on a composed `@stackbase/notifications` (duck-typed from the action
 *  ctx as `ctx.notifications`). Auth does NOT depend on `@stackbase/notifications`; this is a
 *  structural shape so an auth deployment WITHOUT notifications composed falls back to its own
 *  `EmailProvider`. `critical: true` guarantees the transactional email bypasses the recipient's
 *  notification preferences. */
export interface NotificationsSendFacade {
  send(args: {
    to: { userId?: string; email?: string; phone?: string };
    channels: Array<"email" | "sms" | "in_app">;
    template: { email?: { subject: string; text: string; html?: string } };
    category?: string;
    critical?: boolean;
  }): Promise<{ messageIds: string[] }>;
}
```

- [ ] **Step 2: Auth config** (`components/auth/src/config.ts`). Add `notificationCategory?: string` to `EmailOptions` and `EmailConfig`, and default it in the email-config resolver (find where `EmailConfig` is built from `EmailOptions`; default `notificationCategory: opts.notificationCategory ?? "auth"`):
```ts
// EmailOptions: add
  notificationCategory?: string;
// EmailConfig: add
  notificationCategory: string;
// resolver: add  notificationCategory: e.notificationCategory ?? "auth",
```

- [ ] **Step 3: Route in `requestAction`** (`components/auth/src/functions.ts` ~503-517). Replace the `await e.provider.send({ to: decision.email, from: e.from, ...rendered });` line with a route-or-fallback. Import the type: `import type { NotificationsSendFacade } from "./notifications-facade";`. Replace:
```ts
        const notifications = (ctx as unknown as { notifications?: NotificationsSendFacade }).notifications;
        if (notifications) {
          // UNIFIED PATH: send through the one notification delivery path — N2 retries + reclaim, the
          // shared provider, a unified sender. `critical: true` so the OTP is never suppressed by a
          // recipient's notification preferences. Auth's own rate-limit/anti-enumeration guards
          // already ran in `_issueCode` above.
          await notifications.send({
            to: { email: decision.email },
            channels: ["email"],
            template: { email: rendered },
            category: e.notificationCategory,
            critical: true,
          });
        } else {
          // FALLBACK (no notifications composed): auth's own EmailProvider — byte-identical to before.
          await e.provider.send({ to: decision.email, from: e.from, ...rendered });
        }
```

- [ ] **Step 4: Write the auth-unify E2E** (`packages/cli/test/notifications-auth-unify-e2e.test.ts`). Compose BOTH `defineAuth({ email: { provider: <capture>, from, … } })` and `defineNotifications({ channels: { email: { provider: <capture2>, from } } })`; call the auth `requestVerification` (or the relevant email flow); assert the OTP/link is delivered by the NOTIFICATIONS capture provider (via its driver), NOT auth's own capture provider; and that a preference opt-out of `"auth"` does NOT suppress it (critical). Mirror the N1 E2E boot; compose two components in the `loadProject([...])` array. (Compose order: `defineAuth` must see `ctx.notifications`, so notifications is composed — the `buildAction` facade is attached regardless of order; verify the auth action ctx has `.notifications`.)

Full test skeleton (adapt to the real auth email-flow function names — read `components/auth/src/functions.ts` for the registered `auth:request*` action paths):
```ts
/** N4 — auth unification E2E: with notifications composed, an auth email flow delivers through the
 *  notification driver (not auth's own provider), and a recipient's "auth" opt-out can't suppress it. */
import { describe, it, expect, afterAll } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineAuth } from "@stackbase/auth";
import { defineNotifications, type EmailMessage } from "@stackbase/notifications";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });
async function waitFor(c: () => boolean, ms = 5000, l = "waitFor") { const s = Date.now(); while (!c()) { if (Date.now() - s > ms) throw new Error(`${l} timed out`); await new Promise<void>((r) => setTimeout(r, 10)); } }

describe("notifications N4 — auth unification E2E", () => {
  it("auth email routes through the notification driver, not auth's own provider", async () => {
    const authSent: EmailMessage[] = [];         // auth's OWN provider (should stay EMPTY)
    const notifSent: EmailMessage[] = [];        // notifications' provider (should RECEIVE the OTP)
    const project = loadProject({ schema: defineSchema({ _t: defineTable({ x: v.string() }) }), modules: {} }, [
      defineNotifications({ channels: { email: { provider: { channel: "email", async send(m) { notifSent.push(m as EmailMessage); return { providerMessageId: "n1" }; } }, from: "no-reply@app" } }, driverIntervalMs: 500 }),
      defineAuth({ email: { provider: { async send(m) { authSent.push(m as unknown as EmailMessage); } }, from: "auth@app" } }),
    ]);
    const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()), catalog: project.catalog, modules: project.moduleMap,
      tableNumbers: project.tableNumbers, componentNames: project.componentNames, contextProviders: project.contextProviders,
      bootSteps: project.bootSteps, drivers: project.drivers,
    });
    const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" }); servers.push(server);
    // Trigger an auth email flow via the real HTTP run endpoint (the exact `auth:request*` path — read functions.ts).
    await fetch(`http://127.0.0.1:${server.port}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "auth:requestEmailVerification", args: { email: "u@test" } }) });
    await waitFor(() => notifSent.length >= 1, 5000, "notif delivered the auth email");
    expect(authSent.length).toBe(0);             // auth's own provider was NOT used
    expect(notifSent[0]!.to).toBe("u@test");
  });
});
```
> Implementer: read `components/auth/src/functions.ts` for the exact registered action path of an email flow (e.g. `auth:requestEmailVerification`/`auth:requestOtp`/`auth:signInWithMagicLink`'s request half) and its args; adjust the `path`/`args` above. Add `@stackbase/auth` + `@stackbase/notifications` to `packages/cli/package.json` devDependencies if not already present (both are).

- [ ] **Step 5: Build + run.** `cd <worktree root> && bun run build`, then `cd packages/cli && bunx vitest run test/notifications-auth-unify-e2e.test.ts` → PASS. Also run `bun run --filter @stackbase/auth test` — auth's own tests must stay green (the fallback path is unchanged; the routed path is new).

- [ ] **Step 6: Commit.**
```bash
git add components/auth/src/notifications-facade.ts components/auth/src/config.ts components/auth/src/functions.ts packages/cli/test/notifications-auth-unify-e2e.test.ts
git commit -m "feat(notifications): N4 T4 — auth emails route through notifications when composed (fallback preserved)"
```

---

## Task 5: Digest E2E + docs (Part B close-out)

**Files:** Create `packages/cli/test/notifications-digest-e2e.test.ts`; Modify `docs/enduser/build/notifications.md`.

- [ ] **Step 1: Digest E2E.** Mirror the N1 E2E boot. Compose `defineNotifications({ channels: { email: <capture> }, categories: { updates: { digest: "hourly" } }, driverIntervalMs: 500 })`. Via an app mutation, `send` three `updates` emails to one recipient (they buffer). Backdate is not available over the wire — instead use `digest: "hourly"` and a driver, but to make the window elapse in a test, compose with a **custom tiny window**: since the frequencies are fixed, add a test-only path OR assert the buffered state + that no email is delivered before the window, and (for the flush) drive the component-level flush in T3's unit test (which already proves flush). For the E2E, prove the BUFFER + no-immediate-delivery reactively (three sends → zero `messages` rows delivered, three `digestBuffer` rows), which is the reactive-deferral proof; the flush mechanics are proven at the T3 unit level. (If a sub-hour window is wanted for a live flush E2E, that needs a configurable raw-ms window — out of scope; note it.)

Concretely: assert `send` returns `deferred: ["email"]`, the capture provider receives NOTHING within a beat, and a `digestBuffer` count query (via an app query over the namespaced table using an admin/system read) shows 3. Keep it to what's provable without time travel over the wire.

- [ ] **Step 2: Run.** `bun run build`, then `cd packages/cli && bunx vitest run test/notifications-digest-e2e.test.ts` → PASS.

- [ ] **Step 3: Docs** (`docs/enduser/build/notifications.md`). Add:
  - `## Auth unification` — compose `@stackbase/auth` AND `@stackbase/notifications` and auth's OTP/magic-link/verification/reset emails automatically flow through the one delivery path (N2 retries, the shared provider, a unified `from`); the `critical` server-authority flag (bypasses preferences — set only by server code, never from client input); the graceful fallback (no notifications → auth's own `EmailProvider`, unchanged); the `email.notificationCategory` default `"auth"`.
  - `## Digest` — `categories: { updates: { digest: "daily" } }` + a `digestTemplates: { updates: (items) => ({ subject, text }) }` (or the built-in default); email-only, in_app stays immediate; the rolling window; preferences re-checked at flush; the send returns `deferred: ["email"]` for a buffered channel.
  - Update the scope banner: **N4 is the final arc slice** — digest + auth-unification shipped. "What's deferred" (post-arc): SMS/in_app digest, per-user digest frequency, threshold batching, a crash-orphan digest reaper, provider-fallback + time-based routing.

- [ ] **Step 4: Commit.**
```bash
git add packages/cli/test/notifications-digest-e2e.test.ts docs/enduser/build/notifications.md
git commit -m "feat(notifications): N4 T5 — digest E2E + auth-unification & digest docs (arc complete)"
```

---

## Verification (after each task; full gate after T5)

```bash
bun run --filter @stackbase/notifications typecheck && bun run --filter @stackbase/notifications test
bun run --filter @stackbase/auth typecheck && bun run --filter @stackbase/auth test   # after T4
bun run build   # then: cd packages/cli && bunx vitest run test/notifications-auth-unify-e2e.test.ts test/notifications-digest-e2e.test.ts
bun run build && bun run typecheck && bun run test   # whole-repo gate
```

Dist-resolution rule: rebuild `@stackbase/notifications`/`@stackbase/auth`/`@stackbase/client` before the CLI E2Es. Compact-at-every-boundary rule for all new `db.insert`/`db.replace`/`runFunction`/`runMutation` args-and-returns and wire returns.

## Self-Review

- **Spec coverage:** critical flag + gate (T1, spec A1/A2); auth routing + fallback + no-dependency + notificationCategory (T4, spec A3/A4/A5); digest email-only config + buffer-on-send + deferred (T2, spec B1/B2/B3); digest driver flush + rolling window + claim + digestTemplate + default + preference-at-flush (T3, spec B4/B5/B6); E2Es (T4 auth, T5 digest) + docs (T5). All spec sections map.
- **Type consistency:** `SendArgs.critical` (T1) consumed by the gate (T1) + auth route (T4); `recordSend`'s `{…, deferred}` threaded through `_enqueueSend` + both facades (T2); `DigestFrequency`/`DigestItem`/`DigestTemplateFn`/`digestWindowMs`/`digestTemplates` defined in config (T2), consumed by `digest.ts` (T3); `NotificationsSendFacade` (T4) matches the notifications `send` arg shape incl. `critical`.
- **Single chokepoint:** critical-bypass + digest-buffer both live in `recordSend`; the digest flush routes its combined email back through `recordSend` (preference-checked at flush). No second gate.
- **Auth independence:** `components/auth` never imports `@stackbase/notifications` (duck-typed `NotificationsSendFacade`); the fallback path is unchanged.
- **Boundary rule:** every new `db.insert`/`db.replace`/`recordSend`-args/`runFunction`-args uses `compact`.
