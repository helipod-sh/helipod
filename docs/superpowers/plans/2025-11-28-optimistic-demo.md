# `examples/optimistic-demo` ("Pulse") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable example app under `examples/optimistic-demo` that makes optimistic updates *visible*: a live poll board with a latency slider (delay-injecting transport wrapper), an optimistic ON/OFF switch, rapid-fire stacking with a "+N in flight" chip, a repeatable `POLL_CLOSED` exact-rollback demo, `placeholderId` poll creation, and a deliberate wrong-guess (+2) mode that settles to truth.

**Architecture:** Mirrors `examples/offline-demo` file-for-file (convex functions + codegen, React SPA bundled by `bun build`, served by `stackbase dev --web`), on **port 3230**. One demo-local `web/delay-transport.ts` wraps the public `ClientTransport` seam to delay outbound `Mutation` frames only. Deliberately **outbox-free** — pure online optimistic path. No engine or client-package changes.

**Tech Stack:** TypeScript, Bun, React 18, vitest under Node, `@stackbase/*` via built `dist/`, `ws` for the Node-side E2E WebSocket.

**Spec:** `docs/superpowers/specs/2025-11-28-optimistic-demo-design.md`

## Global Constraints

- Port **3230** (chat 3210, offline-demo 3220 — all three must run side-by-side).
- Every function declares `args` AND `returns` validators.
- Cross-package imports resolve via built `dist/` — repo already built; touch no `packages/*`.
- Tests run under **Node** via vitest; no Bun-only APIs in tests.
- `web/main.js` is gitignored (`examples/*/web/main.js`); never commit it. `convex/_generated/` IS committed (drift test).
- `ctx.db.query(table, index)` requires an index name; the implicit `by_creation` index exists on every table.
- No `ctx.db.patch` — `ctx.db.get` then `ctx.db.replace(id, fullUserFieldsValue)`.
- No `stackbase.config.ts` (optional file; no components).
- **No outbox anywhere in this example** — no `indexedDBOutbox`, no `optimisticUpdates` registry, no `mintId`. Poll creation uses `store.placeholderId("polls")`.
- The delay wrapper delays outbound frames with `message.type === "Mutation"` ONLY (read structurally; never import `@stackbase/sync`); everything else passes through untouched.
- Updater purity: module-scoped updaters; ids/time only from `store.placeholderId`/`store.now`; every updater tolerates an `undefined` query baseline.
- Known engine facts: `_generated/server.ts` imports need `@stackbase/executor` as a dependency; the first codegen needs a stub `_generated/server.ts` pre-written via `@stackbase/codegen`'s `generateServer` (chicken-and-egg — see `examples/offline-demo`'s history), after which `bun run codegen` owns the file.
- Commits end with:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015RKShEWjRcmbQVJ8ooUPP6
```

---

### Task 1: Backend — scaffold, schema, functions, unit tests, codegen

**Files:**
- Create: `examples/optimistic-demo/package.json`
- Create: `examples/optimistic-demo/tsconfig.json`
- Create: `examples/optimistic-demo/convex/schema.ts`
- Create: `examples/optimistic-demo/convex/polls.ts`
- Create: `examples/optimistic-demo/convex/options.ts`
- Create: `examples/optimistic-demo/scripts/codegen.ts`
- Create: `examples/optimistic-demo/convex/_generated/*` (via codegen — never hand-write)
- Test: `examples/optimistic-demo/test/optimistic-demo.test.ts`

**Interfaces:**
- Consumes: `@stackbase/values`, `@stackbase/errors` (`UserError`, `DocumentNotFoundError`), `@stackbase/cli` (`push`, `loadProject`), `@stackbase/runtime-embedded`, `@stackbase/docstore-sqlite`.
- Produces (later tasks rely on): function paths `polls:list` `polls:create` `polls:setClosed` `options:list` `options:vote`; arg shapes `polls.create {question, options: string[]}` → returns poll id, `polls.setClosed {id, closed}`, `options.vote {id}` → returns the new count (number); error code `"POLL_CLOSED"`; `convex/_generated/api` (`Api`), `dataModel` (`Doc`, `Id`).

- [ ] **Step 1: Scaffold the package**

Create `examples/optimistic-demo/package.json`:

```json
{
  "name": "stackbase-example-optimistic-demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "codegen": "bun run scripts/codegen.ts",
    "web:build": "bun build web/main.tsx --outfile web/main.js",
    "dev": "bun ../../packages/cli/dist/bin.js dev --dir convex --web web --port 3230"
  },
  "dependencies": {
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": {
    "@stackbase/cli": "workspace:*",
    "@stackbase/client": "workspace:*",
    "@stackbase/codegen": "workspace:*",
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/query-engine": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@types/node": "catalog:",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "@types/ws": "^8.5.13",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "catalog:",
    "vitest": "catalog:",
    "ws": "^8.18.0"
  }
}
```

(Same as offline-demo's final manifest plus `@stackbase/codegen` — used once by the bootstrap step below — and `ws`/`@types/ws` for Task 4's E2E.)

Create `examples/optimistic-demo/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "types": ["node"],
    "jsx": "react-jsx"
  },
  "include": ["convex", "test", "scripts", "web"]
}
```

Create `examples/optimistic-demo/scripts/codegen.ts`:

```ts
/**
 * Regenerate convex/_generated from the schema + functions. Run with `bun run scripts/codegen.ts`.
 * The dev CLI does this automatically; this script also backs the "generated is up to date" test.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { push } from "@stackbase/cli";
import schema from "../convex/schema";
import * as polls from "../convex/polls";
import * as options from "../convex/options";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "../convex/_generated");

const { generated } = push({ schema, modules: { polls, options } });
mkdirSync(generatedDir, { recursive: true });
for (const file of generated.files) writeFileSync(join(generatedDir, file.path), file.content, "utf8");
process.stdout.write(`generated: ${generated.files.map((f) => f.path).join(", ")}\n`);
```

Run `cd /Volumes/Projects/concave-dev && bun install` to link the workspace.

- [ ] **Step 2: Write the failing test**

Create `examples/optimistic-demo/test/optimistic-demo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, push, type LoadedProject } from "@stackbase/cli";
import schema from "../convex/schema";
import * as polls from "../convex/polls";
import * as options from "../convex/options";

const loaded: LoadedProject = { schema, modules: { polls, options } };

type OptionRow = { _id: string; label: string; votes: number };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

async function createPoll(question = "Lunch?", opts = ["Pizza", "Sushi"]): Promise<{ pollId: string; options: OptionRow[] }> {
  const created = await runtime.run<string>("polls:create", { question, options: opts });
  const pollId = created.value;
  const listed = await runtime.run<OptionRow[]>("options:list", { pollId });
  return { pollId, options: listed.value };
}

describe("pulse — composite poll creation", () => {
  it("polls.create inserts the poll and one zero-vote option row per label in one transaction", async () => {
    const { pollId, options: opts } = await createPoll("Lunch?", ["Pizza", "Sushi", "Salad"]);
    expect(typeof pollId).toBe("string");
    expect(opts.map((o) => o.label)).toEqual(["Pizza", "Sushi", "Salad"]);
    expect(opts.every((o) => o.votes === 0)).toBe(true);

    const allPolls = await runtime.run<Array<{ question: string; closed: boolean }>>("polls:list", {});
    expect(allPolls.value.map((p) => p.question)).toEqual(["Lunch?"]);
    expect(allPolls.value[0]!.closed).toBe(false);
  });
});

describe("pulse — voting", () => {
  it("vote increments and returns the new count", async () => {
    const { options: opts } = await createPoll();
    const first = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(first.value).toBe(1);
    const second = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(second.value).toBe(2);

    const after = await runtime.run<OptionRow[]>("options:list", { pollId: (await runtime.run<Array<{ _id: string }>>("polls:list", {})).value[0]!._id });
    expect(after.value.find((o) => o.label === "Pizza")!.votes).toBe(2);
  });

  it("vote into a closed poll rejects with code POLL_CLOSED; reopening makes it votable again", async () => {
    const { pollId, options: opts } = await createPoll();
    await runtime.run("polls:setClosed", { id: pollId, closed: true });

    const err = await runtime.run("options:vote", { id: opts[0]!._id }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("POLL_CLOSED");

    await runtime.run("polls:setClosed", { id: pollId, closed: false });
    const after = await runtime.run<number>("options:vote", { id: opts[0]!._id });
    expect(after.value).toBe(1);
  });
});

describe("codegen — the committed _generated matches the schema", () => {
  it("convex/_generated is up to date (no drift)", () => {
    const { generated } = push(loaded);
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../convex/_generated");
    for (const file of generated.files) {
      expect(readFileSync(join(dir, file.path), "utf8"), `${file.path} is stale — run \`bun run scripts/codegen.ts\``).toBe(
        file.content,
      );
    }
  });
});
```

- [ ] **Step 3: Verify the test fails**

Run: `cd examples/optimistic-demo && bun run test`
Expected: FAIL — `Cannot find module '../convex/schema'`.

- [ ] **Step 4: Implement schema and functions**

Create `examples/optimistic-demo/convex/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

// Counters live ON option rows: each vote is a read-modify-write increment, so rapid fire shows
// stacked optimistic layers as a climbing number — the demo's whole point.
export default defineSchema({
  polls: defineTable({
    question: v.string(),
    closed: v.boolean(),
  }),
  options: defineTable({
    pollId: v.id("polls"),
    label: v.string(),
    votes: v.number(),
  }).index("by_poll", ["pollId"]),
});
```

Create `examples/optimistic-demo/convex/polls.ts`:

```ts
import { v } from "@stackbase/values";
import { query, mutation } from "./_generated/server";

const pollShape = v.object({
  _id: v.id("polls"),
  _creationTime: v.number(),
  question: v.string(),
  closed: v.boolean(),
});

export const list = query({
  args: {},
  returns: v.array(pollShape),
  handler: (ctx) => ctx.db.query("polls", "by_creation").collect(),
});

export const create = mutation({
  // Composite intent: the poll and its option rows are one transaction, so a subscriber can
  // never observe a poll without its options.
  args: { question: v.string(), options: v.array(v.string()) },
  returns: v.id("polls"),
  handler: async (ctx, { question, options }) => {
    const pollId = await ctx.db.insert("polls", { question, closed: false });
    for (const label of options) await ctx.db.insert("options", { pollId, label, votes: 0 });
    return pollId;
  },
});

export const setClosed = mutation({
  // Close AND reopen — the rollback demo (vote into a closed poll) stays repeatable.
  args: { id: v.id("polls"), closed: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, closed }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null; // toggling a vanished poll is a no-op, not an error
    await ctx.db.replace(id, { question: doc.question as string, closed });
    return null;
  },
});
```

Create `examples/optimistic-demo/convex/options.ts`:

```ts
import { v } from "@stackbase/values";
import { UserError, DocumentNotFoundError } from "@stackbase/errors";
import { query, mutation } from "./_generated/server";

/** The rollback demo's trigger: a typed, coded `UserError` subclass. An ONLINE optimistic
 * mutation that throws this rejects the caller's promise, and the client drops the optimistic
 * layer in the same reconcile pass — the count visibly snaps back, exactly. */
