# Component Engine C2 — Runtime Loader + Live Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the component boundary LIVE: `EmbeddedRuntime` composes app + components into a namespaced catalog/module map and threads each function's namespace into `executor.run`, so a component's functions are isolated — while the privileged `_system`/admin path can cross namespaces.

**Architecture:** A `composeComponents` helper (in `@stackbase/component`) orchestrates C0's `composeTables`/`composeModules` + a component-name set. The executor gains a `privileged` flag (bypasses the namespace boundary) for the admin/`_system` path. `EmbeddedRuntime` accepts `componentNames`, threads `namespaceForPath(path, componentNames)` into normal `run`/sync calls, and runs `runSystem` privileged. This plan does NOT build the config FILE loader (`stackbase.config.ts` + importing component packages) or codegen — those are follow-up plans; here components are composed programmatically (which is what C3's Auth tests + examples use).

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/component` (compose helper), `@stackbase/executor` (privileged flag), `@stackbase/runtime-embedded` (threading). Reuses C0/C1's `composeTables`/`composeModules`/`namespaceForPath` and `KernelContext.namespace`.

## Global Constraints

- Normal functions run at their namespace (`namespaceForPath(path, componentNames)`): a component fn at its name, an app fn at `""`.
- The admin/`_system` path runs **privileged**: it bypasses the namespace boundary (uses raw table names, skips the ownership check) so the dashboard can read/edit any table. `privileged` defaults to `false`.
- App preserved: with no components, `componentNames` is empty → every path resolves to `""` → behavior identical to today.
- Strict TS (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`); ESM only.
- `@stackbase/runtime-embedded` may now depend on `@stackbase/component` (component does NOT depend on runtime-embedded — no cycle).

---

### Task 1: `composeComponents` — the runtime composition helper

**Files:**
- Modify: `packages/component/src/compose.ts` (add `composeComponents`)
- Test: `packages/component/test/compose-components.test.ts`

**Interfaces:**
- Consumes: C0's `composeTables`, `composeModules`; `SimpleIndexCatalog`/`RegisteredFunction` (executor), `SchemaDefinitionJSON` (values).
- Produces:
  ```ts
  interface ComposedProject {
    catalog: SimpleIndexCatalog;
    moduleMap: Record<string, RegisteredFunction>;
    componentNames: ReadonlySet<string>;
    tableNumbers: Record<string, number>;
  }
  function composeComponents(
    app: { schemaJson: SchemaDefinitionJSON; moduleMap: Record<string, RegisteredFunction> },
    components: ComponentDefinition[],
  ): ComposedProject
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/component/test/compose-components.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";
import { composeComponents } from "../src/compose";

const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) }).export();
const auth = defineComponent({
  name: "auth",
  schema: defineSchema({ sessions: defineTable({ token: v.string() }) }),
  modules: { signIn: mutation(async () => "t") },
});

describe("composeComponents", () => {
  it("combines tables, modules, and the component-name set", () => {
    const out = composeComponents({ schemaJson: appSchema, moduleMap: { "messages:list": query(async () => []) } }, [auth]);
    expect(out.tableNumbers["messages"]).toBeGreaterThan(0);
    expect(out.tableNumbers["auth/sessions"]).toBeGreaterThan(0);
    expect(Object.keys(out.moduleMap).sort()).toEqual(["auth:signIn", "messages:list"]);
    expect([...out.componentNames]).toEqual(["auth"]);
    expect(out.catalog.getTable("auth/sessions")?.tableNumber).toBe(out.tableNumbers["auth/sessions"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/component test compose-components`
Expected: FAIL — `composeComponents` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/component/src/compose.ts`:
```ts
import type { SchemaDefinitionJSON } from "@stackbase/values";

export interface ComposedProject {
  catalog: SimpleIndexCatalog;
  moduleMap: Record<string, RegisteredFunction>;
  componentNames: ReadonlySet<string>;
  tableNumbers: Record<string, number>;
}

