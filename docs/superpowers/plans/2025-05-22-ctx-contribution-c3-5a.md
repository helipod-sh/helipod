# C3.5a — Engine Mechanism: ctx-Contribution + Ambient Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a component contribute a read-only facade to `ctx` (e.g. `ctx.auth.getUserId()`) that runs in **its own** namespace, reads the **ambient request identity**, and shares the **caller's transaction** — so a protected query's read-set includes the component's tables and re-runs when they change (cross-namespace reactivity).

**Architecture:** Add `identity` to the executor's `KernelContext`/`RunOptions`. Inside `run()` (where the txn lives), for each enabled `ContextProvider`, build a read-only `GuestDatabaseReader` over a second `KernelContext` at the provider's namespace **sharing the same `txn`/`catalog`/`queryRuntime`/`snapshotTs`**, call the provider's `build({ db, identity })`, and attach the frozen result as `ctx[name]`. `composeComponents` derives the providers from components that declare `context`. The runtime threads identity + providers. Auth gets a minimal `context` builder.

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/executor` (the hook + identity), `@stackbase/component` (`ComponentDefinition.context` + `composeComponents`), `@stackbase/runtime-embedded` (threading), `@stackbase/auth` (the `context` builder).

## Global Constraints

- The facade is **read-only** (a `GuestDatabaseReader` — no insert/replace/delete) and scoped to the providing component's namespace. It shares the caller's `txn`, so its reads are recorded in the caller's read-set (reactivity) — this is the ONLY new cross-namespace path.
- The raw identity token reaches the facade via `ComponentContext.identity`; app code never receives the raw token, only the resolved result.
- **Internal seam, deliberate:** a duplicate/reserved context key (`db`, `random`, or a name already attached) **throws**; the facade object is **frozen**. The public `defineComponent({ context })` API stays usable but its *contract* (ordering/lifecycle) is deferred — not this slice's concern.
- App preserved: with no `contextProviders`, `ctx` is exactly `{ db, random }` as today.
- **Deferred to C3.5c:** threading identity through the WebSocket sync path (subscribe-with-auth). This slice proves reactivity via the **read-set assertion** (the facade's read lands in the caller's `readRanges`); the existing invalidation engine (already tested) does the rest.
- Strict TS; ESM. `@stackbase/component` already depends on `@stackbase/executor` (no cycle); `@stackbase/auth` imports the `ComponentContext` **type** from `@stackbase/executor`.

---

### Task 1: The executor context-provider hook + identity

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`KernelContext.identity`)
- Modify: `packages/executor/src/executor.ts` (`RunOptions` + `ComponentContext`/`ContextProvider` types + build providers in `run()`)
- Modify: `packages/executor/src/index.ts` (export the new types + ensure `GuestDatabaseReader` is exported)
- Test: `packages/executor/test/context-provider.test.ts`

**Interfaces:**
- Produces: `KernelContext.identity: string | null`; `RunOptions.identity?: string | null` and `RunOptions.contextProviders?: ReadonlyArray<ContextProvider>`; `ComponentContext { db: GuestDatabaseReader; identity: string | null }`; `ContextProvider { name: string; namespace: string; build: (cctx: ComponentContext) => Record<string, unknown> }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/context-provider.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query, type ContextProvider } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("auth/sessions", 10002);
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "by_creation", fields: [], indexId: encodeStorageIndexId(10002, "by_creation") });
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "byToken", fields: ["token"], indexId: encodeStorageIndexId(10002, "byToken") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

// a provider that resolves the ambient identity to a session's userId, reading its own namespace
const authProvider: ContextProvider = {
  name: "auth",
  namespace: "auth",
  build: (cctx) => ({
    whoami: async (): Promise<string | null> => {
      if (!cctx.identity) return null;
      const [s] = await cctx.db.query("sessions", "byToken").eq("token", cctx.identity).collect();
      return s ? (s.userId as string) : null;
    },
  }),
};