export class PollClosedError extends UserError {
  override readonly code = "POLL_CLOSED";
}

export const list = query({
  args: { pollId: v.id("polls") },
  returns: v.array(
    v.object({
      _id: v.id("options"),
      _creationTime: v.number(),
      pollId: v.id("polls"),
      label: v.string(),
      votes: v.number(),
    }),
  ),
  handler: (ctx, args) => ctx.db.query("options", "by_poll").eq("pollId", args.pollId).collect(),
});

export const vote = mutation({
  args: { id: v.id("options") },
  returns: v.number(),
  handler: async (ctx, { id }) => {
    const opt = await ctx.db.get(id);
    if (opt === null) throw new DocumentNotFoundError(`option ${id} not found`);
    const poll = await ctx.db.get(opt.pollId as string);
    if (poll !== null && (poll.closed as boolean)) {
      throw new PollClosedError(`poll "${String(poll.question)}" is closed — voting has ended`);
    }
    const next = (opt.votes as number) + 1;
    await ctx.db.replace(id, { pollId: opt.pollId, label: opt.label as string, votes: next });
    return next;
  },
});
```

- [ ] **Step 5: Bootstrap `_generated` and run codegen**

The convex modules import `./_generated/server`, which doesn't exist yet (chicken-and-egg). Bootstrap it, then run the real codegen:

```bash
cd examples/optimistic-demo
bun -e 'import { generateServer } from "@stackbase/codegen"; import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("convex/_generated", { recursive: true }); writeFileSync("convex/_generated/server.ts", generateServer());'
bun run codegen
```

Expected: `generated: …` listing at least `api.d.ts, dataModel.d.ts, server.ts, ids.ts` (exact set is whatever `push` emits). If `generateServer()` needs arguments in the current API, check `examples/offline-demo`'s git history for the exact bootstrap invocation used there (commit `4c49321`) and mirror it.

- [ ] **Step 6: Run the tests — all pass**

Run: `cd examples/optimistic-demo && bun run test`
Expected: PASS — 4 tests (create composite, two voting tests, drift).

- [ ] **Step 7: Typecheck**

Run: `cd examples/optimistic-demo && bun run typecheck`
Expected: clean. (Only after Step 5 — the test imports nothing from `_generated`, but `polls.ts`/`options.ts` do.)

- [ ] **Step 8: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/optimistic-demo bun.lock
git commit -m "feat(examples): optimistic-demo backend — pulse polls schema, vote/POLL_CLOSED rule"
```

