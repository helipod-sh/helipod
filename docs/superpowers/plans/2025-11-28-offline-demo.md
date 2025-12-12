# `examples/offline-demo` ("Packlist") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runnable example app under `examples/offline-demo` that makes the shipped durable offline sync story visible: the Receipted Outbox (queue → reload → drain → exactly-once), optimistic updates, the `mintId` create-then-reference chain, the pending-mutations tray, cross-tab live rendering, and a coded terminal-failure demo.

**Architecture:** Mirrors `examples/chat` file-for-file (convex functions + codegen, a React SPA in `web/` bundled by `bun build`, served by `stackbase dev --dir convex --web web`). Two unsharded tables (`lists`, `items`). One demo-local `web/offline-transport.ts` wraps the public `ClientTransport` interface to provide a localStorage-persisted "Go offline" toggle. No engine or client-package changes.

**Tech Stack:** TypeScript, Bun (package manager + bundler), React 18, vitest (runs under Node), `@stackbase/*` workspace packages consumed via their built `dist/`.

**Spec:** `docs/superpowers/specs/2025-11-28-offline-demo-design.md`

## Global Constraints

- Port **3220** (chat uses 3210; both must run side-by-side).
- Both tables **unsharded** (no `.shardKey()`): client-supplied `mintId` ids are v1-restricted to unsharded tables on the default ring.
- Every function declares `args` **and** `returns` validators (typed optimistic store via codegen).
- Cross-package imports resolve via **built `dist/`**, not `src/` — run `bun run build` at the repo root before running example tests, and rebuild after touching any `packages/*` dep (we touch none).
- Tests run under **Node** via vitest (`bun run test` executes vitest under Node; no Bun-only APIs in tests).
- `web/main.js` is **gitignored** (`examples/*/web/main.js`); never commit it. `convex/_generated/` **is committed** (the drift test depends on it).
- `ctx.db.query(table, index)` **requires an index name**; every table has the implicit `by_creation` index (creation order).
- There is **no `ctx.db.patch`** — read the doc with `ctx.db.get`, then `ctx.db.replace(id, fullValue)`.
- No `stackbase.config.ts` — the config file is optional (`load-config.ts` uses `existsSync`) and this project composes no components.
- Commit messages end with the Claude Code trailer used throughout this repo.

---

### Task 1: Backend — scaffold, schema, functions, tests, codegen

**Files:**
- Create: `examples/offline-demo/package.json`
- Create: `examples/offline-demo/tsconfig.json`
- Create: `examples/offline-demo/convex/schema.ts`
- Create: `examples/offline-demo/convex/lists.ts`
- Create: `examples/offline-demo/convex/items.ts`
- Create: `examples/offline-demo/scripts/codegen.ts`
- Create: `examples/offline-demo/convex/_generated/*` (via codegen — do not hand-write)
- Test: `examples/offline-demo/test/offline-demo.test.ts`

**Interfaces:**
- Consumes: `@stackbase/values` (`defineSchema`/`defineTable`/`v`), `@stackbase/errors` (`UserError`), `@stackbase/cli` (`push`, `loadProject`), `@stackbase/runtime-embedded`, `@stackbase/docstore-sqlite`.
- Produces (later tasks rely on): function paths `lists:list` `lists:create` `lists:lock` `items:list` `items:add` `items:toggle`; `convex/_generated/api` (`Api` type), `convex/_generated/dataModel` (`Doc`, `Id`), `convex/_generated/ids` (`mintId`); the error code string `"LIST_LOCKED"`; arg shapes `lists.create {_id?, name}`, `lists.lock {id}`, `items.add {_id?, listId, label}`, `items.toggle {id, done}`.

- [ ] **Step 1: Scaffold the package**

Create `examples/offline-demo/package.json`:

```json
{
  "name": "stackbase-example-offline-demo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "codegen": "bun run scripts/codegen.ts",
    "web:build": "bun build web/main.tsx --outfile web/main.js",
    "dev": "bun ../../packages/cli/dist/bin.js dev --dir convex --web web --port 3220"
  },
  "dependencies": {
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": {
    "@stackbase/cli": "workspace:*",
    "@stackbase/client": "workspace:*",
    "@stackbase/docstore-sqlite": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/query-engine": "workspace:*",
    "@stackbase/runtime-embedded": "workspace:*",
    "@types/node": "catalog:",
    "@types/react": "^18.3.18",
    "@types/react-dom": "^18.3.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

(Chat's manifest, minus `@stackbase/component`/`@stackbase/triggers` — no components here — plus `@stackbase/errors` for the coded error. `@stackbase/executor` stays: `_generated/server.ts` re-exports from it.)

Create `examples/offline-demo/tsconfig.json`:

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

Create `examples/offline-demo/scripts/codegen.ts`:

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
import * as lists from "../convex/lists";
import * as items from "../convex/items";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "../convex/_generated");

const { generated } = push({ schema, modules: { lists, items } });
mkdirSync(generatedDir, { recursive: true });
for (const file of generated.files) writeFileSync(join(generatedDir, file.path), file.content, "utf8");
process.stdout.write(`generated: ${generated.files.map((f) => f.path).join(", ")}\n`);
```

- [ ] **Step 2: Write the failing test**

