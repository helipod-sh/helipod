# Component Engine C0 — Model + Namespaced Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The foundational, one-way-door piece of the component system: a `defineComponent` manifest and a `composeComponents` function that merges the app + components into ONE namespaced table registry, index catalog, and module map with no collisions.

**Architecture:** A new `packages/component` exports `defineComponent` (the manifest) and `composeComponents` (namespaced schema/function composition). Component tables are namespaced as `componentName/tableName` (the registry already reserves `getFullTableName`); component functions are keyed `componentName:fnName`. The app stays unprefixed ("component zero"), so nothing existing breaks. C0 does NOT build the scoped `ctx.db`, the boundary, config, codegen, auth, or the dashboard — those are C1–C4.

**Tech Stack:** TypeScript, pnpm workspaces, tsup, vitest. Reuses `@stackbase/id-codec` (registry, storage ids), `@stackbase/values` (schema), `@stackbase/executor` (`SimpleIndexCatalog`, `RegisteredFunction`).

## Global Constraints

- **Clean-room.** Study Convex's component model for shape only; never copy code.
- **The app is "component zero":** its tables and functions keep their current unprefixed names; existing `convex/` and `examples/chat` must not change.
- **Namespacing:** component table full-name is `getFullTableName(tableName, componentName)` = `componentName/tableName`. Component function key is `componentName:fnName`.
- **Reserved names:** a component name may not start with `_`, may not be `app`, and must be unique; it must not collide with an app module name.
- **Strict TS:** `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`; ESM only. `packages/component` depends only on `@stackbase/{id-codec,values,executor,errors}` — never a DB driver.
- This is a **one-way-door** foundation: C1–C4 build on these names/shapes.

---

### Task 1: Scaffold `packages/component` + `defineComponent`

**Files:**
- Create: `packages/component/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- Create: `packages/component/src/define-component.ts`
- Test: `packages/component/test/define-component.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface ComponentDefinition {
    name: string;
    schema: SchemaDefinition;                       // from @stackbase/values
    modules: Record<string, RegisteredFunction>;    // fnName → fn (flat; from @stackbase/executor)
    config?: Validator<unknown>;                     // typed settings (seam; unused in C0)
    requires?: string[];                             // other component names (seam)
    grants?: Record<string, { read?: string[]; write?: string[] }>; // app-table grants (seam)
  }
  function defineComponent(def: ComponentDefinition): ComponentDefinition
  ```
  `defineComponent` validates `name` (non-empty, not `_`-prefixed, not `app`) and returns the definition unchanged otherwise.

- [ ] **Step 1: Scaffold the package**

Copy `tsconfig.json` + `tsup.config.ts` verbatim from `packages/executor/`. `packages/component/package.json` (mirror `packages/admin/package.json`'s field shape):

```json
{
  "name": "@stackbase/component",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@stackbase/errors": "workspace:*",
    "@stackbase/executor": "workspace:*",
    "@stackbase/id-codec": "workspace:*",
    "@stackbase/values": "workspace:*"
  },
  "devDependencies": { "@types/node": "catalog:", "typescript": "catalog:", "vitest": "catalog:" }
}
```

`packages/component/src/index.ts`:
```ts
export * from "./define-component";
```

Run `pnpm install` at the repo root.

- [ ] **Step 2: Write the failing test**

```ts
// packages/component/test/define-component.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";

const schema = defineSchema({ sessions: defineTable({ token: v.string() }) });