export function composeComponents(
  app: { schemaJson: SchemaDefinitionJSON; moduleMap: Record<string, RegisteredFunction> },
  components: ComponentDefinition[],
): ComposedProject {
  const { tableNumbers, catalog } = composeTables({ app: { schemaJson: app.schemaJson }, components });
  const moduleMap = composeModules(app.moduleMap, components);
  return { catalog, moduleMap, componentNames: new Set(components.map((c) => c.name)), tableNumbers };
}
```
(`SchemaDefinitionJSON` may already be imported in compose.ts — if so, don't duplicate.)

- [ ] **Step 4: Run test, typecheck, commit**

Run: `pnpm --filter @stackbase/component test compose-components` → PASS.
Run: `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.

```bash
git add packages/component/src/compose.ts packages/component/test/compose-components.test.ts
git commit -m "feat(component): composeComponents — app+components into one runtime project"
```

---

### Task 2: Privileged execution (bypass the namespace boundary)

**Files:**
- Modify: `packages/executor/src/kernel.ts` (`KernelContext.privileged`; `requireTable`/`requireOwnTable` bypass)
- Modify: `packages/executor/src/executor.ts` (`RunOptions.privileged` → `kctx.privileged`)
- Test: `packages/executor/test/privileged-scope.test.ts`

**Interfaces:**
- Consumes: C1's `KernelContext.namespace`, `requireTable`/`requireOwnTable`.
- Produces: `KernelContext` gains `readonly privileged: boolean`; `RunOptions` gains `privileged?: boolean` (default `false`). When `privileged`, `requireTable` uses the raw table name (no namespace prefix) and `requireOwnTable` is a no-op — so the admin/`_system` path can touch any table.

- [ ] **Step 1: Write the failing test**

```ts
// packages/executor/test/privileged-scope.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { MonotonicTimestampOracle } from "@stackbase/docstore";
import { SingleWriterTransactor } from "@stackbase/transactor";
import { QueryRuntime } from "@stackbase/query-engine";
import { encodeStorageIndexId } from "@stackbase/id-codec";
import { InlineUdfExecutor, SimpleIndexCatalog, mutation, query } from "../src/index";

async function harness() {
  const store = new SqliteDocStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const transactor = new SingleWriterTransactor(store, new MonotonicTimestampOracle());
  const queryRuntime = new QueryRuntime(store);
  const catalog = new SimpleIndexCatalog();
  catalog.addTable("auth/sessions", 10002);
  catalog.addIndex({ table: "auth/sessions", tableNumber: 10002, index: "by_creation", fields: [], indexId: encodeStorageIndexId(10002, "by_creation") });
  return new InlineUdfExecutor({ transactor, queryRuntime, catalog });
}

describe("privileged execution", () => {
  it("a privileged function can insert into and read any full-named table (no scoping)", async () => {
    const executor = await harness();
    // privileged: pass the FULL table name; no namespace prefix is applied
    const id = (await executor.run<string>(mutation(async (ctx) => ctx.db.insert("auth/sessions", { token: "t" })), {}, { privileged: true })).value;
    // privileged get by an id whose table is "auth/sessions" must NOT be blocked (requireOwnTable skipped)
    const got = await executor.run<{ token: string } | null>(query(async (ctx) => ctx.db.get(id)), {}, { privileged: true });
    expect(got.value?.token).toBe("t");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/executor test privileged-scope`
Expected: FAIL — `privileged` not accepted / the raw name `auth/sessions` doesn't resolve at namespace "".

- [ ] **Step 3: Write minimal implementation**