---

### Task 2: The delay transport

**Files:**
- Create: `examples/optimistic-demo/web/delay-transport.ts`
- Test: `examples/optimistic-demo/test/delay-transport.test.ts`

**Interfaces:**
- Consumes: `ClientTransport` + `webSocketTransport` from `@stackbase/client`.
- Produces: `delayTransport(url, makeInner?)` returning `DelayTransport` — a `ClientTransport` plus `setDelay(ms: number): void` and `getDelay(): number`. Task 3's `main.tsx` and Task 4's E2E construct the client with it.

Semantics (from the spec, encoded in the code below):
- Only outbound frames with `message.type === "Mutation"` are delayed (structural read — no `@stackbase/sync` import). Everything else passes through immediately.
- FIFO among mutations is preserved even when the delay is LOWERED mid-flight: each delayed frame is scheduled at `max(now + delayMs, lastScheduledFireAt)`, so a later mutation can never overtake an earlier one (mutation order matters to the engine).
- `setDelay(0)` with nothing pending sends immediately (no timer hop).
- `close()` drops pending delayed frames (a socket dying mid-flight drops frames too) and closes the inner.

- [ ] **Step 1: Write the failing test**

Create `examples/optimistic-demo/test/delay-transport.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ClientTransport } from "@stackbase/client";
import { delayTransport } from "../web/delay-transport";

type Sent = Parameters<ClientTransport["send"]>[0];

function fakeInner() {
  const sent: Sent[] = [];
  let closed = false;
  const t: ClientTransport = {
    send: (m) => sent.push(m),
    onMessage: () => () => {},
    onClose: () => () => {},
    onReopen: () => () => {},
    close: () => {
      closed = true;
    },
  };
  return { t, sent, isClosed: () => closed };
}

const MUT = (n: number) => ({ type: "Mutation", requestId: `r${n}` }) as unknown as Sent;
const SUB = { type: "ModifyQuerySet", add: [], remove: [] } as unknown as Sent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("delayTransport", () => {
  it("delay 0: mutations pass through immediately", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.send(MUT(1));
    expect(inner.sent).toEqual([MUT(1)]);
  });

  it("delay 500: a mutation is held exactly the delay, then delivered", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(500);
    t.send(MUT(1));
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(499);
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(inner.sent).toEqual([MUT(1)]);
  });

  it("non-mutation frames pass through immediately even at 3s delay", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(3000);
    t.send(SUB);
    expect(inner.sent).toEqual([SUB]);
  });

  it("FIFO survives lowering the delay mid-flight: a later 0ms mutation never overtakes an earlier delayed one", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(1000);
    t.send(MUT(1));
    t.setDelay(0);
    t.send(MUT(2)); // must NOT arrive before MUT(1)
    expect(inner.sent).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toEqual([MUT(1), MUT(2)]);
  });

  it("close() drops pending delayed frames — nothing arrives late, inner is closed", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    t.setDelay(500);
    t.send(MUT(1));
    t.close();
    vi.advanceTimersByTime(1000);
    expect(inner.sent).toEqual([]);
    expect(inner.isClosed()).toBe(true);
  });

  it("getDelay reflects setDelay", () => {
    const inner = fakeInner();
    const t = delayTransport("ws://x", () => inner.t);
    expect(t.getDelay()).toBe(0);
    t.setDelay(250);
    expect(t.getDelay()).toBe(250);
  });
});
```

- [ ] **Step 2: Verify it fails**

Run: `cd examples/optimistic-demo && bun run test -- delay-transport`
Expected: FAIL — `Cannot find module '../web/delay-transport'`.