describe("defineComponent", () => {
  it("returns the definition for a valid component", () => {
    const c = defineComponent({ name: "auth", schema, modules: { signIn: mutation(async () => "ok") } });
    expect(c.name).toBe("auth");
    expect(c.schema).toBe(schema);
    expect(Object.keys(c.modules)).toEqual(["signIn"]);
  });

  it("rejects reserved/invalid names", () => {
    expect(() => defineComponent({ name: "", schema, modules: {} })).toThrow();
    expect(() => defineComponent({ name: "_secret", schema, modules: {} })).toThrow(/reserved/);
    expect(() => defineComponent({ name: "app", schema, modules: {} })).toThrow(/reserved/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @stackbase/component test define-component`
Expected: FAIL — module not found.

- [ ] **Step 4: Write minimal implementation**

```ts
// packages/component/src/define-component.ts
import type { SchemaDefinition, Validator } from "@stackbase/values";
import type { RegisteredFunction } from "@stackbase/executor";

export interface ComponentDefinition {
  name: string;
  schema: SchemaDefinition;
  modules: Record<string, RegisteredFunction>;
  config?: Validator<unknown>;
  requires?: string[];
  grants?: Record<string, { read?: string[]; write?: string[] }>;
}

export function defineComponent(def: ComponentDefinition): ComponentDefinition {
  if (!def.name) throw new Error("component name must be non-empty");
  if (def.name.startsWith("_") || def.name === "app") throw new Error(`component name "${def.name}" is reserved`);
  return def;
}
```

> Check `@stackbase/values`'s `index.ts` exports `SchemaDefinition` and `Validator` (types) and `@stackbase/executor` exports `RegisteredFunction` — use the exact exported names. If `Validator` isn't exported, type `config?` as `unknown` for C0.

- [ ] **Step 5: Run test, build, commit**

Run: `pnpm --filter @stackbase/component test define-component` → PASS.
Run: `pnpm --filter @stackbase/component build` → emits `dist/`.

```bash
git add packages/component
git commit -m "feat(component): scaffold package + defineComponent manifest"
```

---

### Task 2: `composeComponents` — namespaced tables + catalog

**Files:**
- Create: `packages/component/src/compose.ts`
- Modify: `packages/component/src/index.ts` (add `export * from "./compose";`)
- Test: `packages/component/test/compose.test.ts`

**Interfaces:**
- Consumes: `defineComponent`/`ComponentDefinition` (Task 1); `MemoryTableRegistry`, `getFullTableName`, `encodeStorageIndexId` (`@stackbase/id-codec`); `SimpleIndexCatalog` (`@stackbase/executor`); `SchemaDefinitionJSON` (`@stackbase/values`).
- Produces:
  ```ts
  interface ComposeInput {
    app: { schemaJson: SchemaDefinitionJSON };
    components: ComponentDefinition[];
  }
  interface ComposedTables {
    tableNumbers: Record<string, number>;  // full name → number: app "messages"; component "auth/sessions"
    catalog: SimpleIndexCatalog;           // index catalog keyed by full table names
  }
  function composeTables(input: ComposeInput): ComposedTables
  ```
  App tables allocate under their bare name; component tables under `getFullTableName(table, component.name)`. Each table gets an implicit `by_creation` index plus its declared indexes (mirroring `loadProject`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/component/test/compose.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { defineComponent } from "../src/define-component";
import { composeTables } from "../src/compose";

const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) }).export();
const auth = defineComponent({ name: "auth", schema: defineSchema({ sessions: defineTable({ token: v.string() }) }), modules: {} });
const other = defineComponent({ name: "other", schema: defineSchema({ sessions: defineTable({ x: v.string() }) }), modules: {} });

describe("composeTables", () => {
  it("namespaces component tables so same-named tables don't collide", () => {
    const { tableNumbers } = composeTables({ app: { schemaJson: appSchema }, components: [auth, other] });
    // app table stays bare; component tables are namespaced
    expect(tableNumbers["messages"]).toBeGreaterThan(0);
    expect(tableNumbers["auth/sessions"]).toBeGreaterThan(0);
    expect(tableNumbers["other/sessions"]).toBeGreaterThan(0);
    // the two `sessions` tables get DISTINCT numbers (no collision)
    expect(tableNumbers["auth/sessions"]).not.toBe(tableNumbers["other/sessions"]);
  });

  it("registers each table's by_creation index in the catalog under its full name", () => {
    const { catalog } = composeTables({ app: { schemaJson: appSchema }, components: [auth] });
    expect(catalog.getTableNumber("messages")).toBeGreaterThan(0);
    expect(catalog.getTableNumber("auth/sessions")).toBeGreaterThan(0);
  });
});
```

> If `SimpleIndexCatalog` exposes a different accessor than `getTableNumber`, check `packages/executor/src` for the actual method (e.g. `tableNumber(name)`), and use it in both the test and the impl. Name the test assertion after the real method.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/component test compose`
Expected: FAIL — `../src/compose` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/component/src/compose.ts
import { MemoryTableRegistry, getFullTableName, encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog } from "@stackbase/executor";
import type { SchemaDefinitionJSON } from "@stackbase/values";
import type { ComponentDefinition } from "./define-component";

const DEFAULT_INDEX = "by_creation";

export interface ComposeInput {
  app: { schemaJson: SchemaDefinitionJSON };
  components: ComponentDefinition[];
}
export interface ComposedTables {
  tableNumbers: Record<string, number>;
  catalog: SimpleIndexCatalog;
}

function addSchema(
  schemaJson: SchemaDefinitionJSON,
  componentName: string,
  registry: MemoryTableRegistry,
  catalog: SimpleIndexCatalog,
  tableNumbers: Record<string, number>,
): void {
  for (const [tableName, tableDef] of Object.entries(schemaJson.tables)) {
    const fullName = getFullTableName(tableName, componentName); // "" → bare; else "component/name"
    const info = registry.allocate(fullName, { shardKey: tableDef.shardKey });
    tableNumbers[fullName] = info.tableNumber;
    catalog.addTable(fullName, info.tableNumber);
    catalog.addIndex({
      table: fullName,
      tableNumber: info.tableNumber,
      index: DEFAULT_INDEX,
      fields: [],
      indexId: encodeStorageIndexId(info.tableNumber, DEFAULT_INDEX),
    });
    for (const idx of tableDef.indexes) {
      catalog.addIndex({
        table: fullName,
        tableNumber: info.tableNumber,
        index: idx.indexDescriptor,
        fields: idx.fields,
        indexId: encodeStorageIndexId(info.tableNumber, idx.indexDescriptor),
      });
    }
  }
}

export function composeTables(input: ComposeInput): ComposedTables {
  const registry = new MemoryTableRegistry();
  const catalog = new SimpleIndexCatalog();
  const tableNumbers: Record<string, number> = {};
  addSchema(input.app.schemaJson, "", registry, catalog, tableNumbers); // app = component zero (bare names)
  for (const c of input.components) addSchema(c.schema.export(), c.name, registry, catalog, tableNumbers);
  return { tableNumbers, catalog };
}
```

Add `export * from "./compose";` to `src/index.ts`.

- [ ] **Step 4: Run test, typecheck, commit**

Run: `pnpm --filter @stackbase/component test compose` → PASS (2 tests).
Run: `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.

```bash
git add packages/component/src/compose.ts packages/component/src/index.ts packages/component/test/compose.test.ts
git commit -m "feat(component): composeTables — namespaced table/catalog composition"
```

---

### Task 3: Namespaced module map + collision validation

**Files:**
- Modify: `packages/component/src/compose.ts` (add `composeModules`)
- Test: `packages/component/test/compose-modules.test.ts`

**Interfaces:**
- Consumes: Task 1 `ComponentDefinition`.
- Produces:
  ```ts
  function composeModules(
    appModules: Record<string, RegisteredFunction>,   // app: "messages:list" (unchanged)
    components: ComponentDefinition[],
  ): Record<string, RegisteredFunction>               // adds "auth:signIn" per component
  ```
  Component function `fnName` is keyed `componentName:fnName`. Throws if two components share a name, if a component name collides with an app module prefix, or if a component name is reserved (already guarded by `defineComponent`, re-checked here for duplicates).

- [ ] **Step 1: Write the failing test**

```ts
// packages/component/test/compose-modules.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";
import { composeModules } from "../src/compose";

const empty = defineSchema({});
const auth = defineComponent({ name: "auth", schema: empty, modules: { signIn: mutation(async () => "t"), getSession: query(async () => null) } });
const app = { "messages:list": query(async () => []) };

describe("composeModules", () => {
  it("prefixes component functions and preserves app functions", () => {
    const map = composeModules(app, [auth]);
    expect(Object.keys(map).sort()).toEqual(["auth:getSession", "auth:signIn", "messages:list"]);
    expect(map["auth:signIn"]).toBe(auth.modules.signIn);
  });

  it("rejects duplicate component names", () => {
    const a2 = defineComponent({ name: "auth", schema: empty, modules: {} });
    expect(() => composeModules(app, [auth, a2])).toThrow(/duplicate/);
  });

  it("rejects a component name that collides with an app module prefix", () => {
    expect(() => composeModules({ "auth:foo": query(async () => 1) }, [auth])).toThrow(/collides/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @stackbase/component test compose-modules`
Expected: FAIL — `composeModules` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `packages/component/src/compose.ts` (and the import):

```ts
import type { RegisteredFunction } from "@stackbase/executor";

export function composeModules(
  appModules: Record<string, RegisteredFunction>,
  components: ComponentDefinition[],
): Record<string, RegisteredFunction> {
  const out: Record<string, RegisteredFunction> = { ...appModules };
  const appPrefixes = new Set(Object.keys(appModules).map((k) => k.slice(0, k.indexOf(":"))));
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.name)) throw new Error(`duplicate component name: ${c.name}`);
    if (appPrefixes.has(c.name)) throw new Error(`component name "${c.name}" collides with an app module`);
    seen.add(c.name);
    for (const [fnName, fn] of Object.entries(c.modules)) out[`${c.name}:${fnName}`] = fn;
  }
  return out;
}
```

- [ ] **Step 4: Run test, typecheck, full build, commit**

Run: `pnpm --filter @stackbase/component test` → all component tests pass.
Run: `pnpm --filter @stackbase/component exec tsc --noEmit` → clean.
Run: `pnpm build && pnpm typecheck && pnpm test` → whole workspace green (nothing existing changed).

```bash
git add packages/component/src/compose.ts packages/component/test/compose-modules.test.ts
git commit -m "feat(component): composeModules — namespaced functions + collision checks"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-component-system-design.md`):**
- §3.1 manifest (`defineComponent`) — Task 1. The `config`/`requires`/`grants` fields are typed seams (used in C1/C2), present but not enforced in C0. ✅
- §3.2 namespacing & registry composition — Task 2 (`composeTables`, full-name allocation via the existing `getFullTableName`). ✅
- Function namespacing (`api.<component>.*` foundation) — Task 3 (`composeModules`). ✅
- §9 migration ("app = component zero", bare names) — app uses `getFullTableName(name, "")` → bare; app modules unchanged. ✅
- **Out of scope for C0 (later plans, by design):** §3.3 `ctx` contribution, §3.4 boundary enforcement, §3.5 reactivity, §3.6 dependency resolution, §4 config/loader, §6 codegen, §7 auth, §8 dashboard.

**Placeholder scan:** none — every step has runnable code/commands. The two "check the exact exported name" notes (Task 1 `Validator`, Task 2 catalog accessor) instruct the implementer to verify against the real source and adjust both test and impl together — not placeholders.

**Type consistency:** `ComponentDefinition` (Task 1) is consumed unchanged by `composeTables`/`composeModules` (Tasks 2–3); `tableNumbers` is keyed by full name throughout; `getFullTableName(name, "")` returns the bare name (verified against `table-registry.ts:39-41`), so the app path is correct.
