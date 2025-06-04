# Config-Loader — `stackbase dev` Loads Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `stackbase dev` Convex-like for components: a project declares its components in `stackbase.config.ts`, the CLI composes them into the runtime, and the auto-served dashboard lists the component's tables. Result: `stackbase dev` on an auth-using project spins up the dashboard AND loads auth — no custom server.

**Architecture:** A `defineConfig({ components })` helper + a CLI `loadConfig(dir)` that imports `stackbase.config.ts`. `loadProject` routes catalog/module composition through `composeComponents`, so `ProjectArtifacts` gains `componentNames` + `contextProviders`; `devCommand` threads them into `createEmbeddedRuntime`. `AdminApi.listTables` enumerates the composed table set (so component tables appear in the dashboard). Then the auth-demo becomes a normal `stackbase dev` project.

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/component` (`defineConfig`), `@stackbase/cli` (`loadConfig`, `project.ts`, `cli.ts`), `@stackbase/admin` (`listTables`), `examples/auth-demo` (convert to a project).

## Global Constraints

- Components live in the top-level `components/` dir; npm names are `@stackbase/<name>` (e.g. `@stackbase/auth`). The config imports them by package name.
- `stackbase.config.ts` lives at the **project root** (the parent of `convex/`, i.e. the dir the `dev` command runs in) and `export default defineConfig({ components: [...] })`. A project with NO config → zero components → today's behavior, unchanged.
- Loading the TS config at dev time has the same Node-vs-Bun wrinkle as loading `convex/` modules — **reuse `loadConvexDir`'s import mechanism** (in `load-modules.ts`); do not invent a second TS loader.
- `loadProject` keeps building the app's `manifest` (codegen is for the app's own functions only); the catalog/moduleMap/tableNumbers come from `composeComponents`.
- Strict TS; ESM.

---

### Task 1: `defineConfig` + the CLI loads `stackbase.config.ts`

**Files:**
- Modify: `packages/component/src/define-component.ts` (or a new `src/config.ts`) — `defineConfig` + `StackbaseConfig`
- Modify: `packages/component/src/index.ts` (export)
- Create: `packages/cli/src/load-config.ts` (`loadConfig`)
- Modify: `packages/cli/src/index.ts` (export `loadConfig`)
- Test: `packages/cli/test/load-config.test.ts`

**Interfaces:**
- Produces: `interface StackbaseConfig { components: ComponentDefinition[] }`; `defineConfig(c: StackbaseConfig): StackbaseConfig`; `loadConfig(projectDir: string): Promise<StackbaseConfig>` — imports `<projectDir>/stackbase.config.{ts,js}` and returns its default export, or `{ components: [] }` if absent.

- [ ] **Step 1: Write the failing test** — a fixture config dir + assert `loadConfig` returns its components.
```ts
// packages/cli/test/load-config.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/load-config";