- [ ] **Step 3: Implement**

Create `examples/optimistic-demo/web/delay-transport.ts`:

```ts
/**
 * A latency-injecting wrapper on the PUBLIC `ClientTransport` seam — the demo's device for
 * making optimistic updates visible. Only outbound `Mutation` frames are delayed: subscriptions
 * and every inbound frame stay instant, so queries are live and only WRITES feel the latency —
 * which is exactly where optimistic UI lives.
 *
 * FIFO is load-bearing: mutation order matters to the engine, so a frame is scheduled at
 * `max(now + delay, lastScheduledFireAt)` — lowering the slider mid-flight can never let a
 * later mutation overtake an earlier one.
 */
import { webSocketTransport, type ClientTransport } from "@stackbase/client";

type OutboundMessage = Parameters<ClientTransport["send"]>[0];

export interface DelayTransport extends ClientTransport {
  setDelay(ms: number): void;
  getDelay(): number;
}

export function delayTransport(
  url: string,
  makeInner: (url: string) => ClientTransport = webSocketTransport,
): DelayTransport {
  const inner = makeInner(url);
  let delayMs = 0;
  let closed = false;
  let lastScheduledFireAt = 0;
  const pending = new Set<ReturnType<typeof setTimeout>>();

  return {
    send(message: OutboundMessage): void {
      if (closed) return;
      const isMutation = (message as { type?: string }).type === "Mutation";
      const now = Date.now();
      const fireAt = isMutation ? Math.max(now + delayMs, lastScheduledFireAt) : now;
      if (fireAt <= now && pending.size === 0) {
        inner.send(message);
        return;
      }
      if (isMutation) lastScheduledFireAt = fireAt;
      if (!isMutation) {
        // Non-mutation frames never queue behind mutations — pass through now.
        inner.send(message);
        return;
      }
      const timer = setTimeout(() => {
        pending.delete(timer);
        if (!closed) inner.send(message);
      }, fireAt - now);
      pending.add(timer);
    },
    onMessage: (l) => inner.onMessage(l),
    onClose: (l) => inner.onClose(l),
    onReopen: (l) => inner.onReopen?.(l) ?? (() => {}),
    close(): void {
      if (closed) return;
      closed = true;
      for (const t of pending) clearTimeout(t);
      pending.clear();
      inner.close();
    },
    setDelay(ms: number): void {
      delayMs = ms;
    },
    getDelay(): number {
      return delayMs;
    },
  };
}
```

- [ ] **Step 4: Run the tests — pass; typecheck**