In `packages/executor/src/kernel.ts`:
```ts
// add to KernelContext
export interface KernelContext {
  readonly profile: UdfEnvironmentProfile;
  readonly txn: TransactionContext;
  readonly queryRuntime: QueryRuntime;
  readonly catalog: IndexCatalog;
  readonly snapshotTs: bigint;
  readonly random: SeededRandom;
  readonly logs: string[];
  readonly namespace: string;
  readonly privileged: boolean;
}

// requireTable: privileged uses the raw name (full names), else namespace-scoped
function requireTable(ctx: KernelContext, name: string): { tableNumber: number; fullName: string } {
  const fullName = ctx.privileged ? name : getFullTableName(name, ctx.namespace);
  const meta = ctx.catalog.getTable(fullName);
  if (!meta) throw new FunctionNotFoundError(`unknown table: ${name}`);
  return { tableNumber: meta.tableNumber, fullName };
}

// requireOwnTable: privileged bypasses the ownership check
function requireOwnTable(ctx: KernelContext, fullName: string): void {
  if (ctx.privileged) return;
  if (parseFullTableName(fullName).componentPath !== ctx.namespace) {
    throw new ForbiddenOperationError(`document is not in this component's namespace`);
  }
}
```

Also scope the query handlers' table lookup for privileged — in `handleDbQuery` AND `handleDbPaginate`, replace the index lookup line with:
```ts
  const tableName = ctx.privileged ? spec.table : getFullTableName(spec.table, ctx.namespace);
  const indexSpec = ctx.catalog.getIndex(tableName, spec.index);
```

In `packages/executor/src/executor.ts`:
```ts
export interface RunOptions {
  seed?: number;
  path?: string;
  namespace?: string;
  privileged?: boolean;
}
// in kctx construction:
  namespace: options.namespace ?? "",
  privileged: options.privileged ?? false,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @stackbase/executor test privileged-scope` → PASS.
Run: `pnpm --filter @stackbase/executor test` → all executor tests pass (default `privileged:false` preserves C1 behavior).
Run: `pnpm --filter @stackbase/executor exec tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/executor/src/kernel.ts packages/executor/src/executor.ts packages/executor/test/privileged-scope.test.ts
git commit -m "feat(executor): privileged execution bypasses the namespace boundary (admin/_system)"
```

---

### Task 3: Runtime threading — make the boundary live

**Files:**
- Modify: `packages/runtime-embedded/package.json` (add `"@stackbase/component": "workspace:*"`)
- Modify: `packages/runtime-embedded/src/runtime.ts` (accept `componentNames`; thread namespace into run/sync; `runSystem` privileged)
- Test: `packages/runtime-embedded/test/component-boundary.test.ts`

**Interfaces:**
- Consumes: `namespaceForPath` (`@stackbase/component`), `composeComponents` (Task 1), `RunOptions.privileged` (Task 2), `KernelContext.namespace` (C1).
- Produces: `EmbeddedRuntimeOptions` gains `componentNames?: ReadonlySet<string>`. Normal `run`/sync executions pass `{ path, namespace: namespaceForPath(path, componentNames) }`; `runSystem` passes `{ path, privileged: true }`.

- [ ] **Step 1: Add the dep**

In `packages/runtime-embedded/package.json` add `"@stackbase/component": "workspace:*"` to `dependencies`. Run `pnpm install` at the repo root.

- [ ] **Step 2: Write the failing test**

```ts
// packages/runtime-embedded/test/component-boundary.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { defineComponent, composeComponents } from "@stackbase/component";
import { systemModules, AdminApi } from "@stackbase/admin";
import { EmbeddedRuntime } from "../src/index";

const auth = defineComponent({
  name: "auth",
  schema: defineSchema({ sessions: defineTable({ token: v.string() }).index("by_token", ["token"]) }),
  modules: {
    signIn: mutation(async (ctx) => ctx.db.insert("sessions", { token: "t" })),         // bare "sessions"
    listSessions: query(async (ctx) => ctx.db.query("sessions", "by_creation").collect()),
    peekMessages: query(async (ctx) => ctx.db.query("messages", "by_creation").collect()), // app table — must be denied
  },
});
const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) });
const appModules = { "messages:add": mutation(async (ctx, a: { body: string }) => ctx.db.insert("messages", a)) };

async function makeRuntime() {
  const { catalog, moduleMap, componentNames } = composeComponents({ schemaJson: appSchema.export(), moduleMap: appModules }, [auth]);
  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog,
    modules: moduleMap,
    componentNames,
    systemModules: systemModules(),
  });
  return runtime;
}