Create `examples/offline-demo/test/offline-demo.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, push, type LoadedProject } from "@stackbase/cli";
import schema from "../convex/schema";
import * as lists from "../convex/lists";
import * as items from "../convex/items";
import { mintId } from "../convex/_generated/ids";

const loaded: LoadedProject = { schema, modules: { lists, items } };

let runtime: EmbeddedRuntime;
beforeEach(async () => {
  const project = loadProject(loaded);
  runtime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog,
    modules: project.moduleMap,
  });
});

describe("packlist — the mintId create-then-reference chain", () => {
  it("a client-minted list id inserts and a second mutation references it", async () => {
    const listId = mintId("lists");
    const created = await runtime.run<string>("lists:create", { _id: listId, name: "Beach trip" });
    expect(created.value).toBe(listId);

    await runtime.run("items:add", { listId, label: "Sunscreen" });
    const got = await runtime.run<Array<{ label: string; listId: string; done: boolean }>>("items:list", { listId });
    expect(got.value.map((i) => i.label)).toEqual(["Sunscreen"]);
    expect(got.value[0]!.listId).toBe(listId);
  });

  it("a caller that omits _id still gets an engine-minted id (nothing about plain inserts changes)", async () => {
    const created = await runtime.run<string>("lists:create", { name: "No minted id" });
    expect(typeof created.value).toBe("string");
    expect(created.value.length).toBeGreaterThan(0);
  });
});

describe("packlist — locked lists reject adds with a coded, terminal error", () => {
  it("items.add into a locked list rejects with code LIST_LOCKED", async () => {
    const created = await runtime.run<string>("lists:create", { name: "Locked" });
    const listId = created.value;
    await runtime.run("lists:lock", { id: listId });

    const err = await runtime.run("items:add", { listId, label: "Too late" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe("LIST_LOCKED");
  });

  it("toggle flips done and unlocked lists accept adds", async () => {
    const created = await runtime.run<string>("lists:create", { name: "Open" });
    const listId = created.value;
    const itemId = (await runtime.run<string>("items:add", { listId, label: "Towel" })).value;

    await runtime.run("items:toggle", { id: itemId, done: true });
    const got = await runtime.run<Array<{ done: boolean }>>("items:list", { listId });
    expect(got.value.map((i) => i.done)).toEqual([true]);
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

- [ ] **Step 3: Link the workspace and verify the test fails**

Run:
```bash
cd /Volumes/Projects/concave-dev && bun install
cd examples/offline-demo && bun run test
```
Expected: FAIL — `Cannot find module '../convex/schema'` (and/or `../convex/_generated/ids`). The failure proves the test actually exercises files that don't exist yet.

- [ ] **Step 4: Implement schema and functions**

Create `examples/offline-demo/convex/schema.ts`:

```ts
import { defineSchema, defineTable, v } from "@stackbase/values";

// Both tables are deliberately UNSHARDED (no .shardKey()): client-supplied `mintId` ids — the
// offline create-then-reference chain this example exists to demonstrate — are v1-restricted to
// unsharded tables on the default ring (docs/enduser/offline.md, "v1 restrictions").
export default defineSchema({
  lists: defineTable({
    name: v.string(),
    locked: v.boolean(),
  }),
  items: defineTable({
    listId: v.id("lists"),
    label: v.string(),
    done: v.boolean(),
  }).index("by_list", ["listId"]),
});
```

Create `examples/offline-demo/convex/lists.ts`:

```ts
import { v } from "@stackbase/values";
import { query, mutation } from "./_generated/server";

const listShape = v.object({
  _id: v.id("lists"),
  _creationTime: v.number(),
  name: v.string(),
  locked: v.boolean(),
});

export const list = query({
  args: {},
  returns: v.array(listShape),
  // Every table carries the implicit `by_creation` index (creation order) — there is no bare
  // full-table scan; an index name is always required.
  handler: (ctx) => ctx.db.query("lists", "by_creation").collect(),
});

export const create = mutation({
  // `_id` optional: when present it's a client-minted id (mintId, offline create-then-reference)
  // passed straight through to insert — the documented worked-example shape. Omitted → the engine
  // mints one, exactly as before client-supplied ids existed.
  args: { _id: v.optional(v.string()), name: v.string() },
  returns: v.id("lists"),
  handler: (ctx, args) => ctx.db.insert("lists", { ...args, locked: false }),
});

export const lock = mutation({
  args: { id: v.id("lists") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null; // already gone — locking nothing is a no-op, not an error
    await ctx.db.replace(id, { name: doc.name as string, locked: true });
    return null;
  },
});
```

Create `examples/offline-demo/convex/items.ts`:

```ts
import { v } from "@stackbase/values";
import { UserError } from "@stackbase/errors";
import { query, mutation } from "./_generated/server";

/** A typed, coded `UserError` subclass is what makes a queued offline `items.add` settle as a
 * TERMINAL failure on drain (pending tray, `error.code === "LIST_LOCKED"`, retry/dismiss) — a
 * plain `Error` carries no code on the wire, so the drain would treat it as an infrastructure
 * hiccup and retry it forever, by design. */
export class ListLockedError extends UserError {
  override readonly code = "LIST_LOCKED";
}