Run: `cd examples/optimistic-demo && bun run test -- delay-transport && bun run typecheck`
Expected: 6 tests PASS; typecheck clean. Note the FIFO test also passes through the `fireAt <= now && pending.size === 0` guard — a 0ms mutation with a pending predecessor takes the timer path at `lastScheduledFireAt`.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/optimistic-demo/web/delay-transport.ts examples/optimistic-demo/test/delay-transport.test.ts
git commit -m "feat(examples): optimistic-demo delay transport — FIFO-safe mutation latency injection"
```

---

### Task 3: The web app

**Files:**
- Create: `examples/optimistic-demo/web/index.html`
- Create: `examples/optimistic-demo/web/main.tsx`
- Produces (not committed): `web/main.js` via `bun run web:build` (gitignored)

**Interfaces:**
- Consumes: `delayTransport` (Task 2); function paths + shapes (Task 1); `@stackbase/client` (`StackbaseClient`, `anyApi`, `OptimisticLocalStore`) and `@stackbase/client/react` (`StackbaseProvider`, `useQuery`, `useMutation`).
- Produces: the served demo page.

- [ ] **Step 1: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Pulse — Stackbase optimistic demo</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font: 15px/1.5 system-ui, sans-serif;
        background: #0b0c10;
        color: #e6e7eb;
        display: flex;
        justify-content: center;
      }
      .app { width: 100%; max-width: 760px; min-height: 100dvh; display: flex; flex-direction: column; padding: 1rem; gap: 0.75rem; }
      header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.75rem; }
      h1 { font-size: 1.25rem; margin: 0; }
      .controls { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; font-size: 0.85rem; }
      .seg { display: inline-flex; border: 1px solid #2a2f3d; border-radius: 999px; overflow: hidden; }
      .seg button { border: 0; background: transparent; color: inherit; padding: 0.3rem 0.7rem; cursor: pointer; font: inherit; font-size: 0.82rem; }
      .seg button.active { background: #2563eb; }
      .switch { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.3rem 0.7rem; border: 1px solid #2a2f3d; border-radius: 999px; cursor: pointer; user-select: none; }
      .switch.on { background: #10321c; border-color: #1f6f3d; }
      .switch.warn.on { background: #33261a; border-color: #8a5a2b; }
      .polls { display: flex; flex-direction: column; gap: 0.75rem; }
      .poll { background: #14161d; border: 1px solid #232734; border-radius: 12px; padding: 0.8rem; }
      .poll.pending { opacity: 0.55; }
      .poll h2 { font-size: 1rem; margin: 0 0 0.5rem; display: flex; align-items: center; gap: 0.5rem; }
      .poll h2 .grow { flex: 1; }
      .poll h2 button { font-size: 0.75rem; padding: 0.2rem 0.55rem; }
      .opt { display: grid; grid-template-columns: 6rem 1fr 3.5rem 4.5rem; align-items: center; gap: 0.6rem; padding: 0.25rem 0; }
      .opt .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bar { height: 0.9rem; background: #1c2030; border-radius: 6px; overflow: hidden; }
      .bar > div { height: 100%; background: #2563eb; transition: width 120ms ease; }
      .count { text-align: right; font-variant-numeric: tabular-nums; }
      .inflight { font-size: 0.72rem; color: #f0b429; text-align: right; min-height: 1em; }
      button { padding: 0.4rem 0.8rem; border: 0; border-radius: 8px; background: #2563eb; color: white; font: inherit; cursor: pointer; }
      button:hover { background: #1d4ed8; }
      button.subtle { background: #232734; }
      form { display: flex; gap: 0.5rem; flex-wrap: wrap; }
      input[type="text"] { flex: 1; min-width: 10rem; padding: 0.5rem 0.7rem; border-radius: 8px; border: 1px solid #2a2f3d; background: #0f1117; color: inherit; font: inherit; }
      .status { color: #6b6f7a; font-style: italic; padding: 0.4rem; }
      .toast { position: fixed; bottom: 1rem; left: 50%; transform: translateX(-50%); background: #3a1620; border: 1px solid #7f2d3f; padding: 0.5rem 1rem; border-radius: 10px; }
      footer { color: #6b6f7a; font-size: 0.78rem; text-align: center; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `web/main.tsx`**

```tsx
import { StrictMode, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { StackbaseClient, anyApi, type OptimisticLocalStore } from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation } from "@stackbase/client/react";
import { delayTransport } from "./delay-transport";
// Type-only imports — erased at bundle time, so server-side re-exports never reach the browser.
import type { Api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";

const api = anyApi as Api;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
export const transport = delayTransport(`${wsProtocol}://${location.host}/api/sync`);

// NO outbox, NO optimisticUpdates registry: this demo is the pure ONLINE optimistic path —
// examples/offline-demo owns durability. A failed mutation here rejects its promise and the
// optimistic layer is dropped in the same reconcile pass (the exact-rollback demo).
const client = new StackbaseClient(transport);

/* ------------------------------------------------------------------------------------------------
 * Optimistic updaters — module-scoped and PURE (replay-safe): ids/time only from the store API,
 * and every updater tolerates an `undefined` baseline (query not subscribed yet → patch nothing).
 * ---------------------------------------------------------------------------------------------- */

type PendingPoll = Doc<"polls"> | (Doc<"polls"> & { pending: true });
type OptionRow = Doc<"options">;

function bumpVotes(store: OptimisticLocalStore, id: Id<"options">, delta: number): void {
  // The option's poll isn't in args, so patch every subscribed options.list — cheap (a demo has
  // a handful of polls) and exactly what getAllQueries exists for.
  for (const q of store.getAllQueries(api.options.list)) {
    if (q.value === undefined) continue;
    store.setQuery(
      api.options.list,
      q.args,
      (q.value as OptionRow[]).map((o) => (o._id === id ? { ...o, votes: o.votes + delta } : o)),
    );
  }
}

function voteOptimistic(store: OptimisticLocalStore, args: { id: Id<"options"> }): void {
  bumpVotes(store, args.id, 1);
}

/** Wrong-guess mode: the updater claims +2 while the server commits +1. On settle the count
 * visibly snaps to truth — the documented echo-snap residual, on purpose: an updater is a guess,
 * the server is always right. */
function voteOptimisticWrong(store: OptimisticLocalStore, args: { id: Id<"options"> }): void {
  bumpVotes(store, args.id, 2);
}

function createPollOptimistic(store: OptimisticLocalStore, args: { question: string; options: string[] }): void {
  const pollsQ = store.getQuery(api.polls.list, {});
  if (pollsQ === undefined) return;
  const row: PendingPoll = {
    _id: store.placeholderId("polls") as Id<"polls">, // rendering-only placeholder — never sent anywhere
    _creationTime: store.now(),
    question: args.question,
    closed: false,
    pending: true,
  };
  store.setQuery(api.polls.list, {}, [...(pollsQ as PendingPoll[]), row]);
  // The pending poll's options can't render yet (options.list is keyed by the REAL poll id, which
  // doesn't exist until commit) — the card shows its question dimmed until the settle. Honest.
}

/* ---------------------------------------- components ------------------------------------------ */

const LATENCY_STOPS = [0, 250, 1000, 3000] as const;

function Controls(props: {
  latency: number;
  onLatency: (ms: number) => void;
  optimistic: boolean;
  onOptimistic: (v: boolean) => void;
  wrongGuess: boolean;
  onWrongGuess: (v: boolean) => void;
}) {
  return (
    <div className="controls">
      <span className="seg">
        {LATENCY_STOPS.map((ms) => (
          <button key={ms} className={props.latency === ms ? "active" : ""} onClick={() => props.onLatency(ms)}>
            {ms === 0 ? "0ms" : ms < 1000 ? `${ms}ms` : `${ms / 1000}s`}
          </button>
        ))}
      </span>
      <span className={`switch${props.optimistic ? " on" : ""}`} onClick={() => props.onOptimistic(!props.optimistic)}>
        optimistic: <b>{props.optimistic ? "ON" : "OFF"}</b>
      </span>
      <span
        className={`switch warn${props.wrongGuess ? " on" : ""}`}
        title="the updater guesses +2; the server commits +1 — watch the settle correct it"
        onClick={() => props.onWrongGuess(!props.wrongGuess)}
      >
        wrong-guess: <b>{props.wrongGuess ? "ON" : "OFF"}</b>
      </span>
    </div>
  );
}

function Poll(props: {
  poll: PendingPoll;
  optimistic: boolean;
  wrongGuess: boolean;
  onToast: (msg: string) => void;
}) {
  const pending = "pending" in props.poll;
  return (
    <section className={pending ? "poll pending" : "poll"}>
      <PollHeader poll={props.poll} pending={pending} />
      {pending ? (
        <p className="status">creating… (rendered via placeholderId, dimmed until the commit settles)</p>
      ) : (
        <PollOptions pollId={props.poll._id} optimistic={props.optimistic} wrongGuess={props.wrongGuess} onToast={props.onToast} />
      )}
    </section>
  );
}

function PollHeader(props: { poll: PendingPoll; pending: boolean }) {
  const setClosed = useMutation(api.polls.setClosed);
  return (
    <h2>
      <span className="grow">
        {props.poll.question} {props.poll.closed && <span title="closed — votes will be rejected">🔒</span>}
      </span>
      {!props.pending && (
        <button
          className="subtle"
          onClick={() => void setClosed({ id: props.poll._id, closed: !props.poll.closed }).catch(() => {})}
        >
          {props.poll.closed ? "reopen" : "close"}
        </button>
      )}
    </h2>
  );
}

// A SEPARATE component so useQuery(api.options.list, { pollId }) is only ever mounted with a
// REAL poll id. A pending (placeholderId) poll must not subscribe: useQuery's args default is
// {} when undefined, which would fail options.list's args validator (pollId required).
function PollOptions(props: { pollId: Id<"polls">; optimistic: boolean; wrongGuess: boolean; onToast: (msg: string) => void }) {
  const options = useQuery(api.options.list, { pollId: props.pollId }) as OptionRow[] | undefined;
  const voteRaw = useMutation(api.options.vote);
  const voteRight = voteRaw.withOptimisticUpdate(voteOptimistic);
  const voteWrong = voteRaw.withOptimisticUpdate(voteOptimisticWrong);
  const [inflight, setInflight] = useState<Record<string, number>>({});

  const vote = props.optimistic ? (props.wrongGuess ? voteWrong : voteRight) : voteRaw;
  const total = options?.reduce((s, o) => s + o.votes, 0) ?? 0;

  async function onVote(id: Id<"options">) {
    setInflight((m) => ({ ...m, [id]: (m[id] ?? 0) + 1 }));
    try {
      await vote({ id });
    } catch (e) {
      props.onToast(`vote rejected: ${(e as { code?: string }).code ?? "error"} — rolled back exactly`);
    } finally {
      setInflight((m) => ({ ...m, [id]: Math.max(0, (m[id] ?? 1) - 1) }));
    }
  }

  return (
    <>
      {options === undefined && <p className="status">loading…</p>}
      {options?.map((o) => (
        <div className="opt" key={o._id}>
          <button onClick={() => void onVote(o._id)}>{o.label}</button>
          <div className="bar">
            <div style={{ width: total === 0 ? "0%" : `${(o.votes / total) * 100}%` }} />
          </div>
          <span className="count">{o.votes}</span>
          <span className="inflight">{(inflight[o._id] ?? 0) > 0 ? `+${inflight[o._id]} in flight` : ""}</span>
        </div>
      ))}
    </>
  );
}

function NewPoll() {
  const create = useMutation(api.polls.create).withOptimisticUpdate(createPollOptimistic);
  const [question, setQuestion] = useState("");
  const [labels, setLabels] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const q = question.trim();
    const opts = labels.split(",").map((s) => s.trim()).filter(Boolean);
    if (!q || opts.length === 0) return;
    void create({ question: q, options: opts }).catch(() => {});
    setQuestion("");
    setLabels("");
  }

  return (
    <form onSubmit={submit}>
      <input type="text" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="New poll question…" />
      <input type="text" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="Options, comma-separated" />
      <button type="submit">Create</button>
    </form>
  );
}