describe("ctx-contribution hook", () => {
  it("a facade resolves the ambient identity in its own namespace", async () => {
    const executor = await harness();
    // seed a session (namespace auth)
    await executor.run(mutation(async (ctx) => ctx.db.insert("sessions", { userId: "u1", token: "tok" })), {}, { namespace: "auth" });
    // an app query that ONLY uses ctx.auth.whoami() — no ctx.db of its own
    const me = query(async (ctx) => (ctx as { auth: { whoami(): Promise<string | null> } }).auth.whoami());
    const ok = await executor.run<string | null>(me, {}, { contextProviders: [authProvider], identity: "tok" });
    expect(ok.value).toBe("u1");
    const bad = await executor.run<string | null>(me, {}, { contextProviders: [authProvider], identity: "nope" });
    expect(bad.value).toBeNull();
  });

  it("records the facade's read in the CALLER's read-set (reactivity)", async () => {
    const executor = await harness();
    await executor.run(mutation(async (ctx) => ctx.db.insert("sessions", { userId: "u1", token: "tok" })), {}, { namespace: "auth" });
    const me = query(async (ctx) => (ctx as { auth: { whoami(): Promise<string | null> } }).auth.whoami());
    const r = await executor.run(me, {}, { contextProviders: [authProvider], identity: "tok" });
    // the query touched NO table of its own; any recorded read proves the facade's read landed in the caller's read-set
    expect(r.readRanges.length).toBeGreaterThan(0);
  });

  it("throws on a context key that collides with a reserved ctx key", async () => {
    const executor = await harness();
    const bad: ContextProvider = { name: "db", namespace: "auth", build: () => ({}) };
    await expect(executor.run(query(async () => 1), {}, { contextProviders: [bad] })).rejects.toThrow(/collide|reserved/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/executor test context-provider` → FAIL (`ContextProvider` not exported / `ctx.auth` undefined).

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/kernel.ts`, add to `KernelContext`:
```ts
  readonly identity: string | null;
```

In `packages/executor/src/executor.ts`:
```ts
// add types (near RunOptions)
export interface ComponentContext {
  readonly db: GuestDatabaseReader;
  readonly identity: string | null;
}
export interface ContextProvider {
  readonly name: string;
  /** The component's namespace; the facade's db reads here. */
  readonly namespace: string;
  readonly build: (cctx: ComponentContext) => Record<string, unknown>;
}

// RunOptions gains:
  /** Ambient session token for this request, exposed to context facades. */
  identity?: string | null;
  /** Enabled components' context facades, attached as ctx[name]. */
  contextProviders?: ReadonlyArray<ContextProvider>;
```

In `run()`: add `identity: options.identity ?? null,` to the `kctx` literal. Then replace the `guestCtx` construction (currently `const guestCtx = { db, random: () => kctx.random.next() };`) with:
```ts
        const guestCtx: Record<string, unknown> = { db, random: () => kctx.random.next() };
        for (const p of options.contextProviders ?? []) {
          if (p.name in guestCtx) throw new Error(`context provider "${p.name}" collides with a reserved ctx key`);
          const pctx: KernelContext = { ...kctx, namespace: p.namespace, privileged: false };
          const preader = new GuestDatabaseReader(new InlineSyscallChannel(this.router, pctx));
          guestCtx[p.name] = Object.freeze(p.build({ db: preader, identity: kctx.identity }));
        }
```
(`GuestDatabaseReader` and `InlineSyscallChannel` are already imported in executor.ts.)

In `packages/executor/src/index.ts`: export `ComponentContext` and `ContextProvider` (from `./executor`), and confirm `GuestDatabaseReader` is exported (add `export { GuestDatabaseReader, GuestDatabaseWriter } from "./guest";` if missing).

- [ ] **Step 4: Run test to verify it passes** — `pnpm --filter @stackbase/executor test context-provider` → PASS (3). `pnpm --filter @stackbase/executor test` → all existing pass (no `contextProviders` → `ctx` unchanged; `identity` defaults null). `pnpm --filter @stackbase/executor exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src packages/executor/test/context-provider.test.ts
git commit -m "feat(executor): ctx-contribution hook + ambient identity (read-only facades over shared txn)"
```

---

### Task 2: `ComponentDefinition.context` + `composeComponents` providers

**Files:**
- Modify: `packages/component/src/define-component.ts` (`ComponentDefinition.context`)
- Modify: `packages/component/src/compose.ts` (`composeComponents` returns `contextProviders`)
- Test: `packages/component/test/context-providers.test.ts`

**Interfaces:**
- Consumes: `ComponentContext`, `ContextProvider` (`@stackbase/executor`).
- Produces: `ComponentDefinition.context?: (cctx: ComponentContext) => Record<string, unknown>`; `ComposedProject.contextProviders: ContextProvider[]` (one per component that declares `context`, `{ name: c.name, namespace: c.name, build: c.context }`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/component/test/context-providers.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema } from "@stackbase/values";
import { defineComponent } from "../src/define-component";
import { composeComponents } from "../src/compose";

const withCtx = defineComponent({
  name: "auth",
  schema: defineSchema({}),
  modules: {},
  context: (cctx) => ({ getUserId: async () => (cctx.identity ? "u" : null) }),
});
const noCtx = defineComponent({ name: "plain", schema: defineSchema({}), modules: {} });

describe("composeComponents — context providers", () => {
  it("derives one provider per component that declares context", () => {
    const out = composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [withCtx, noCtx]);
    expect(out.contextProviders.map((p) => p.name)).toEqual(["auth"]);
    expect(out.contextProviders[0]!.namespace).toBe("auth");
    expect(typeof out.contextProviders[0]!.build).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/component test context-providers` → FAIL (`context` not on the type / `contextProviders` undefined).

- [ ] **Step 3: Write minimal implementation**

In `packages/component/src/define-component.ts`, import the type and add the field:
```ts
import type { ComponentContext } from "@stackbase/executor";
// in ComponentDefinition:
  /** Optional facade contributed to every function's ctx as ctx[name]. Runs in this component's namespace. */
  context?: (cctx: ComponentContext) => Record<string, unknown>;
```

In `packages/component/src/compose.ts`, import `ContextProvider`, add it to `ComposedProject`, and populate it in `composeComponents`:
```ts
import type { RegisteredFunction, SimpleIndexCatalog, ContextProvider } from "@stackbase/executor";
// ComposedProject gains:
  contextProviders: ContextProvider[];
// in composeComponents, before the return:
  const contextProviders: ContextProvider[] = components
    .filter((c) => c.context)
    .map((c) => ({ name: c.name, namespace: c.name, build: c.context! }));
  return { catalog, moduleMap, componentNames: new Set(components.map((c) => c.name)), tableNumbers, contextProviders };
```

- [ ] **Step 4: Run test, typecheck, commit** — `pnpm --filter @stackbase/component test` → all pass · `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.

```bash
git add packages/component/src packages/component/test/context-providers.test.ts
git commit -m "feat(component): ComponentDefinition.context + composeComponents contextProviders"
```

---

### Task 3: Runtime threading + auth context builder + the integration test

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts` (`contextProviders` option + thread identity/providers into `run`)
- Modify: `packages/auth/src/component.ts` + add `packages/auth/src/context.ts` (the `context` builder)
- Modify: `packages/auth/src/index.ts` (export the context builder)
- Test: `packages/auth/test/ctx-auth.test.ts`

**Interfaces:**
- Consumes: `composeComponents().contextProviders` (Task 2), `RunOptions.identity`/`contextProviders` (Task 1).
- Produces: `EmbeddedRuntimeOptions.contextProviders?: ContextProvider[]`; `run(path, args, opts?: { identity?: string | null })` threads identity + providers; the `auth` component gains `context: authContext` where `authContext(cctx).getUserId()` resolves `cctx.identity` → `userId`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/auth/test/ctx-auth.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { auth } from "../src/component";

async function makeRuntime() {
  const appModules = { "me:get": query(async (ctx) => (ctx as { auth: { getUserId(): Promise<string | null> } }).auth.getUserId()) };
  const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
    { schemaJson: defineSchema({}).export(), moduleMap: appModules },
    [auth],
  );
  return EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
}

describe("ctx.auth in an app function", () => {
  it("resolves the ambient identity to the signed-up user, and re-reads auth/sessions (reactivity)", async () => {
    const r = await makeRuntime();
    const { token, userId } = (await r.run<{ token: string; userId: string }>("auth:signUp", { email: "a@b.co", password: "pw" })).value;

    const me = await r.run<string | null>("me:get", {}, { identity: token });
    expect(me.value).toBe(userId);
    expect(me.readRanges.length).toBeGreaterThan(0); // facade's read of auth/sessions landed in this query's read-set

    const anon = await r.run<string | null>("me:get", {}, { identity: "bad-token" });
    expect(anon.value).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/auth test ctx-auth` → FAIL (`contextProviders` not accepted / `ctx.auth` undefined / `run` has no identity arg).

- [ ] **Step 3: Write minimal implementation**

`packages/auth/src/context.ts`:
```ts
import type { ComponentContext } from "@stackbase/executor";

/** ctx.auth — resolves the ambient session token to the current user's id. */
export function authContext(cctx: ComponentContext) {
  return {
    getUserId: async (): Promise<string | null> => {
      const token = cctx.identity;
      if (!token) return null;
      const [session] = await cctx.db.query("sessions", "byToken").eq("token", token).collect();
      return session ? (session.userId as string) : null;
    },
  };
}
```
`packages/auth/src/component.ts`: import `authContext`, add `context: authContext` to the `defineComponent` call. `packages/auth/src/index.ts`: `export { authContext } from "./context";`.

In `packages/runtime-embedded/src/runtime.ts`:
```ts
// import the type
import type { ContextProvider } from "@stackbase/executor";
// EmbeddedRuntimeOptions gains:
  contextProviders?: ReadonlyArray<ContextProvider>;
// constructor gains a param:
  private readonly contextProviders: ReadonlyArray<ContextProvider>,
// in create(): capture and pass to the constructor
const contextProviders = options.contextProviders ?? [];
// ...
return new EmbeddedRuntime(options.store, executor, handler, adapter, modules, systemModules, componentNames, contextProviders);
// syncExecutor.runQuery/runMutation: add contextProviders (identity stays null until C3.5c)
  const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames), contextProviders });
// run(): add an opts param and thread identity + providers
  async run<T = unknown>(path: string, args: JSONValue, opts?: { identity?: string | null }): Promise<UdfResult<T>> {
    if (path.startsWith("_")) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    return this.executor.run<T>(fn, jsonToConvex(args), {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      identity: opts?.identity ?? null,
    });
  }
```
(`runSystem` is unchanged — no providers, stays privileged.)

- [ ] **Step 4: Run test, typecheck, full workspace, commit**

`pnpm --filter @stackbase/auth test ctx-auth` → PASS · `pnpm --filter @stackbase/auth test` → all auth pass · `pnpm --filter @stackbase/runtime-embedded test` → existing pass (no providers → ctx unchanged) · `pnpm --filter @stackbase/auth exec tsc --noEmit` → clean · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.

```bash
git add packages/runtime-embedded/src/runtime.ts packages/auth/src packages/auth/test/ctx-auth.test.ts
git commit -m "feat(runtime,auth): thread ambient identity + context providers; ctx.auth.getUserId()"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-ctx-contribution-auth-c3-5-design.md` §3 + build-order C3.5a):**
- §3.1 ambient identity — `KernelContext.identity` + `RunOptions.identity` + runtime `run(..., {identity})` (Tasks 1, 3). ✅
- §3.2 the context-provider hook (namespace-scoped read-only reader over the shared txn; collision-throws; frozen) — Task 1. ✅
- §3.3 auth uses it — `authContext` (Task 3). ✅
- §3.4 cross-component reactivity — proven by the read-set assertion (Tasks 1 & 3: the facade's read lands in the caller's `readRanges`). ✅
- §3.5 read-only facade (`GuestDatabaseReader`, no writes) — Task 1. ✅
- **Out of scope (per spec):** sync-path identity / WS subscribe-with-auth (C3.5c); argon2id + expiry + lockout (C3.5b); typed codegen; the public `context` API contract.

**Placeholder scan:** none — every step has runnable code/commands. The `(ctx as {...})` casts are the hand-written stopgap for the untyped facade (codegen deferred), called out in the constraints.

**Type consistency:** `ComponentContext`/`ContextProvider` (Task 1, executor) are imported by `ComponentDefinition.context` + `composeComponents` (Task 2, component) and `EmbeddedRuntimeOptions.contextProviders` (Task 3, runtime); `composeComponents().contextProviders` (Task 2) feeds `EmbeddedRuntime`'s option (Task 3); `RunOptions.identity` (Task 1) is set by `run(..., {identity})` (Task 3) and read by `kctx.identity` → `cctx.identity` (Task 1) → `authContext` (Task 3). `KernelContext.identity` is required and set at the single construction site in `executor.run`.