export const list = query({
  args: { listId: v.id("lists") },
  returns: v.array(
    v.object({
      _id: v.id("items"),
      _creationTime: v.number(),
      listId: v.id("lists"),
      label: v.string(),
      done: v.boolean(),
    }),
  ),
  handler: (ctx, args) => ctx.db.query("items", "by_list").eq("listId", args.listId).collect(),
});

export const add = mutation({
  args: { _id: v.optional(v.string()), listId: v.id("lists"), label: v.string() },
  returns: v.id("items"),
  handler: async (ctx, args) => {
    // The demo's conflict rule: the world can change while you're offline. A list locked after
    // you queued an add makes that add terminally invalid when it finally drains.
    const list = await ctx.db.get(args.listId);
    if (list !== null && (list.locked as boolean)) {
      throw new ListLockedError(`list "${String(list.name)}" is packed & locked — no more items`);
    }
    return ctx.db.insert("items", { ...args, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("items"), done: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { id, done }) => {
    const doc = await ctx.db.get(id);
    if (doc === null) return null;
    // No ctx.db.patch in this engine — read, then replace the full user-field value.
    await ctx.db.replace(id, { listId: doc.listId, label: doc.label as string, done });
    return null;
  },
});
```

- [ ] **Step 5: Run codegen**

Run:
```bash
cd examples/offline-demo && bun run codegen
```
Expected: `generated: api.d.ts, dataModel.d.ts, internal.d.ts, server.ts, ids.ts` (order/exact set may differ slightly — whatever `push` emits; the point is `convex/_generated/` now exists with `ids.ts` exporting `mintId` and `tableNumbers` containing `lists` and `items`).

- [ ] **Step 6: Run the tests — all pass**

Run:
```bash
cd examples/offline-demo && bun run test
```
Expected: PASS — 5 tests (2 mintId-chain, 2 locked/toggle, 1 codegen drift). If the `LIST_LOCKED` assertion fails because the embedded runtime wraps the thrown error, inspect the actual rejection shape with `console.log(err)` — the executor rethrows in-process so `.code` should survive; a wrapped shape means asserting on the wrapper's field carrying the code instead.

- [ ] **Step 7: Typecheck**

Run:
```bash
cd examples/offline-demo && bun run typecheck
```
Expected: clean exit (0 errors). Note: `test/` imports `_generated/ids` — this only typechecks after Step 5, which is why typecheck comes after codegen.

- [ ] **Step 8: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/offline-demo bun.lock
git commit -m "feat(examples): offline-demo backend — packlist schema, functions, LIST_LOCKED rule"
```

---

### Task 2: The offline toggle transport

**Files:**
- Create: `examples/offline-demo/web/offline-transport.ts`
- Test: `examples/offline-demo/test/offline-transport.test.ts`

**Interfaces:**
- Consumes: `ClientTransport` + `webSocketTransport` from `@stackbase/client` (Task 1 added the dep).
- Produces: `offlineToggleTransport(url, makeInner?, storage?)` returning `OfflineToggleTransport` — a `ClientTransport` plus `setOffline(offline: boolean): void`, `isOffline(): boolean`, `onStateChange(l: (offline: boolean) => void): () => void`. Task 3's `main.tsx` constructs the client with it and drives the header toggle/badge from it. Storage key: `"packlist:offline"` (`"1"` = offline).

Design notes baked into the code below (from reading `packages/client/src/transport.ts`):
- `ClientTransport.close()` is terminal, and `webSocketTransport` auto-reconnects — so "offline" must **close and discard** the inner transport (letting it live would have it happily reconnect).
- `webSocketTransport` buffers frames sent before its first socket opens, and its `hadFailedConnect` path fires `onReopen` on a first open after a failed attempt — so on go-online the wrapper can create a fresh inner and fire its own reopen listeners **immediately**: the client rebuilds the session (SetAuth replay, resubscribe, the outbox `Connect` handshake) and every frame is buffered until the socket opens.
- While offline, `send()` **drops** frames: the client's reopen sequence rebuilds everything from client state, so nothing is lost — this mirrors what the real transport does for a down period.
- The badge is two-state (offline flag only): `ClientTransport` deliberately has no "socket open" introspection, and adding one is not this example's job.

- [ ] **Step 1: Write the failing test**

Create `examples/offline-demo/test/offline-transport.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { ClientTransport } from "@stackbase/client";
import { offlineToggleTransport } from "../web/offline-transport";

type Sent = Parameters<ClientTransport["send"]>[0];

function fakeInnerFactory() {
  const instances: Array<{ sent: Sent[]; closed: boolean }> = [];
  const make = (_url: string): ClientTransport => {
    const inst = { sent: [] as Sent[], closed: false };
    instances.push(inst);
    return {
      send: (m) => inst.sent.push(m),
      onMessage: () => () => {},
      onClose: () => () => {},
      onReopen: () => () => {},
      close: () => {
        inst.closed = true;
      },
    };
  };
  return { make, instances };
}

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set("packlist:offline", initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: map,
  };
}

const MSG = { type: "Ping" } as unknown as Sent; // opaque to the wrapper — it never inspects frames

describe("offlineToggleTransport", () => {
  it("online at construction: creates an inner transport and forwards sends", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    expect(instances).toHaveLength(1);
    t.send(MSG);
    expect(instances[0]!.sent).toEqual([MSG]);
  });

  it("setOffline(true): closes the inner, fires close listeners once, drops sends, persists the flag", () => {
    const { make, instances } = fakeInnerFactory();
    const storage = fakeStorage();
    const t = offlineToggleTransport("ws://x/api/sync", make, storage);
    let closes = 0;
    t.onClose(() => closes++);

    t.setOffline(true);
    expect(instances[0]!.closed).toBe(true);
    expect(closes).toBe(1);
    expect(storage.dump.get("packlist:offline")).toBe("1");

    t.send(MSG);
    expect(instances[0]!.sent).toEqual([]); // dropped, not delivered to the dead inner

    t.setOffline(true); // idempotent — no second close event
    expect(closes).toBe(1);
  });

  it("setOffline(false): creates a FRESH inner, fires reopen, forwards sends to the new inner", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    let reopens = 0;
    t.onReopen!(() => reopens++);

    t.setOffline(true);
    t.setOffline(false);
    expect(instances).toHaveLength(2);
    expect(reopens).toBe(1);

    t.send(MSG);
    expect(instances[1]!.sent).toEqual([MSG]);
    expect(instances[0]!.sent).toEqual([]);
  });

  it("a persisted offline flag starts the transport offline (reload-while-offline stays offline)", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage("1"));
    expect(t.isOffline()).toBe(true);
    expect(instances).toHaveLength(0); // no socket ever attempted

    let reopens = 0;
    t.onReopen!(() => reopens++);
    t.setOffline(false);
    expect(instances).toHaveLength(1);
    expect(reopens).toBe(1); // the client rebuilds the session on first go-online
  });

  it("onStateChange fires on every flip with the new value", () => {
    const { make } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    const seen: boolean[] = [];
    t.onStateChange((o) => seen.push(o));
    t.setOffline(true);
    t.setOffline(false);
    expect(seen).toEqual([true, false]);
  });

  it("close() is terminal: drops the inner and ignores later setOffline calls", () => {
    const { make, instances } = fakeInnerFactory();
    const t = offlineToggleTransport("ws://x/api/sync", make, fakeStorage());
    t.close();
    expect(instances[0]!.closed).toBe(true);
    t.setOffline(false);
    expect(instances).toHaveLength(1); // no resurrection
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run:
```bash
cd examples/offline-demo && bun run test -- offline-transport
```
Expected: FAIL — `Cannot find module '../web/offline-transport'`.

- [ ] **Step 3: Implement the wrapper**

Create `examples/offline-demo/web/offline-transport.ts`:

```ts
/**
 * A demo-local "go offline" switch, built entirely on the PUBLIC `ClientTransport` seam — no
 * client-package changes. Offline = close and discard the inner `webSocketTransport` (its
 * `close()` is terminal and it would otherwise auto-reconnect); online = construct a fresh inner
 * and fire `onReopen`, so the client runs its normal reconnect sequence (SetAuth replay,
 * resubscribe every live query, the outbox `Connect` handshake → FIFO drain). Frames sent while
 * offline are dropped — the reopen sequence rebuilds the whole session from client state, which
 * is exactly how the real transport treats a down period.
 *
 * The flag persists in localStorage so a reload while "offline" STAYS offline — that is what
 * makes the durable outbox's reload-survival visible without a Service Worker.
 */
import { webSocketTransport, type ClientTransport } from "@stackbase/client";

type OutboundMessage = Parameters<ClientTransport["send"]>[0];
type InboundListener = Parameters<ClientTransport["onMessage"]>[0];

export interface OfflineToggleTransport extends ClientTransport {
  setOffline(offline: boolean): void;
  isOffline(): boolean;
  /** Fires with the new flag on every flip — drives the header toggle/badge. */
  onStateChange(listener: (offline: boolean) => void): () => void;
}

const STORAGE_KEY = "packlist:offline";

type FlagStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export function offlineToggleTransport(
  url: string,
  makeInner: (url: string) => ClientTransport = webSocketTransport,
  storage: FlagStorage | undefined = typeof localStorage === "undefined" ? undefined : localStorage,
): OfflineToggleTransport {
  // Stable listener sets: the client subscribes ONCE (to the wrapper); inner transports come and go.
  const messageListeners = new Set<InboundListener>();
  const closeListeners = new Set<() => void>();
  const reopenListeners = new Set<() => void>();
  const stateListeners = new Set<(offline: boolean) => void>();

  let offline = storage?.getItem(STORAGE_KEY) === "1";
  let terminated = false;
  let inner: ClientTransport | undefined;
  let unwire: Array<() => void> = [];

  function connectInner(): void {
    const t = makeInner(url);
    inner = t;
    unwire = [
      t.onMessage((msg) => {
        for (const l of messageListeners) l(msg);
      }),
      t.onClose(() => {
        for (const l of closeListeners) l();
      }),
      // The inner reconnects BY ITSELF during an online period (real network blips) — forward those.
      t.onReopen?.(() => {
        for (const l of reopenListeners) l();
      }) ?? (() => {}),
    ];
  }

  function dropInner(): void {
    // Unwire FIRST: the inner's own (possibly async) close event must not double-fire the
    // listeners — `setOffline(true)` fires them synchronously itself, exactly once.
    for (const u of unwire) u();
    unwire = [];
    const t = inner;
    inner = undefined;
    t?.close();
  }

  if (!offline) connectInner();

  return {
    send(message: OutboundMessage): void {
      if (!terminated && !offline) inner?.send(message);
    },
    onMessage(listener) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onReopen(listener) {
      reopenListeners.add(listener);
      return () => reopenListeners.delete(listener);
    },
    close(): void {
      if (terminated) return;
      terminated = true;
      dropInner();
      for (const l of closeListeners) l();
    },
    setOffline(next: boolean): void {
      if (terminated || offline === next) return;
      offline = next;
      storage?.setItem(STORAGE_KEY, next ? "1" : "0");
      if (next) {
        dropInner();
        for (const l of closeListeners) l(); // the client runs its close disposition NOW
      } else {
        connectInner();
        // The fresh socket hasn't opened yet, but webSocketTransport buffers pre-first-open
        // frames — firing reopen immediately lets the client rebuild the session and every
        // frame is delivered the moment the socket opens.
        for (const l of reopenListeners) l();
      }
      for (const l of stateListeners) l(offline);
    },
    isOffline(): boolean {
      return offline;
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  };
}
```

- [ ] **Step 4: Run the tests — pass; typecheck**

Run:
```bash
cd examples/offline-demo && bun run test -- offline-transport && bun run typecheck
```
Expected: 6 tests PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/offline-demo/web/offline-transport.ts examples/offline-demo/test/offline-transport.test.ts
git commit -m "feat(examples): offline-demo toggle transport — persisted go-offline over the public ClientTransport seam"
```

---

### Task 3: The web app

**Files:**
- Create: `examples/offline-demo/web/index.html`
- Create: `examples/offline-demo/web/main.tsx`
- Produces (not committed): `examples/offline-demo/web/main.js` via `bun run web:build` (gitignored)

**Interfaces:**
- Consumes: `offlineToggleTransport` (Task 2); function paths + arg shapes + `Api`/`Doc`/`Id`/`mintId` (Task 1); `@stackbase/client` (`StackbaseClient`, `anyApi`, `indexedDBOutbox`, `OptimisticLocalStore`, `OptimisticUpdateFn`, `MutationFailedInfo`) and `@stackbase/client/react` (`StackbaseProvider`, `useQuery`, `useMutation`, `usePendingMutations`).
- Produces: the served demo page (Task 4's README documents its flows).

Key rules the code below follows:
- The `optimisticUpdates` registry keys are **udfPath strings** (`"lists:create"` — module + `:` + export, the same format `runtime.run` uses).
- The registry entries are the **same module-scoped updater functions** the `withOptimisticUpdate` call sites use — registered once at client construction so entries queued before a reload render after it.
- Updaters are pure: minted ids are read **from args** (never `mintId()` inside an updater), timestamps come from `store.now()`, and every updater tolerates an `undefined` query baseline (offline-after-reload renders nothing until a real baseline exists — the documented boundary).
- Optimistic rows carry `pending: true` via the documented type-widening recipe (chat's pattern) so in-flight rows render dimmed and settle un-dimmed with no flicker.
- Mutation promises resolve at commit — a queued-offline call's promise stays pending until drain, and a terminal failure rejects it; every fire-and-forget call site attaches `.catch(() => {})` because the tray + `onMutationFailed` are the failure surface, not the promise.

- [ ] **Step 1: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Packlist — Stackbase offline demo</title>
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
      .app { width: 100%; max-width: 860px; height: 100dvh; display: flex; flex-direction: column; padding: 1rem; gap: 0.75rem; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
      h1 { font-size: 1.25rem; margin: 0; }
      .toggle { padding: 0.45rem 0.9rem; border: 1px solid #2a2f3d; border-radius: 999px; font: inherit; cursor: pointer; color: inherit; }
      .toggle.on { background: #10321c; border-color: #1f6f3d; }
      .toggle.off { background: #3a1620; border-color: #7f2d3f; }
      main { display: flex; gap: 0.75rem; flex: 1; min-height: 0; }
      .pane { background: #14161d; border: 1px solid #232734; border-radius: 12px; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; }
      .lists { width: 40%; }
      .items { flex: 1; }
      h2 { font-size: 0.95rem; margin: 0; color: #9aa0ad; }
      ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
      .row { display: flex; align-items: center; gap: 0.5rem; padding: 0.4rem 0.6rem; background: #1c2030; border-radius: 8px; cursor: pointer; }
      .row.selected { outline: 2px solid #2563eb; }
      .row.pending { opacity: 0.55; } /* optimistic row, not yet confirmed by the server */
      .row .grow { flex: 1; }
      .row .locked { font-size: 0.8rem; }
      .row button { padding: 0.15rem 0.5rem; font-size: 0.78rem; }
      .status { color: #6b6f7a; font-style: italic; padding: 0.4rem; }
      form { display: flex; gap: 0.5rem; }
      input[type="text"] { flex: 1; padding: 0.5rem 0.7rem; border-radius: 8px; border: 1px solid #2a2f3d; background: #0f1117; color: inherit; font: inherit; }
      button { padding: 0.5rem 0.9rem; border: 0; border-radius: 8px; background: #2563eb; color: white; font: inherit; cursor: pointer; }
      button:hover { background: #1d4ed8; }
      button.subtle { background: #232734; }
      .tray { background: #14161d; border: 1px solid #232734; border-radius: 12px; padding: 0.6rem 0.75rem; }
      .tray h2 { margin-bottom: 0.4rem; }
      .tray li { display: flex; align-items: center; gap: 0.6rem; padding: 0.3rem 0.5rem; background: #1c2030; border-radius: 8px; font-size: 0.85rem; }
      .tray .st { color: #9aa0ad; }
      .tray .err { color: #ff8a9a; font-weight: 600; }
      footer { color: #6b6f7a; font-size: 0.78rem; text-align: center; }
      del { color: #6b6f7a; }
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
import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  StackbaseClient,
  anyApi,
  indexedDBOutbox,
  type MutationFailedInfo,
  type OptimisticLocalStore,
  type OptimisticUpdateFn,
} from "@stackbase/client";
import { StackbaseProvider, useQuery, useMutation, usePendingMutations } from "@stackbase/client/react";
import { offlineToggleTransport } from "./offline-transport";
// Type-only imports — erased at bundle time, so the server-side `_generated/server.ts` re-exports
// never reach the browser bundle. `ids.ts` is a VALUE import (mintId runs in the browser); it pulls
// only `@stackbase/id-codec`, which is browser-safe.
import type { Api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { mintId } from "../convex/_generated/ids";

const api = anyApi as Api;

const wsProtocol = location.protocol === "https:" ? "wss" : "ws";
export const transport = offlineToggleTransport(`${wsProtocol}://${location.host}/api/sync`);

/* ------------------------------------------------------------------------------------------------
 * Optimistic updaters — module-scoped, PURE (replay-safe): minted ids come FROM args (never
 * mintId() in here), timestamps from store.now(), and an `undefined` baseline means "not
 * subscribed / no base yet" → render nothing rather than throw (the documented
 * offline-after-reload boundary). The SAME functions serve both the `withOptimisticUpdate` call
 * sites and the client-construction `optimisticUpdates` registry, so entries queued before a
 * reload — and other tabs' queued entries — render through identical logic.
 * ---------------------------------------------------------------------------------------------- */

// The documented pending-row type-widening recipe (docs/enduser/optimistic-updates.md): an
// optimistic row is a real Doc shape plus `pending: true`, dropped the same frame the
// authoritative row lands (drop-on-observed-inclusion — never a flicker).
type PendingList = Doc<"lists"> | (Doc<"lists"> & { pending: true });
type PendingItem = Doc<"items"> | (Doc<"items"> & { pending: true });

function createListOptimistic(store: OptimisticLocalStore, args: { _id?: string; name: string }): void {
  const listsQ = store.getQuery(api.lists.list, {});
  if (listsQ === undefined) return;
  const row: PendingList = {
    _id: (args._id ?? store.placeholderId("lists")) as Id<"lists">,
    _creationTime: store.now(),
    name: args.name,
    locked: false,
    pending: true,
  };
  store.setQuery(api.lists.list, {}, [...(listsQ as PendingList[]), row]);
}

function lockListOptimistic(store: OptimisticLocalStore, args: { id: Id<"lists"> }): void {
  const listsQ = store.getQuery(api.lists.list, {});
  if (listsQ === undefined) return;
  store.setQuery(
    api.lists.list,
    {},
    (listsQ as PendingList[]).map((l) => (l._id === args.id ? { ...l, locked: true } : l)),
  );
}

function addItemOptimistic(store: OptimisticLocalStore, args: { _id?: string; listId: Id<"lists">; label: string }): void {
  const itemsQ = store.getQuery(api.items.list, { listId: args.listId });
  if (itemsQ === undefined) return;
  const row: PendingItem = {
    _id: (args._id ?? store.placeholderId("items")) as Id<"items">,
    _creationTime: store.now(),
    listId: args.listId,
    label: args.label,
    done: false,
    pending: true,
  };
  store.setQuery(api.items.list, { listId: args.listId }, [...(itemsQ as PendingItem[]), row]);
}

function toggleItemOptimistic(store: OptimisticLocalStore, args: { id: Id<"items">; done: boolean }): void {
  for (const q of store.getAllQueries(api.items.list)) {
    if (q.value === undefined) continue;
    store.setQuery(
      api.items.list,
      q.args,
      (q.value as PendingItem[]).map((i) => (i._id === args.id ? { ...i, done: args.done } : i)),
    );
  }
}

/* ------------------------------------------------------------------------------------------------
 * The client — the durable outbox plus the hydrate-time registry (udfPath → updater). The registry
 * is what re-renders queued entries after a reload and mirrors other tabs' queued entries live.
 * ---------------------------------------------------------------------------------------------- */

const client = new StackbaseClient(transport, {
  outbox: indexedDBOutbox(),
  optimisticUpdates: {
    "lists:create": createListOptimistic as OptimisticUpdateFn,
    "lists:lock": lockListOptimistic as OptimisticUpdateFn,
    "items:add": addItemOptimistic as OptimisticUpdateFn,
    "items:toggle": toggleItemOptimistic as OptimisticUpdateFn,
  },
  onMutationFailed: (info: MutationFailedInfo) => {
    // The pending tray is the primary surface; this keeps a breadcrumb in the console too.
    console.error(`[packlist] ${info.udfPath} failed terminally: ${info.error.code ?? info.error.message}`);
  },
});

/* ---------------------------------------- components ------------------------------------------ */

function OfflineToggle() {
  const [offline, setOffline] = useState(transport.isOffline());
  useEffect(() => transport.onStateChange(setOffline), []);
  return (
    <button className={offline ? "toggle off" : "toggle on"} onClick={() => transport.setOffline(!offline)}>
      {offline ? "📴 Offline — tap to reconnect" : "🟢 Online — tap to go offline"}
    </button>
  );
}

function Lists(props: { selected: Id<"lists"> | null; onSelect: (id: Id<"lists">) => void }) {
  const lists = useQuery(api.lists.list, {}) as PendingList[] | undefined;
  const create = useMutation(api.lists.create).withOptimisticUpdate(createListOptimistic);
  const lock = useMutation(api.lists.lock).withOptimisticUpdate(lockListOptimistic);
  const [name, setName] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    // The create-then-reference chain starts here: a REAL Id<"lists">, minted client-side at
    // args-construction time. Selecting it immediately means items can be added to this list
    // while its create is still queued offline — no await needed.
    const id = mintId("lists");
    void create({ _id: id, name: trimmed }).catch(() => {});
    props.onSelect(id);
    setName("");
  }

  return (
    <section className="pane lists">
      <h2>Lists</h2>
      <ul>
        {lists === undefined && <li className="status">waiting for first sync…</li>}
        {lists?.length === 0 && <li className="status">No lists yet — create one 👇</li>}
        {lists?.map((l) => (
          <li
            key={l._id}
            className={`row${l._id === props.selected ? " selected" : ""}${"pending" in l ? " pending" : ""}`}
            onClick={() => props.onSelect(l._id)}
          >
            <span className="grow">{l.name}</span>
            {l.locked ? (
              <span className="locked" title="locked — adds will be rejected">🔒</span>
            ) : (
              <button
                className="subtle"
                onClick={(e) => {
                  e.stopPropagation();
                  void lock({ id: l._id }).catch(() => {});
                }}
              >
                lock
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="New list…" />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

function Items(props: { listId: Id<"lists"> }) {
  const items = useQuery(api.items.list, { listId: props.listId }) as PendingItem[] | undefined;
  const add = useMutation(api.items.add).withOptimisticUpdate(addItemOptimistic);
  const toggle = useMutation(api.items.toggle).withOptimisticUpdate(toggleItemOptimistic);
  const [label, setLabel] = useState("");

  function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = label.trim();
    if (!trimmed) return;
    void add({ _id: mintId("items"), listId: props.listId, label: trimmed }).catch(() => {});
    setLabel("");
  }

  return (
    <section className="pane items">
      <h2>Items</h2>
      <ul>
        {items === undefined && <li className="status">waiting for first sync…</li>}
        {items?.length === 0 && <li className="status">Nothing packed yet.</li>}
        {items?.map((i) => (
          <li key={i._id} className={`row${"pending" in i ? " pending" : ""}`}>
            <input
              type="checkbox"
              checked={i.done}
              onChange={() => void toggle({ id: i._id, done: !i.done }).catch(() => {})}
            />
            <span className="grow">{i.done ? <del>{i.label}</del> : i.label}</span>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add item…" />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}

function PendingTray() {
  const pending = usePendingMutations();
  if (pending.length === 0) return null;
  return (
    <section className="tray">
      <h2>
        Outbox — {pending.length} pending {transport.isOffline() ? "(offline: will drain on reconnect)" : ""}
      </h2>
      <ul>
        {pending.map((e) => (
          <li key={`${e.clientId}:${e.seq}`}>
            <code>{e.udfPath}</code>
            <span className="st">{e.status}</span>
            {e.error && <span className="err">{e.error.code ?? "error"}</span>}
            {e.status === "failed" && (
              <>
                <button className="subtle" onClick={() => void e.retry()}>
                  retry
                </button>
                <button className="subtle" onClick={() => void e.dismiss()}>
                  dismiss
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function App() {
  const [selected, setSelected] = useState<Id<"lists"> | null>(null);
  return (
    <div className="app">
      <header>
        <h1>🎒 Packlist</h1>
        <OfflineToggle />
      </header>
      <main>
        <Lists selected={selected} onSelect={setSelected} />
        {selected ? <Items listId={selected} /> : <section className="pane items"><p className="status">Select a list.</p></section>}
      </main>
      <PendingTray />
      <footer>
        Go offline → create a list and add items into it → reload → go online: everything drains exactly-once.
        Lock a list, queue adds to it offline, reconnect: watch them fail loudly (LIST_LOCKED). Open two tabs for cross-tab live rendering.
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

- [ ] **Step 3: Build the bundle**

Run:
```bash
cd examples/offline-demo && bun run web:build
```
Expected: `web/main.js` written, no errors. If the bundle errors on a server-only import chain, check that only `type` imports reference `_generated/api`/`dataModel` — `ids.ts` is the single intentional value import from `_generated/`.

- [ ] **Step 4: Typecheck**

Run:
```bash
cd examples/offline-demo && bun run typecheck
```
Expected: clean. (`useQuery`/`withOptimisticUpdate` casts follow chat's exact pattern — the widened `Pending*` types are the documented recipe, not a hack.)

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/offline-demo/web/index.html examples/offline-demo/web/main.tsx
git commit -m "feat(examples): offline-demo web app — packlist UI, outbox registry, pending tray, offline toggle"
```

---

### Task 4: README, repo-wide verification, live smoke

**Files:**
- Create: `examples/offline-demo/README.md`
- Verify: whole repo (`bun run build`, `bun run typecheck`, `bun run test`), plus a live `stackbase dev` smoke on port 3220.

**Interfaces:**
- Consumes: everything above; `POST /api/run` takes `{"path": "lists:create", "args": {...}}` and returns `{"value": ..., "committed": ...}`; `GET /api/health` returns `{"status": "ok", ...}`.
- Produces: the user-facing walkthrough; a verified, mergeable example.

- [ ] **Step 1: Write `README.md`**

```markdown
# Packlist — the Stackbase offline demo

A packing-list app that exists to make the durable offline sync story visible: the durable
outbox (queue → reload → drain → exactly-once), optimistic updates, client-minted ids
(create-then-reference with no awaits), the pending tray, cross-tab live rendering, and what a
conflict honestly looks like when the world changed while you were away.

## Run it

From the repo root (once): `bun install && bun run build`. Then:

```bash
cd examples/offline-demo
bun run web:build   # bundle the SPA (web/main.js is gitignored)
bun run dev         # stackbase dev on http://localhost:3220
```

Open <http://localhost:3220>.

## Flow 1 — the star: offline → reload → drain, exactly-once

1. Flip **Go offline** (top right). The switch is a demo-local wrapper around the public
   `ClientTransport` seam (`web/offline-transport.ts`) and persists in localStorage — so a reload
   while offline STAYS offline.
2. Create a list, then add a few items into it. Both render instantly (optimistic), dimmed while
   unconfirmed, and the **Outbox tray** at the bottom counts the queued mutations. The list's id
   was minted client-side (`mintId("lists")`) so the item adds could reference it with no await —
   the create-then-reference chain, fully offline.
3. **Reload the page.** Still offline. The queued mutations are still in the tray (they live in
   IndexedDB), and the optimistic rows re-render on top of the last-known query baselines via the
   `optimisticUpdates` registry. Honest boundary: a query with NO baseline yet (e.g. a list pane
   you never opened) renders "waiting for first sync…" until reconnect — there is deliberately no
   persisted query cache.
4. Flip **online**. Watch the tray drain FIFO and empty, and every dimmed row settle authoritative
   — the same frame, no flicker, exactly-once (server receipts, not client hope).

## Flow 2 — two tabs

Open the app in a second tab. Everything renders live in both (reactive subscriptions), including
the other tab's still-queued offline writes (cross-tab optimistic rendering over BroadcastChannel).

## Flow 3 — the conflict, honestly

1. Create a list, keep it selected, and **lock** it (🔒 sets `locked: true` server-side).
2. Go offline and add items into it anyway. They queue and render dimmed — the client deliberately
   does NOT re-implement server rules; the handler is the single source of truth.
3. Reconnect. The adds drain, the server runs `items.add` against live state, and it throws
   `ListLockedError` — a typed, coded `UserError` subclass (`code: "LIST_LOCKED"`). Coded = the
   drain records it as a TERMINAL verdict (a plain `Error` would look like an infra hiccup and be
   retried). The tray shows the failed entry with **retry** / **dismiss**.

This is the whole conflict model: no merge, no CRDT — your mutation handler is the single source
of truth, and a queued write re-runs it against live state on drain.

## Flow 4 — prove it's real (optional)

Kill the dev server (Ctrl+C) instead of using the toggle: sends park, the tray holds. Restart it:
the client reconnects (backoff + jitter), resubscribes, and drains. (Reload-while-offline can't be
shown this way — the page itself needs the server — which is why the toggle exists.)

## What to read next

- `docs/enduser/offline.md` — the full model, conflict taxonomy, and honest boundaries.
- `docs/enduser/optimistic-updates.md` — updater purity rules and the pending-row recipe.
- `web/offline-transport.ts` — the toggle: ~100 commented lines on the public transport seam.
```

- [ ] **Step 2: Repo-wide verification**

Run:
```bash
cd /Volumes/Projects/concave-dev
bun run build && bun run typecheck && bun run test
```
Expected: all green — turbo picks up `stackbase-example-offline-demo` automatically (`examples/*` is a workspace glob). If turbo skips the new package, check the package.json `name` is unique and re-run `bun install`.

- [ ] **Step 3: Live smoke through the real dev server**

Run (background the server):
```bash
cd examples/offline-demo && bun run web:build && bun run dev &
sleep 3
curl -s http://localhost:3220/api/health
curl -s -X POST http://localhost:3220/api/run -H 'content-type: application/json' -d '{"path":"lists:create","args":{"name":"Smoke"}}'
curl -s -X POST http://localhost:3220/api/run -H 'content-type: application/json' -d '{"path":"lists:list","args":{}}'
curl -s http://localhost:3220/ | head -5
```
Expected: health `{"status":"ok",...}`; create returns `{"value":"<an id>","committed":...}`; list returns a value containing `"name":"Smoke"`; the page HTML contains `Packlist`. Then kill the dev server. Optionally open <http://localhost:3220> in a browser and run Flow 1 by hand — this is the "so that I can see it" acceptance check.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add examples/offline-demo/README.md
git commit -m "docs(examples): offline-demo README — the four demo flows"
```