describe("component boundary (live in the runtime)", () => {
  it("a component function runs at its own namespace and is isolated from the app", async () => {
    const runtime = await makeRuntime();
    await runtime.run("auth:signIn", {});
    expect((await runtime.run<unknown[]>("auth:listSessions", {})).value).toHaveLength(1); // its own table
    await runtime.run("messages:add", { body: "hi" }); // app fn, namespace ""
    await expect(runtime.run("auth:peekMessages", {})).rejects.toThrow(/unknown/); // can't reach app table
  });

  it("runSystem (privileged) can edit a component-namespaced document", async () => {
    const runtime = await makeRuntime();
    const id = (await runtime.run<string>("auth:signIn", {})).value;
    const patched = await runtime.runSystem<{ token: string }>("_system:patchDocument", { id, fields: { token: "edited" } });
    expect(patched.value.token).toBe("edited");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @stackbase/runtime-embedded test component-boundary`
Expected: FAIL — `componentNames` not accepted, or the auth function runs at namespace "" (so `auth:peekMessages` wrongly succeeds, or `auth:signIn` writes to the wrong table).

- [ ] **Step 4: Write minimal implementation**

In `packages/runtime-embedded/src/runtime.ts`:
```ts
// 1. import
import { namespaceForPath } from "@stackbase/component";

// 2. EmbeddedRuntimeOptions: add
  componentNames?: ReadonlySet<string>;

// 3. constructor: add a parameter
  private readonly componentNames: ReadonlySet<string>,

// 4. in create(): capture and use it
const componentNames = options.componentNames ?? new Set<string>();
// syncExecutor.runQuery and runMutation — add namespace to each executor.run:
  const r = await executor.run(resolve(path), jsonToConvex(args), { path, namespace: namespaceForPath(path, componentNames) });
// pass componentNames into the constructor:
return new EmbeddedRuntime(options.store, executor, handler, adapter, modules, systemModules, componentNames);

// 5. run(): thread namespace
  return this.executor.run<T>(fn, jsonToConvex(args), { path, namespace: namespaceForPath(path, this.componentNames) });

// 6. runSystem(): privileged
  return this.executor.run<T>(fn, jsonToConvex(args), { path, privileged: true });
```

(Apply the namespace addition to BOTH `syncExecutor.runQuery` and `syncExecutor.runMutation`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @stackbase/runtime-embedded test component-boundary` → PASS (2 tests).
Run: `pnpm --filter @stackbase/runtime-embedded test` → existing runtime tests pass (no componentNames → empty set → all paths namespace "").
Run: `pnpm --filter @stackbase/runtime-embedded exec tsc --noEmit` → clean.
Run: `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-embedded
git commit -m "feat(runtime): thread component namespace into execution; runSystem privileged (boundary live)"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-component-system-design.md` §3.3–§3.4, §10 C2):**
- The "loader" — composing app + components into the runtime — `composeComponents` (Task 1) + the runtime threading (Task 3). ✅
- The boundary made LIVE (the C1 carry-forward: a real component call runs at its own namespace, isolated) — Task 3's integration test. ✅
- The privileged admin/`_system` path crossing namespaces (the interaction the boundary forces) — Task 2 (executor) + Task 3 (`runSystem` privileged), proven by Task 3's second test. ✅
- **Out of scope for this plan (follow-up plans):** the config FILE (`stackbase.config.ts` + importing component npm packages + the CLI wiring); §6 codegen (`api.<component>.*` + composed `ctx` types); §3.6 dependency topo-ordering + enable/disable lifecycle (no installed-component lifecycle until the config loader exists); the `ctx`-contribution facades (`ctx.auth.getUserId()`).

**Placeholder scan:** none — every step has runnable code/commands. The "apply to BOTH query/paginate" (Task 2) and "BOTH runQuery/runMutation" (Task 3) name both call sites.

**Type consistency:** `composeComponents` (Task 1) returns `componentNames: ReadonlySet<string>`, consumed by `EmbeddedRuntimeOptions.componentNames` (Task 3) and `namespaceForPath(path, componentNames)`; `RunOptions.privileged` (Task 2) is set by `runSystem` (Task 3) and read by `requireTable`/`requireOwnTable`/query handlers (Task 2). `namespace`/`privileged` are both required on `KernelContext` and both set in the single `executor.ts` construction site.