describe("loadConfig", () => {
  it("returns an empty component list when no config exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbcfg-"));
    expect((await loadConfig(dir)).components).toEqual([]);
  });
  it("loads components from stackbase.config.ts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbcfg-"));
    // a self-contained config that defines an inline component (avoids needing a built dep)
    writeFileSync(join(dir, "stackbase.config.ts"), `
      import { defineConfig, defineComponent } from "@stackbase/component";
      import { defineSchema } from "@stackbase/values";
      export default defineConfig({ components: [defineComponent({ name: "demo", schema: defineSchema({}), modules: {} })] });
    `);
    const cfg = await loadConfig(dir);
    expect(cfg.components.map((c) => c.name)).toEqual(["demo"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/cli test load-config` → FAIL (`loadConfig` missing).

- [ ] **Step 3: Write minimal implementation**

In `@stackbase/component` (e.g. `src/config.ts`, re-exported from index):
```ts
import type { ComponentDefinition } from "./define-component";
export interface StackbaseConfig { components: ComponentDefinition[] }
export function defineConfig(config: StackbaseConfig): StackbaseConfig { return config; }
```

In `packages/cli/src/load-config.ts` — read how `load-modules.ts` (`loadConvexDir`) imports a TS module at dev time and MIRROR it (same dynamic-import/transpile path). Then:
```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StackbaseConfig } from "@stackbase/component";

export async function loadConfig(projectDir: string): Promise<StackbaseConfig> {
  const path = ["stackbase.config.ts", "stackbase.config.js"].map((f) => join(projectDir, f)).find((p) => existsSync(p));
  if (!path) return { components: [] };
  const mod = await importModule(path); // <- use loadConvexDir's import mechanism
  const cfg = (mod.default ?? mod) as StackbaseConfig;
  return { components: cfg.components ?? [] };
}
```
(If `loadConvexDir` exposes a reusable single-module import helper, call it; otherwise extract one. Keep the Node/Bun handling identical to module loading.)

- [ ] **Step 4: Run test, typecheck, commit** — `pnpm --filter @stackbase/cli test load-config` → PASS · `pnpm --filter @stackbase/cli exec tsc --noEmit` → clean · `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.
```bash
git add packages/component/src packages/cli/src/load-config.ts packages/cli/src/index.ts packages/cli/test/load-config.test.ts
git commit -m "feat(cli): defineConfig + loadConfig — read components from stackbase.config.ts"
```

---

### Task 2: `loadProject` composes components; `devCommand` wires them into the runtime

**Files:**
- Modify: `packages/cli/src/project.ts` (`loadProject(loaded, components)`; `ProjectArtifacts` + `componentNames`/`contextProviders`)
- Modify: `packages/cli/src/push-pipeline.ts` (thread `components` through `push`)
- Modify: `packages/cli/src/cli.ts` (`devCommand` loads config + passes `componentNames`/`contextProviders` to `createEmbeddedRuntime`)
- Test: `packages/cli/test/load-project-components.test.ts`

**Interfaces:**
- Consumes: `composeComponents` (`@stackbase/component`), `loadConfig` (Task 1).
- Produces: `loadProject(loaded: LoadedProject, components?: ComponentDefinition[]): ProjectArtifacts` where `ProjectArtifacts` gains `componentNames: ReadonlySet<string>` + `contextProviders: ContextProvider[]`; `push(loaded, components?)` threads them; `devCommand` calls `createEmbeddedRuntime({ ..., componentNames, contextProviders })`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/cli/test/load-project-components.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { defineComponent } from "@stackbase/component";
import { loadProject } from "../src/project";

describe("loadProject with components", () => {
  it("composes component tables + functions into the catalog/moduleMap and reports componentNames/providers", () => {
    const auth = defineComponent({
      name: "auth",
      schema: defineSchema({ sessions: defineTable({ token: v.string() }).index("byToken", ["token"]) }),
      modules: { signOut: { type: "mutation", handler: async () => null } as never },
      context: (cctx) => ({ id: () => cctx.identity }),
    });
    const loaded = { schema: defineSchema({ notes: defineTable({ body: v.string() }) }), modules: {} };
    const p = loadProject(loaded, [auth]);
    expect(p.tableNumbers["notes"]).toBeGreaterThan(0);          // app table (bare)
    expect(p.tableNumbers["auth/sessions"]).toBeGreaterThan(0);  // component table (namespaced)
    expect(Object.keys(p.moduleMap)).toContain("auth:signOut");  // component function
    expect([...p.componentNames]).toEqual(["auth"]);
    expect(p.contextProviders.map((cp) => cp.name)).toEqual(["auth"]);
  });
  it("with no components, behaves as before (empty componentNames/providers)", () => {
    const loaded = { schema: defineSchema({ notes: defineTable({ body: v.string() }) }), modules: {} };
    const p = loadProject(loaded);
    expect(p.tableNumbers["notes"]).toBeGreaterThan(0);
    expect([...p.componentNames]).toEqual([]);
    expect(p.contextProviders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/cli test load-project-components` → FAIL.

- [ ] **Step 3: Write minimal implementation**

In `project.ts`: add `componentNames: ReadonlySet<string>` + `contextProviders: ContextProvider[]` to `ProjectArtifacts` (import `ContextProvider` from `@stackbase/executor`). Refactor `loadProject(loaded, components = [])`:
- Build `schemaJson = loaded.schema.export()` and the **app** `moduleMap` + `manifest` from `loaded.modules` (keep the existing module/manifest loop — it produces `appModuleMap`).
- Replace the table/catalog loop with `composeComponents`:
  ```ts
  const composed = composeComponents({ schemaJson, moduleMap: appModuleMap }, components);
  return {
    schemaJson,
    catalog: composed.catalog,
    moduleMap: composed.moduleMap,
    manifest,                          // app functions only (codegen)
    tableNumbers: composed.tableNumbers,
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
  };
  ```
  (Verify `composeComponents`/`composeTables` preserves `shardKey` when allocating app tables; if it doesn't, that's a Tier-2-only gap — note it, don't block.)

In `push-pipeline.ts`: thread an optional `components` param through `push(loaded, components?)` into `loadProject(loaded, components)`.

In `cli.ts` `devCommand`: after `loadConvexDir`, load the config and pass components through, then wire the runtime:
```ts
const config = await loadConfig(opts.convexDir ? dirname(opts.convexDir) : process.cwd());
const { project, generated } = push(loaded, config.components);
// ...
const runtime = await createEmbeddedRuntime({
  store: makeStore(opts.dataPath), catalog: project.catalog, logSink, modules: project.moduleMap,
  systemModules: systemModules(), componentNames: project.componentNames, contextProviders: project.contextProviders,
});
```
(Import `loadConfig` + `dirname`. Choose the config dir sensibly — the project root that contains `convex/`.)

- [ ] **Step 4: Run test, full workspace, commit** — `pnpm --filter @stackbase/cli test` → all pass · `pnpm --filter @stackbase/cli exec tsc --noEmit` → clean · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.
```bash
git add packages/cli/src/project.ts packages/cli/src/push-pipeline.ts packages/cli/src/cli.ts packages/cli/test/load-project-components.test.ts
git commit -m "feat(cli): loadProject composes declared components; devCommand wires them into the runtime"
```

---

### Task 3: `AdminApi.listTables` is component-aware (dashboard shows component tables)

**Files:**
- Modify: `packages/admin/src/admin-api.ts` (`listTables` enumerates the composed table set)
- Modify: `packages/cli/src/cli.ts` (pass what `AdminApi` needs)
- Test: `packages/admin/test/list-tables-components.test.ts` (or extend an existing admin test)

**Interfaces:**
- Produces: `listTables()` returns every composed table (app + component), so `auth/users`, `auth/accounts`, `auth/sessions` appear. Index info per table comes from the catalog when the table isn't in the app `schemaJson`.

- [ ] **Step 1: Write the failing test** — construct an `AdminApi` whose `tableNumbers` includes a component table (`auth/sessions`) not in `schemaJson`, and assert `listTables()` includes it.
```ts
// sketch — adapt to AdminApi's real constructor deps
// build tableNumbers = { notes: 10001, "auth/sessions": 10002 }, schemaJson with only `notes`,
// + a catalog that has both tables; expect listTables() names to include "auth/sessions".
```
(Read `admin-api.ts`'s `AdminApi` constructor + `TableInfo` shape first; write the test against the real API. The assertion that matters: a table present in `tableNumbers`/catalog but absent from the app `schemaJson` still appears in `listTables()`.)

- [ ] **Step 2: Run test to verify it fails** — the component table is missing from `listTables()`.

- [ ] **Step 3: Write minimal implementation** — change `listTables` to enumerate `Object.keys(this.deps.tableNumbers)` (the full composed set) instead of `schemaJson.tables`. For each table: indexes from `schemaJson.tables[name]` when present, else from the catalog (`indexesForTable(name)` → index descriptors) — so component tables show their indexes. Pass the catalog into `AdminApi` if not already available (add to its deps; wire in `cli.ts`).

- [ ] **Step 4: Run test, typecheck, commit** — admin tests pass · tsc clean.
```bash
git add packages/admin/src/admin-api.ts packages/cli/src/cli.ts packages/admin/test/list-tables-components.test.ts
git commit -m "feat(admin): listTables enumerates component tables (dashboard sees auth/*)"
```

---

### Task 4: Convert `examples/auth-demo` to a `stackbase dev` project

**Files:**
- Create: `examples/auth-demo/convex/schema.ts` (empty app schema), `examples/auth-demo/convex/whoami.ts` (the protected query), `examples/auth-demo/stackbase.config.ts` (`components: [auth]`)
- Delete: `examples/auth-demo/server.ts` (replaced by `stackbase dev`)
- Modify: `examples/auth-demo/package.json` (`dev` → `stackbase dev`, like the chat example)
- Test: keep `examples/auth-demo/test/flow.test.ts` working (it builds its own runtime via `composeComponents` — independent of the CLI; leave it).

**Interfaces:** the project now matches the chat example's shape; `stackbase dev` loads it (composes auth via the config) and auto-serves the dashboard.

- [ ] **Step 1** — `convex/schema.ts`: `export default defineSchema({});`. `convex/whoami.ts`: `export const get = query(async (ctx) => (ctx as any).auth.getUserId());`. `stackbase.config.ts`: `import { defineConfig } from "@stackbase/component"; import { auth } from "@stackbase/auth"; export default defineConfig({ components: [auth] });`.
- [ ] **Step 2** — `package.json` `dev` script → `"bun ../../packages/cli/dist/bin.js dev --dir convex --web web --port 3211"` (mirror chat). Remove `server.ts`. Keep the `web/` UI as-is (it already uses `anyApi.whoami.get` / `anyApi.auth.*` / `setAuth`).
- [ ] **Step 3** — Build the CLI + run an integration check that the project loads with auth composed:
  - `pnpm --filter @stackbase/cli build`
  - A CLI integration test (or a scripted check) that `loadConfig` + `loadProject` for the `examples/auth-demo` dir yields `componentNames` containing `auth` and `moduleMap` containing `auth:signIn` + `whoami:get`.
- [ ] **Step 4** — `pnpm build && pnpm typecheck && pnpm test` → whole workspace green; the flow test still passes.
```bash
git add examples/auth-demo
git commit -m "refactor(example): auth-demo runs via stackbase dev (config-loaded auth + auto dashboard)"
```

---

## Self-Review

**Spec coverage (the config-loader, per the C3.5 design's deferred "config + loader"):**
- `stackbase.config.ts` + `defineConfig` + `loadConfig` — Task 1. ✅
- `stackbase dev` composes declared components into the runtime — Task 2. ✅
- Dashboard shows component tables — Task 3. ✅
- The auth-demo becomes a real `stackbase dev` project (dashboard auto-spins-up) — Task 4. ✅
- **Out of scope (later):** the dashboard **Components page** (enable/disable/install UI = C4); component dependency topo-ordering + enable/disable lifecycle; per-table index metadata fidelity for component tables beyond names+indexes; `shardKey` propagation through `composeTables` (Tier-2).

**Placeholder scan:** the Task 3 test is a sketch directed to read `admin-api.ts` first (its constructor deps vary) — the binding assertion (a `tableNumbers`/catalog table absent from `schemaJson` still appears in `listTables`) is concrete. All other steps have runnable code.

**Type consistency:** `StackbaseConfig`/`defineConfig` (Task 1, component) → consumed by `loadConfig` (Task 1, cli) → feeds `push`/`loadProject(loaded, components)` (Task 2); `ProjectArtifacts.componentNames`/`contextProviders` (Task 2) → `createEmbeddedRuntime` (C3.5a/C2 options) and would also be where `AdminApi` gets the composed table set (Task 3). `ContextProvider` is the shared `@stackbase/executor` type throughout.