function App() {
  const polls = useQuery(api.polls.list, {}) as PendingPoll[] | undefined;
  const [latency, setLatency] = useState(transport.getDelay());
  const [optimistic, setOptimistic] = useState(true);
  const [wrongGuess, setWrongGuess] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  function onLatency(ms: number) {
    transport.setDelay(ms);
    setLatency(ms);
  }
  function onToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  return (
    <div className="app">
      <header>
        <h1>📊 Pulse</h1>
        <Controls
          latency={latency}
          onLatency={onLatency}
          optimistic={optimistic}
          onOptimistic={setOptimistic}
          wrongGuess={wrongGuess}
          onWrongGuess={setWrongGuess}
        />
      </header>
      <div className="polls">
        {polls === undefined && <p className="status">connecting…</p>}
        {polls?.length === 0 && <p className="status">No polls yet — create one 👇</p>}
        {polls?.map((p) => (
          <Poll key={p._id} poll={p} optimistic={optimistic} wrongGuess={wrongGuess} onToast={onToast} />
        ))}
      </div>
      <NewPoll />
      {toast && <div className="toast">{toast}</div>}
      <footer>
        Crank latency to 3s and vote with optimistic OFF, then ON. Rapid-fire a button (stacking). Close a poll and vote
        (exact rollback). Wrong-guess mode: +2 instantly, settles to +1 — the server is always right.
      </footer>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <StackbaseProvider client={client}>
        <App />
      </StackbaseProvider>
    </StrictMode>,
  );
}
```

(The `Poll` / `PollHeader` / `PollOptions` split above is deliberate and load-bearing: `useQuery`'s args default to `{}` when undefined, which would fail `options.list`'s validator — so the options subscription lives in a child component that only mounts with a real poll id, keeping hooks unconditional.)

- [ ] **Step 3: Build the bundle**

Run: `cd examples/optimistic-demo && bun run web:build`
Expected: `web/main.js` written, no errors. Do NOT commit it.

- [ ] **Step 4: Typecheck**

Run: `cd examples/optimistic-demo && bun run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/optimistic-demo/web/index.html examples/optimistic-demo/web/main.tsx
git commit -m "feat(examples): optimistic-demo web app — pulse polls UI, latency slider, optimistic/wrong-guess toggles"
```

---

### Task 4: The E2E — the headline claims through the real dev server

**Files:**
- Test: `examples/optimistic-demo/test/optimistic-demo-e2e.test.ts`

**Interfaces:**
- Consumes: `startDevServer`/`loadProject` from `@stackbase/cli`; `delayTransport` (Task 2) with an injected `ws`-backed inner; the raw client's `client.mutation(ref, args, { optimisticUpdate })` and `client.subscribe(ref, args, listener)`.

- [ ] **Step 1: Write the E2E**

Create `examples/optimistic-demo/test/optimistic-demo-e2e.test.ts`:

```ts
/**
 * Pulse E2E — the demo's headline claims through the REAL machinery: the real `stackbase dev`
 * server, a real StackbaseClient over a real WebSocket, and the demo's own delayTransport
 * injecting write latency.
 *
 * Claim 1 (why optimistic exists): under 500ms injected write latency, a subscribed query
 * reflects an optimistic vote IMMEDIATELY — before the mutation promise resolves — and never
 * flickers back; the plain (non-optimistic) variant shows nothing until the server answers.
 *
 * Claim 2 (exact rollback): a vote into a closed poll bumps optimistically, the server rejects
 * with coded POLL_CLOSED, and the subscribed value ends exactly at the pre-vote count.
 */
import { describe, it, expect } from "vitest";
import WebSocket from "ws";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { StackbaseClient, webSocketTransport, type ClientTransport, type OptimisticLocalStore } from "@stackbase/client";
import { loadProject, startDevServer, type DevServer } from "@stackbase/cli";
import schema from "../convex/schema";
import * as polls from "../convex/polls";
import * as options from "../convex/options";
import { delayTransport } from "../web/delay-transport";

type OptionRow = { _id: string; label: string; votes: number };

async function startServer(): Promise<{ runtime: EmbeddedRuntime; server: DevServer }> {
  const project = loadProject({ schema, modules: { polls, options } });
  const runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
    tableNumbers: project.tableNumbers,
  });
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1" });
  return { runtime, server };
}

function nodeInner(url: string): ClientTransport {
  return webSocketTransport(url, {
    initialBackoffMs: 40,
    maxBackoffMs: 120,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createWebSocket: (u) => new WebSocket(u) as unknown as any,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000, label = "waitFor"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`${label} timed out`);
    await sleep(10);
  }
}

function bump(store: OptimisticLocalStore, id: string, delta: number): void {
  for (const q of store.getAllQueries("options:list")) {
    if (q.value === undefined) continue;
    store.setQuery(
      "options:list",
      q.args,
      (q.value as OptionRow[]).map((o) => (o._id === id ? { ...o, votes: o.votes + delta } : o)),
    );
  }
}

describe("pulse E2E — optimistic votes render before the server answers; rollback is exact", () => {
  it("claim 1: under 500ms write latency, optimistic ON shows the vote pre-ack (and never flickers); OFF waits for the server", async () => {
    let client: StackbaseClient | undefined;
    let server: DevServer | undefined;
    try {
      const s = await startServer();
      server = s.server;

      const transport = delayTransport(`ws://127.0.0.1:${server.port}/api/sync`, nodeInner);
      client = new StackbaseClient(transport);

      const pollId = (await client.mutation("polls:create", { question: "Lunch?", options: ["Pizza", "Sushi"] })) as string;

      const seen: number[] = []; // Pizza's vote count, every push
      client.subscribe("options:list", { pollId }, (v) => {
        const pizza = (v as OptionRow[]).find((o) => o.label === "Pizza");
        if (pizza) seen.push(pizza.votes);
      });
      await waitFor(() => seen.length >= 1, 10_000, "baseline");
      const optionId = ((await client.query("options:list", { pollId })) as OptionRow[]).find((o) => o.label === "Pizza")!._id;

      transport.setDelay(500);

      /* ---- optimistic ON: the subscribed value reflects the vote BEFORE the promise resolves ---- */
      let resolved = false;
      const p = client
        .mutation("options:vote", { id: optionId }, { optimisticUpdate: (store, args) => bump(store, (args as { id: string }).id, 1) })
        .then((v) => {
          resolved = true;
          return v;
        });
      await waitFor(() => seen.includes(1), 2_000, "optimistic value visible");
      expect(resolved).toBe(false); // visible BEFORE the (delayed) server answered — the whole point
      await p;
      await waitFor(() => resolved, 5_000, "commit resolves");
      // No-flicker settle: once 1 appeared, the count never dropped back to 0.
      const afterOneAppeared = seen.slice(seen.indexOf(1));
      expect(afterOneAppeared.every((n) => n >= 1)).toBe(true);

      /* ---- optimistic OFF: nothing moves until the server answers ---- */
      const seenBefore = seen.length;
      const p2 = client.mutation("options:vote", { id: optionId });
      await sleep(250); // half the injected delay — the server hasn't even received the frame
      expect(seen.length).toBe(seenBefore); // no local movement without an updater
      await p2;
      await waitFor(() => seen.includes(2), 5_000, "server-confirmed value arrives");
    } finally {
      client?.close();
      await server?.close();
    }
  }, 60_000);

  it("claim 2: a vote into a closed poll rejects with POLL_CLOSED and rolls back to the exact pre-vote count", async () => {
    let client: StackbaseClient | undefined;
    let server: DevServer | undefined;
    try {
      const s = await startServer();
      server = s.server;

      const transport = delayTransport(`ws://127.0.0.1:${server.port}/api/sync`, nodeInner);
      client = new StackbaseClient(transport);

      const pollId = (await client.mutation("polls:create", { question: "Closed?", options: ["Yes"] })) as string;
      const optionId = ((await client.query("options:list", { pollId })) as OptionRow[])[0]!._id;
      await client.mutation("options:vote", { id: optionId }); // count = 1, the pre-vote truth
      await client.mutation("polls:setClosed", { id: pollId, closed: true });

      const seen: number[] = [];
      client.subscribe("options:list", { pollId }, (v) => {
        const row = (v as OptionRow[])[0];
        if (row) seen.push(row.votes);
      });
      await waitFor(() => seen.includes(1), 10_000, "baseline shows 1");

      transport.setDelay(500);
      const err = await client
        .mutation("options:vote", { id: optionId }, { optimisticUpdate: (store, args) => bump(store, (args as { id: string }).id, 1) })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe("POLL_CLOSED");

      // The optimistic 2 appeared, then rolled back EXACTLY to 1 — and stays there.
      await waitFor(() => seen.includes(2), 5_000, "optimistic bump was visible");
      await waitFor(() => seen[seen.length - 1] === 1, 5_000, "rolled back to the pre-vote count");
      await sleep(200);
      expect(seen[seen.length - 1]).toBe(1);
    } finally {
      client?.close();
      await server?.close();
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run it**

Run: `cd examples/optimistic-demo && bun run test -- optimistic-demo-e2e`
Expected: 2 tests PASS. If `client.query(...)` doesn't exist with that name on the raw client, check `packages/cli/test/outbox-fs-e2e.test.ts` (it calls `client2.query("notes:list", ...)`) — the name is right; adapt only if the signature differs. If `getAllQueries("options:list")` (string ref) misbehaves, use the same string-path form the updater registry uses — string paths are the documented fallback for untyped refs.

- [ ] **Step 3: Full example suite + typecheck**

Run: `cd examples/optimistic-demo && bun run test && bun run typecheck`
Expected: all tests pass (4 unit + 6 transport + 2 E2E = 12), typecheck clean.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/optimistic-demo/test/optimistic-demo-e2e.test.ts
git commit -m "test(examples): optimistic-demo E2E — pre-ack visibility and exact rollback through the real dev server"
```

---

### Task 5: README, repo-wide verification, live smoke

**Files:**
- Create: `examples/optimistic-demo/README.md`
- Verify: whole repo + a live `stackbase dev` smoke on port 3230.

- [ ] **Step 1: Write `README.md`**

```markdown
# Pulse — the Stackbase optimistic-updates demo

A live poll board that exists to make optimistic updates *visible*. Optimistic UI is invisible
when it works — so this demo gives you a latency slider and an optimistic ON/OFF switch, and lets
you feel the difference yourself.

## Run it

From the repo root (once): `bun install && bun run build`. Then:

```bash
cd examples/optimistic-demo
bun run web:build   # bundle the SPA (web/main.js is gitignored)
bun run dev         # stackbase dev on http://localhost:3230
```

Open <http://localhost:3230>. Create a poll first (question + comma-separated options).

## Flow 1 — feel it

Set latency to **3s** (the slider injects delay into outbound *writes only* — a demo-local
transport wrapper, `web/delay-transport.ts`; subscriptions stay instant). Turn **optimistic OFF**.
Vote. Three painful seconds of nothing, then the count moves. Now flip **optimistic ON** and vote:
instant. Rapid-fire the button — the **"+N in flight"** chip counts your stacked optimistic
layers while the number climbs immediately. That stack is real: each click is its own pending
mutation replayed over the last, and each settles exactly-once in order.

## Flow 2 — rollback, exactly

Close a poll (🔒), keep some latency on, and vote anyway. The count bumps instantly (your
optimistic guess), then snaps back **exactly** to the pre-vote value when the server rejects it
with `POLL_CLOSED` (toast). Nothing else moves — rollback is stop-replaying-the-layer, never an
inverse write. Reopen the poll and the same button works again.

## Flow 3 — the honest one

Turn **wrong-guess mode** ON. Each vote now renders +2 instantly, and settles to +1 — the
documented echo-snap: your updater is a *guess*; the authoritative result always wins the same
frame it lands. This is the deepest rule of the whole system, visible in one glance.

## Flow 4 — two tabs

Open a second tab and vote in one. The other updates live (reactive subscriptions) — and note it
never sees your optimistic guesses, only committed truth. Optimistic layers are local by design.

## What this demo deliberately is NOT

No outbox, no offline toggle, no `mintId` — that's [`examples/offline-demo`](../offline-demo)'s
story (durability). Pulse isolates the pure online optimistic layer: `withOptimisticUpdate`,
`placeholderId` (the dimmed "creating…" poll card), stacking, and exact rollback.

## What to read next

- `docs/enduser/optimistic-updates.md` — the API, purity rules, and the two documented residuals.
- `web/delay-transport.ts` — the latency injector: FIFO-safe, mutations-only, on the public
  transport seam.
```

- [ ] **Step 2: Repo-wide verification**

Run:
```bash
cd /Volumes/Projects/concave-dev
bun run build && bun run typecheck && bun run test
```
Expected: all green; turbo picks up `stackbase-example-optimistic-demo` (68 tasks where there were 66).

- [ ] **Step 3: Live smoke**

```bash
cd examples/optimistic-demo && bun run web:build && bun run dev &
sleep 3
curl -s http://localhost:3230/api/health
curl -s -X POST http://localhost:3230/api/run -H 'content-type: application/json' -d '{"path":"polls:create","args":{"question":"Smoke?","options":["Yes","No"]}}'
curl -s -X POST http://localhost:3230/api/run -H 'content-type: application/json' -d '{"path":"polls:list","args":{}}'
curl -s http://localhost:3230/ | head -5
```
Expected: health ok; create returns a poll id; list contains `"question":"Smoke?"`; page HTML contains `Pulse`. Kill the server afterwards (`lsof -ti :3230 | xargs kill`). The full browser hand-run of the README flows happens at the final-review gate (controller-driven — the offline-demo lesson: the star flow is unverified until driven in a real browser).

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/optimistic-demo/README.md
git commit -m "docs(examples): optimistic-demo README — the four Pulse flows"
```
