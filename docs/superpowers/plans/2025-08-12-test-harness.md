# `@stackbase/test` Harness + Conformance Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@stackbase/test` — an in-memory, real-engine, ergonomic function-test harness (`createTestStackbase`) — plus a clean-room Convex/concave-parity conformance suite dogfooded on it.

**Architecture:** A new dependency-light package `packages/test` generalizes the ~12 bespoke `makeRuntime` helpers into one public surface. It composes live module exports (no codegen) into an `EmbeddedRuntime` over `SqliteDocStore(NodeSqliteAdapter())` (defaults to `":memory:"`), and exposes `query/mutation/action/run/withIdentity/fetch/subscribe/finishScheduledFunctions/close`. Reactivity reuses the real client→loopback→engine path (`StackbaseClient` over `loopbackTransport`); reference resolution reuses `@stackbase/client`'s `getFunctionPath`. The conformance suite lives in the package's own test dir.

**Tech Stack:** TypeScript, Bun workspace + Turborepo, tsup (build), vitest under Node (tests). Engine packages: `@stackbase/runtime-embedded`, `@stackbase/docstore-sqlite`, `@stackbase/component`, `@stackbase/sync`, `@stackbase/client`, `@stackbase/storage`, `@stackbase/executor`, `@stackbase/values`.

## Global Constraints

- **Storage backend for the harness: SQLite `:memory:` ONLY.** `new SqliteDocStore(new NodeSqliteAdapter())` — `NodeSqliteAdapter` defaults to `":memory:"`. Do NOT add a JS-Map docstore.
- **No new engine code.** The harness only *wraps/composes* existing packages. If a genuine seam gap appears (e.g. `t.run`), prefer a test-only registered module over changing engine packages; an `EmbeddedRuntime` seam is an acceptable substitute only if unavoidable and reviewer-approved.
- **Reference resolution reuses `@stackbase/client`'s `getFunctionPath(ref | string)`** and the `anyApi` proxy (`ref.__path`, module path joins nested dirs with `/`, function with `:` — e.g. `"admin/users:list"`). Do NOT reimplement path resolution.
- **Identity is a string token** (`cctx.identity: string | null`), resolved by the app's auth component. `t.withIdentity(identity: string)` sets the raw token. Do NOT fake a Convex JWT-claims object. Document + assert this divergence; never paper over it.
- **Reactivity uses the real path** — `StackbaseClient` over `loopbackTransport` to the runtime, OR `SubscriptionManager` + the runtime `onCommit` fan-out with the query's `readRanges`. Surgical invalidation (`rangesOverlap`) must be exercised: intersecting write re-fires, non-intersecting write must NOT.
- **Clean-room / licensing (hard rule).** Study `.reference/convex-backend/npm-packages/demos/convex-test/` and concave's testing doc ONLY to enumerate *which behaviors* to assert. NEVER copy, port, or mechanically adapt FSL-licensed test code into `packages/`. All test code is authored in our own words. (Per `.reference/README.md`.)
- **Tests run under Node/vitest** (`bun run test` executes vitest under Node — `globalThis.Bun` is undefined). Do NOT write Bun-API-dependent code in the harness or tests.
- **Result unwrapping:** `query/mutation/action` return the `UdfResult.value`; a function error becomes a promise rejection (so `await expect(...).rejects.toThrow()` works).
- **Package hygiene:** `license: "MIT"`, `type: "module"`, tsup ESM build, `sideEffects: false`, mirror `packages/storage/package.json`.
- **Every instance is isolated;** `close()` stops drivers and closes the store (and removes any temp dir). No leaked timers across tests.

---

## File Structure

- `packages/test/package.json` — package manifest (deps below).
- `packages/test/tsconfig.json`, `packages/test/tsup.config.ts` — mirror `packages/storage`.
- `packages/test/src/index.ts` — public exports: `createTestStackbase`, `CreateTestOptions`, `TestStackbase`, `TestSubscription`.
- `packages/test/src/flatten.ts` — `flattenModules(modules)` → `{ moduleMap, schemaModule?, httpModule? }`. Pure.
- `packages/test/src/compose.ts` — `buildRuntime(opts)` → `{ runtime, blobTempDir?, tableNumbers, schemaJson }`. Composes components + always-on storage; instantiates `EmbeddedRuntime`.
- `packages/test/src/harness.ts` — `createTestStackbase` + the `TestStackbase` object assembling all methods.
- `packages/test/src/reactivity.ts` — `makeSubscribe(runtime)` → the `t.subscribe` implementation (loopback client).
- `packages/test/src/scheduler.ts` — `finishScheduledFunctions`/`advanceTimers` helpers over the scheduler driver + virtual clock.
- `packages/test/test/harness/*.test.ts` — harness self-tests (isolation, close, schema-auto, ref resolution, identity view).
- `packages/test/test/conformance/*.test.ts` — the conformance suite (db-crud, index-reads, pagination, validators, ids, errors, reactivity, scheduler, http-router, identity).
- `packages/test/test/fixtures/` — small in-repo app modules (schema + functions) used by conformance tests.
- `docs/enduser/testing.md` — the public testing guide (layer-1, honest identity note, reactivity capability).

**Package deps** (`packages/test/package.json`): `dependencies`: `@stackbase/runtime-embedded`, `@stackbase/docstore-sqlite`, `@stackbase/component`, `@stackbase/sync`, `@stackbase/client`, `@stackbase/storage`, `@stackbase/blobstore-fs`, `@stackbase/executor`, `@stackbase/values`, `@stackbase/id-codec` (all `workspace:*`). `devDependencies`: `@types/node`, `tsup`, `typescript`, `vitest` (all `catalog:`).

---

## Task 1: Package scaffold + `flattenModules`

**Files:**
- Create: `packages/test/package.json`, `packages/test/tsconfig.json`, `packages/test/tsup.config.ts`, `packages/test/src/index.ts`, `packages/test/src/flatten.ts`
- Test: `packages/test/test/harness/flatten.test.ts`

**Interfaces:**
- Produces: `flattenModules(modules: Record<string, unknown> | Record<string, () => Promise<unknown>>): Promise<{ moduleMap: Record<string, RegisteredFunction>; schemaModule: unknown | null; httpModule: unknown | null }>`. A `RegisteredFunction` is any export that is a non-null object with a string `type` field (`"query"|"mutation"|"action"|"httpAction"`) and a `handler`. Module path = key with a trailing `.ts`/`.js`/`.tsx` stripped; nested dirs keep `/`. Function path = `"<modpath>:<exportName>"`. A `"schema.ts"`/`"schema"` key's default (or the module itself) → `schemaModule`. A `"http.ts"`/`"http"` key's default → `httpModule`. Values may be the module object directly, or an async loader (`import.meta.glob`) — await it first.

- [ ] **Step 1: Scaffold the package.** Create `packages/test/package.json` mirroring `packages/storage/package.json` (name `@stackbase/test`, the deps listed in File Structure), `tsconfig.json` (copy `packages/storage/tsconfig.json`), and `tsup.config.ts` (copy `packages/storage/tsup.config.ts`). Create `packages/test/src/index.ts` with a temporary `export {};`.

Run: `cd packages/test && bun install` (from repo root `bun install` to link the workspace). Expected: package resolves.

- [ ] **Step 2: Write the failing test** for `flattenModules`.

```ts
// packages/test/test/harness/flatten.test.ts
import { describe, it, expect } from "vitest";
import { mutation, query } from "@stackbase/executor";
import { flattenModules } from "../../src/flatten";

describe("flattenModules", () => {
  it("maps <module>:<fn> paths, strips extensions, keeps nested dirs, and separates schema/http", async () => {
    const messages = { send: mutation(async () => "ok"), list: query(async () => []) };
    const adminUsers = { list: query(async () => []) };
    const schema = { default: { __isSchema: true } }; // stand-in; real defineSchema in later tasks
    const http = { default: { __isRouter: true } };
    const out = await flattenModules({
      "messages.ts": messages,
      "admin/users.ts": adminUsers,
      "schema.ts": schema,
      "http.ts": http,
    });
    expect(Object.keys(out.moduleMap).sort()).toEqual(["admin/users:list", "messages:list", "messages:send"]);
    expect(out.schemaModule).toBe(schema.default);
    expect(out.httpModule).toBe(http.default);
  });

  it("awaits import.meta.glob-style async loaders", async () => {
    const out = await flattenModules({ "a.ts": async () => ({ f: query(async () => 1) }) });
    expect(Object.keys(out.moduleMap)).toEqual(["a:f"]);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/flatten.test.ts`. Expected: FAIL (`flattenModules` not exported).

- [ ] **Step 4: Implement `flattenModules`.**

```ts
// packages/test/src/flatten.ts
import type { RegisteredFunction } from "@stackbase/executor";

function isRegisteredFunction(v: unknown): v is RegisteredFunction {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string"
    && "handler" in (v as object);
}

function stripExt(key: string): string {
  return key.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, "");
}

async function resolveModule(v: unknown): Promise<unknown> {
  return typeof v === "function" ? await (v as () => Promise<unknown>)() : v;
}

export interface FlattenedModules {
  moduleMap: Record<string, RegisteredFunction>;
  schemaModule: unknown | null;
  httpModule: unknown | null;
}

export async function flattenModules(
  modules: Record<string, unknown>,
): Promise<FlattenedModules> {
  const moduleMap: Record<string, RegisteredFunction> = {};
  let schemaModule: unknown | null = null;
  let httpModule: unknown | null = null;
  for (const [rawKey, rawVal] of Object.entries(modules)) {
    const modPath = stripExt(rawKey);
    const mod = (await resolveModule(rawVal)) as Record<string, unknown>;
    const def = mod && typeof mod === "object" ? (mod as { default?: unknown }).default : undefined;
    if (modPath === "schema") { schemaModule = def ?? mod; continue; }
    if (modPath === "http") { httpModule = def ?? mod; continue; }
    for (const [exportName, exportVal] of Object.entries(mod ?? {})) {
      if (isRegisteredFunction(exportVal)) moduleMap[`${modPath}:${exportName}`] = exportVal;
    }
  }
  return { moduleMap, schemaModule, httpModule };
}
```

Export from `index.ts`: `export { flattenModules } from "./flatten";`.

- [ ] **Step 5: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/flatten.test.ts`. Expected: PASS (2 tests).

- [ ] **Step 6: Build + typecheck.** Run from repo root: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean.

- [ ] **Step 7: Commit.** `git add packages/test && git commit -m "feat(test): scaffold @stackbase/test + flattenModules"`.

---

## Task 2: `createTestStackbase` core — compose runtime + query/mutation/action + close

**Files:**
- Create: `packages/test/src/compose.ts`, `packages/test/src/harness.ts`, `packages/test/test/fixtures/messages.ts`, `packages/test/test/harness/core.test.ts`
- Modify: `packages/test/src/index.ts`

**Interfaces:**
- Consumes: `flattenModules` (Task 1). `composeComponents(app: { schemaJson, moduleMap }, components: ComponentDefinition[], existingTableNumbers?): ComposedProject` returns `{ catalog, moduleMap, componentNames, tableNumbers, contextProviders, policyRegistry, policyProviders?, relationRegistry?, bootSteps, drivers }`. `EmbeddedRuntime.create(options: EmbeddedRuntimeOptions)` where options = `{ store, catalog, modules, systemModules?, componentNames?, contextProviders?, policyRegistry?, policyProviders?, relationRegistry?, bootSteps?, drivers?, tableNumbers?, now? }`. `runtime.run<T>(path, args, { identity? }): Promise<UdfResult<T>>` and `runtime.runAction<T>(...)`, `runtime.stopDrivers()`. `UdfResult<T> = { value: T; ... }`. `getFunctionPath(ref | string)`.
- Produces:
  - `buildRuntime(opts: CreateTestOptions): Promise<BuiltRuntime>` where `BuiltRuntime = { runtime: EmbeddedRuntime; tableNumbers: Record<string, number>; schemaJson: SchemaDefinitionJSON; cleanup: () => Promise<void> }`.
  - `createTestStackbase(opts: CreateTestOptions): TestStackbase` (async factory returning a promise — see note in Step 4).
  - `CreateTestOptions = { modules: Record<string, unknown>; components?: ComponentDefinition[]; schema?: SchemaDefinition | "auto" | false; now?: () => number }`.
  - `TestStackbase` methods `query/mutation/action/close` (others added in later tasks).

- [ ] **Step 1: Add a fixture app.**

```ts
// packages/test/test/fixtures/messages.ts
import { mutation, query } from "@stackbase/executor";
export const send = mutation(async (ctx: any, args: { body: string }) => ctx.db.insert("messages", { body: args.body }));
export const list = query(async (ctx: any) => ctx.db.query("messages", "by_creation").collect());
```

```ts
// packages/test/test/fixtures/schema.ts
import { defineSchema, defineTable, v } from "@stackbase/values";
export default defineSchema({
  messages: defineTable({ body: v.string() }),
});
```

- [ ] **Step 2: Write the failing test.**

```ts
// packages/test/test/harness/core.test.ts
import { describe, it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as messages from "../fixtures/messages";
import schema from "../fixtures/schema";

describe("createTestStackbase — core", () => {
  it("runs a mutation then a query against the real engine (in-memory)", async () => {
    const t = await createTestStackbase({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      const id = await t.mutation("messages:send", { body: "hi" });
      expect(typeof id).toBe("string");
      const rows = await t.query("messages:list", {});
      expect(rows).toHaveLength(1);
      expect(rows[0].body).toBe("hi");
    } finally {
      await t.close();
    }
  });

  it("rejects when a function throws", async () => {
    const t = await createTestStackbase({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
    try {
      await expect(t.query("messages:missing", {})).rejects.toThrow();
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Step 3: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/core.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement `compose.ts` and `harness.ts`.**

`createTestStackbase` is async (composition + `EmbeddedRuntime.create` are async). Users `await createTestStackbase(...)`. (This is the one intentional divergence from concave's sync `createTestConcave`; document it in Task 13.)

```ts
// packages/test/src/compose.ts
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type ComponentDefinition } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, type SchemaDefinition, type SchemaDefinitionJSON } from "@stackbase/values";
import type { RegisteredFunction } from "@stackbase/executor";
import { flattenModules } from "./flatten";

export interface CreateTestOptions {
  modules: Record<string, unknown>;
  components?: ComponentDefinition[];
  schema?: SchemaDefinition | "auto" | false;
  now?: () => number;
}

export interface BuiltRuntime {
  runtime: EmbeddedRuntime;
  tableNumbers: Record<string, number>;
  schemaJson: SchemaDefinitionJSON;
  cleanup: () => Promise<void>;
}

export async function buildRuntime(opts: CreateTestOptions): Promise<BuiltRuntime> {
  const flat = await flattenModules(opts.modules);
  // Resolve the schema: explicit option wins; else the schema.ts module; else empty.
  const schemaDef: SchemaDefinition =
    opts.schema && opts.schema !== "auto" && opts.schema !== false
      ? opts.schema
      : (flat.schemaModule as SchemaDefinition | null) ?? defineSchema({});
  const schemaJson = schemaDef.export();

  const composed = composeComponents({ schemaJson, moduleMap: flat.moduleMap }, opts.components ?? []);

  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry,
    policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
    bootSteps: composed.bootSteps,
    drivers: composed.drivers,
    tableNumbers: composed.tableNumbers,
    now: opts.now,
  });

  const cleanup = async () => { await runtime.stopDrivers(); };
  return { runtime, tableNumbers: composed.tableNumbers, schemaJson, cleanup };
}
```

```ts
// packages/test/src/harness.ts
import type { Value } from "@stackbase/values";
import { getFunctionPath, type FunctionReference } from "@stackbase/client";
import { buildRuntime, type CreateTestOptions, type BuiltRuntime } from "./compose";

type Args = Record<string, Value>;

export interface TestStackbase {
  query<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  mutation<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  action<T = unknown>(ref: FunctionReference | string, args?: Args): Promise<T>;
  close(): Promise<void>;
}

export async function createTestStackbase(opts: CreateTestOptions): Promise<TestStackbase> {
  const built: BuiltRuntime = await buildRuntime(opts);
  const { runtime } = built;

  return {
    async query(ref, args = {}) {
      return (await runtime.run(getFunctionPath(ref), args as never)).value as never;
    },
    async mutation(ref, args = {}) {
      return (await runtime.run(getFunctionPath(ref), args as never)).value as never;
    },
    async action(ref, args = {}) {
      return (await runtime.runAction(getFunctionPath(ref), args as never)).value as never;
    },
    async close() {
      await built.cleanup();
    },
  };
}
```

Update `index.ts`:
```ts
export { flattenModules } from "./flatten";
export { createTestStackbase } from "./harness";
export type { TestStackbase } from "./harness";
export type { CreateTestOptions } from "./compose";
```

- [ ] **Step 5: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/core.test.ts`. Expected: PASS (2 tests).

- [ ] **Step 6: Build + typecheck.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean. (If `run`/`runAction` reject vs return `{error}` differs from the assumption, adjust unwrapping so a thrown handler rejects — confirm against `packages/storage/test/context.test.ts`'s `.rejects` usage.)

- [ ] **Step 7: Commit.** `git add packages/test && git commit -m "feat(test): createTestStackbase core (query/mutation/action/close over in-memory engine)"`.

---

## Task 3: `t.run(fn)` — direct `ctx.db` access

**Files:**
- Modify: `packages/test/src/compose.ts` (register a `_test:_run` system module + slot), `packages/test/src/harness.ts` (add `run`)
- Test: `packages/test/test/harness/run.test.ts`

**Interfaces:**
- Produces: `t.run<T>(fn: (ctx: MutationCtx) => Promise<T>): Promise<T>` — runs `fn` with a full db-writer `ctx` inside one transaction. Mechanism: a `_test:_run` mutation registered in `systemModules` whose handler invokes a mutable `currentRunFn` slot on the `BuiltRuntime`; `t.run` sets the slot, calls `runtime.runSystem("_test:_run", {})`, and clears it in a `finally`. Returns the value the callback returned (thread it back via a captured variable, since `runSystem` returns the mutation's own return).

- [ ] **Step 1: Write the failing test.**

```ts
// packages/test/test/harness/run.test.ts
import { describe, it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as messages from "../fixtures/messages";
import schema from "../fixtures/schema";

it("t.run gives direct ctx.db access for setup and assertions", async () => {
  const t = await createTestStackbase({ modules: { "messages.ts": messages, "schema.ts": { default: schema } } });
  try {
    const id = await t.run(async (ctx) => ctx.db.insert("messages", { body: "seeded" }));
    expect(typeof id).toBe("string");
    const rows = await t.query("messages:list", {});
    expect(rows).toHaveLength(1);
    const doc = await t.run(async (ctx) => ctx.db.get(id));
    expect(doc.body).toBe("seeded");
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/run.test.ts`. Expected: FAIL (`t.run` not a function).

- [ ] **Step 3: Implement the slot + `_test:_run` in `compose.ts`.** Add to `BuiltRuntime` a `setRunFn(fn)` accessor over a closure slot, and register the module. In `buildRuntime`:

```ts
// inside buildRuntime, before EmbeddedRuntime.create:
import { mutation } from "@stackbase/executor";
let currentRunFn: ((ctx: unknown) => Promise<unknown>) | null = null;
let runResult: unknown = undefined;
const systemModules = {
  "_test:_run": mutation(async (ctx: unknown) => {
    if (!currentRunFn) throw new Error("_test:_run invoked with no callback set");
    runResult = await currentRunFn(ctx);
    return null;
  }),
};
// pass `systemModules` to EmbeddedRuntime.create({ ..., systemModules })
// expose on BuiltRuntime:
//   setRunFn: (fn) => { currentRunFn = fn; },
//   takeRunResult: () => { const r = runResult; runResult = undefined; return r; },
```

Return `setRunFn`/`takeRunResult` on `BuiltRuntime`.

- [ ] **Step 4: Implement `t.run` in `harness.ts`.**

```ts
async run(fn) {
  built.setRunFn(fn as (ctx: unknown) => Promise<unknown>);
  try {
    await runtime.runSystem("_test:_run", {});
    return built.takeRunResult() as never;
  } finally {
    built.setRunFn(null as never);
  }
},
```

Add `run` to the `TestStackbase` interface: `run<T>(fn: (ctx: any) => Promise<T>): Promise<T>;` (the `ctx` is the engine's `MutationCtx`; typed `any` here to avoid leaking internal types — revisit if a public `MutationCtx` type exists).

- [ ] **Step 5: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/run.test.ts`. Expected: PASS.

- [ ] **Step 6: Build + typecheck.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean.

- [ ] **Step 7: Commit.** `git add packages/test && git commit -m "feat(test): t.run direct ctx.db access via _test:_run slot"`.

---

## Task 4: Always-on `ctx.storage` support

**Files:**
- Modify: `packages/test/src/compose.ts` (inject `_storage` table + wire storage modules/provider/reaper + temp-dir blobstore)
- Test: `packages/test/test/harness/storage.test.ts`, `packages/test/test/fixtures/files.ts`

**Interfaces:**
- Consumes: from `@stackbase/storage`: `storageModules`, `storageContextProvider(blobStore, { signingKey, uploadTtlMs? })`, `storageReaper(blobStore, opts?)`, and the canonical `_storage` table definition + table number (`STORAGE_TABLE`, `STORAGE_TABLE_NUMBER`, `storageTableDefinition` — from `@stackbase/storage`'s `system-table` or `@stackbase/values`'s `system-tables`; confirm the export). From `@stackbase/blobstore-fs`: `FsBlobStore`. Node `fs`/`os` for a per-instance temp dir.
- Produces: `ctx.storage` available in query/mutation/action; the `_storage` table present in the composed schema/tableNumbers so `v.id("_storage")` validates; temp blob dir removed in `cleanup`.

- [ ] **Step 1: Write the failing test.**

```ts
// packages/test/test/fixtures/files.ts
import { mutation, action } from "@stackbase/executor";
export const makeUpload = mutation(async (ctx: any) => ctx.storage.generateUploadUrl({}));
export const storeBytes = action(async (ctx: any, { text }: { text: string }) =>
  ctx.storage.store(new TextEncoder().encode(text), { contentType: "text/plain" }));
export const readBytes = action(async (ctx: any, { id }: { id: string }) => {
  const s = await ctx.storage.get(id);
  return s === null ? null : new TextDecoder().decode(await new Response(s).arrayBuffer());
});
```

```ts
// packages/test/test/harness/storage.test.ts
import { describe, it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as files from "../fixtures/files";
import { defineSchema } from "@stackbase/values";

it("ctx.storage works: generateUploadUrl (mutation) + store/get bytes (action)", async () => {
  const t = await createTestStackbase({
    modules: { "files.ts": files, "schema.ts": { default: defineSchema({}) } },
  });
  try {
    const up = await t.mutation("files:makeUpload", {});
    expect(up.storageId).toBeDefined();
    const id = await t.action("files:storeBytes", { text: "hello" });
    expect(await t.action("files:readBytes", { id })).toBe("hello");
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/storage.test.ts`. Expected: FAIL (`ctx.storage` undefined).

- [ ] **Step 3: Inject storage in `compose.ts`.** After computing `schemaJson`/`composed`, before `create`: create a per-instance temp dir (`fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"))`), a `FsBlobStore({ root: tempDir })`, add `storageContextProvider(blobStore, { signingKey: "stackbase-test-signing-key" })` to `contextProviders`, merge `storageModules` into `modules`, add `storageReaper(blobStore)` to `drivers`, and inject the `_storage` table into `schemaJson`/`tableNumbers` the way `packages/cli`'s `loadProject` does (find the exact injection: `grep -rn "STORAGE_TABLE\|_storage" packages/cli/src`). In `cleanup`, `fs.rmSync(tempDir, { recursive: true, force: true })` after `stopDrivers`.

Note: the `_storage` injection must happen on the `schemaJson` **before** `composeComponents` (so the catalog/tableNumbers include it). If storage exports a helper (e.g. `withStorageSchema`), use it; otherwise replicate `loadProject`'s injection.

- [ ] **Step 4: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/storage.test.ts`. Expected: PASS.

- [ ] **Step 5: Build + typecheck + full package test.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test && cd packages/test && ../../node_modules/.bin/vitest run`. Expected: all green.

- [ ] **Step 6: Commit.** `git add packages/test && git commit -m "feat(test): always-on ctx.storage (temp-dir FsBlobStore + _storage injection)"`.

---

## Task 5: `t.withIdentity`

**Files:**
- Modify: `packages/test/src/harness.ts` (thread an ambient identity; add `withIdentity`)
- Test: `packages/test/test/harness/identity.test.ts`, `packages/test/test/fixtures/whoami.ts`

**Interfaces:**
- Produces: `t.withIdentity(identity: string): TestStackbase` — a view of the SAME backend whose `query/mutation/action/subscribe` pass `{ identity }`. `t.run` and `t.fetch` behavior with identity: `run` stays privileged (no identity); `fetch` passes the raw `Authorization` header through (Task 6). Refactor the method bodies to read an ambient `identity: string | null` (default `null`) captured per-view.

- [ ] **Step 1: Write the failing test.**

```ts
// packages/test/test/fixtures/whoami.ts
import { query } from "@stackbase/executor";
// The engine exposes the ambient identity token as ctx.identity on query/mutation ctx.
export const me = query(async (ctx: any) => ctx.identity ?? null);
```

```ts
// packages/test/test/harness/identity.test.ts
import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import * as whoami from "../fixtures/whoami";
import { defineSchema } from "@stackbase/values";

it("withIdentity sets the ambient identity token on the same backend", async () => {
  const t = await createTestStackbase({ modules: { "whoami.ts": whoami, "schema.ts": { default: defineSchema({}) } } });
  try {
    expect(await t.query("whoami:me", {})).toBeNull();
    const asAda = t.withIdentity("ada-token");
    expect(await asAda.query("whoami:me", {})).toBe("ada-token");
    expect(await t.query("whoami:me", {})).toBeNull(); // base view unaffected
  } finally {
    await t.close();
  }
});
```

(Confirm `ctx.identity` is exposed on the query ctx; if the engine surfaces identity only through an auth component, adjust the fixture to read via the available surface — `grep -rn "ctx.identity\|identity" packages/executor/src/kernel.ts`.)

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/identity.test.ts`. Expected: FAIL.

- [ ] **Step 3: Refactor `harness.ts`** so the returned object is produced by a `makeView(identity: string | null)` closure; `query/mutation/action` pass `{ identity }`. `withIdentity(id)` returns `makeView(id)`. `close`/`run`/`fetch`/`subscribe` are shared. Base view = `makeView(null)`.

- [ ] **Step 4: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/identity.test.ts`. Expected: PASS.

- [ ] **Step 5: Build + typecheck.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean.

- [ ] **Step 6: Commit.** `git add packages/test && git commit -m "feat(test): t.withIdentity (ambient identity token per view)"`.

---

## Task 6: `t.fetch` — route a Request through `http.ts`

**Files:**
- Modify: `packages/test/src/compose.ts` (apply the app's http router to the runtime), `packages/test/src/harness.ts` (add `fetch`)
- Test: `packages/test/test/harness/fetch.test.ts`, `packages/test/test/fixtures/http.ts`

**Interfaces:**
- Consumes: the `httpModule` from `flattenModules` (an `httpRouter()` default export). The runtime's route application (`grep -rn "setRoutes\|matchRoute\|routeRequest\|http" packages/runtime-embedded/src/runtime.ts packages/cli/src` for the exact method the dev server uses to install routes and dispatch a `Request`). Reuse the same call `stackbase dev` makes.
- Produces: `t.fetch(request: Request): Promise<Response>`.

- [ ] **Step 1: Write the failing test.**

```ts
// packages/test/test/fixtures/http.ts
import { httpRouter, httpAction } from "@stackbase/executor";
const http = httpRouter();
http.route({
  path: "/webhooks/ping",
  method: "POST",
  handler: httpAction(async (_ctx: any, req: Request) => {
    const body = await req.json();
    return new Response(JSON.stringify({ pong: body.n }), { status: 200 });
  }),
});
export default http;
```

```ts
// packages/test/test/harness/fetch.test.ts
import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import http from "../fixtures/http";
import { defineSchema } from "@stackbase/values";

it("t.fetch routes a Request through http.ts and returns the Response", async () => {
  const t = await createTestStackbase({ modules: { "http.ts": { default: http }, "schema.ts": { default: defineSchema({}) } } });
  try {
    const res = await t.fetch(new Request("http://localhost/webhooks/ping", {
      method: "POST", body: JSON.stringify({ n: 42 }), headers: { "content-type": "application/json" },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: 42 });
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/fetch.test.ts`. Expected: FAIL.

- [ ] **Step 3: Wire routes + implement `fetch`.** In `compose.ts`, if `flat.httpModule` is present, install its routes via the same runtime call the dev server uses (e.g. `runtime.setRoutes(...)` / the `http-routing` path — confirm via `packages/cli/test/http-routing.test.ts` and `packages/cli/src`). Expose a `dispatchHttp(request): Promise<Response>` on `BuiltRuntime` (reusing `matchRoute` + the runtime's httpAction dispatch, exactly as the dev server does). In `harness.ts`, `fetch(request)` delegates to `built.dispatchHttp(request)`; pass the request's raw `Authorization` header through as identity if present (mirroring the engine's `httpAction` identity passthrough).

- [ ] **Step 4: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/fetch.test.ts`. Expected: PASS.

- [ ] **Step 5: Build + typecheck.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean.

- [ ] **Step 6: Commit.** `git add packages/test && git commit -m "feat(test): t.fetch routes Requests through http.ts"`.

---

## Task 7: `t.subscribe` — reactivity via the real loopback path

**Files:**
- Create: `packages/test/src/reactivity.ts`
- Modify: `packages/test/src/harness.ts` (add `subscribe`), `packages/test/src/compose.ts` (expose the loopback handle)
- Test: `packages/test/test/harness/subscribe.test.ts`

**Interfaces:**
- Consumes: from `@stackbase/client`: `StackbaseClient`, `loopbackTransport`. From `@stackbase/runtime-embedded`: the loopback bridge (`packages/runtime-embedded/src/loopback.ts` — find the export that yields a `LoopbackLike` for a runtime; `grep -rn "loopback\|LoopbackLike" packages/runtime-embedded/src`). The client's `subscribe(ref, args, onUpdate): () => void` (`packages/client/src/client.ts:44`).
- Produces: `t.subscribe<T>(ref, args?): TestSubscription<T>` where `TestSubscription<T> = { value(): T | undefined; onChange(cb: (v: T) => void): () => void; unsubscribe(): void }`. Backed by ONE shared `StackbaseClient` over `loopbackTransport` to the runtime (created lazily on first `subscribe`, closed in `cleanup`). This exercises the REAL client→protocol→SubscriptionManager→engine invalidation path (surgical, range-based).

- [ ] **Step 1: Write the failing test — surgical invalidation both ways.**

```ts
// packages/test/test/harness/subscribe.test.ts
import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

const mod = {
  add: mutation(async (ctx: any, a: { room: string; body: string }) => ctx.db.insert("messages", a)),
  byRoom: query(async (ctx: any, a: { room: string }) =>
    ctx.db.query("messages", "by_room").withIndex("by_room", (q: any) => q.eq("room", a.room)).collect()),
};
const schema = defineSchema({
  messages: defineTable({ room: v.string(), body: v.string() }).index("by_room", ["room"]),
});

async function waitFor(pred: () => boolean, ms = 1000) {
  const start = Date.now();
  while (!pred()) { if (Date.now() - start > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); }
}

it("subscribe re-fires on an intersecting write and NOT on a non-intersecting one", async () => {
  const t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  try {
    const sub = t.subscribe("mod:byRoom", { room: "general" });
    let changes = 0;
    sub.onChange(() => { changes++; });
    await waitFor(() => sub.value() !== undefined);
    expect(sub.value()).toHaveLength(0);

    await t.mutation("mod:add", { room: "general", body: "hi" }); // intersects the read set
    await waitFor(() => (sub.value()?.length ?? 0) === 1);
    expect(changes).toBeGreaterThanOrEqual(1);

    const before = changes;
    await t.mutation("mod:add", { room: "other", body: "x" }); // does NOT intersect room=general
    await new Promise((r) => setTimeout(r, 50));
    expect(sub.value()).toHaveLength(1);
    expect(changes).toBe(before); // no spurious re-fire
    sub.unsubscribe();
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/subscribe.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement `reactivity.ts`.** Lazily build a `StackbaseClient` over `loopbackTransport(<runtime loopback handle>)`. `subscribe(ref, args)` calls `client.subscribe(getFunctionPath(ref), args, onUpdate)`; keep the latest value + a listener set; `value()`/`onChange()`/`unsubscribe()` operate on that. Close the client in `cleanup`. Reuse the exact loopback wiring from an existing embedded reactive test (`grep -rn "loopbackTransport\|StackbaseClient" packages examples` for a working reference, e.g. the chat example or a runtime-embedded test).

- [ ] **Step 4: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/subscribe.test.ts`. Expected: PASS.

- [ ] **Step 5: Build + typecheck + full package.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test && cd packages/test && ../../node_modules/.bin/vitest run`. Expected: all green.

- [ ] **Step 6: Commit.** `git add packages/test && git commit -m "feat(test): t.subscribe reactive path via loopback client (surgical invalidation)"`.

---

## Task 8: Component composition + scheduler time control

**Files:**
- Create: `packages/test/src/scheduler.ts`
- Modify: `packages/test/src/harness.ts` (add `finishScheduledFunctions`/`advanceTimers`), `packages/test/src/compose.ts` (expose the scheduler driver + current clock)
- Test: `packages/test/test/harness/scheduler.test.ts`

**Interfaces:**
- Consumes: `opts.components` (already forwarded to `composeComponents` in Task 2). The scheduler driver exposes a `__tick` test seam (`components/scheduler/src/driver.ts`); `defineScheduler()` from `@stackbase/scheduler`; the injected `now`. Find the driver in `composed.drivers` by `name === "scheduler"` (mirror `components/scheduler/test/helpers.ts`).
- Produces: `t.finishScheduledFunctions(): Promise<void>` — advances the virtual clock past all due jobs and drives `driver.__tick()` until no jobs are due (bounded loop, e.g. max 100 iterations, throw on exceed). `t.advanceTimers(ms: number): Promise<void>` — advances the clock by `ms` and drives one `__tick`. The harness owns a mutable virtual clock when `opts.now` is not supplied (default start ts, e.g. `1_700_000_000_000`), so these methods can advance it.

- [ ] **Step 1: Write the failing test.**

```ts
// packages/test/test/harness/scheduler.test.ts
import { it, expect } from "vitest";
import { createTestStackbase } from "../../src";
import { defineScheduler } from "@stackbase/scheduler";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

const mod = {
  kick: mutation(async (ctx: any) => { await ctx.scheduler.runAfter(1000, "mod:mark", {}); }),
  mark: mutation(async (ctx: any) => ctx.db.insert("marks", { at: "done" })),
  count: query(async (ctx: any) => (await ctx.db.query("marks", "by_creation").collect()).length),
};
const schema = defineSchema({ marks: defineTable({ at: v.string() }) });

it("finishScheduledFunctions runs a scheduled mutation to completion", async () => {
  const t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } }, components: [defineScheduler()] });
  try {
    await t.mutation("mod:kick", {});
    expect(await t.query("mod:count", {})).toBe(0);
    await t.finishScheduledFunctions();
    expect(await t.query("mod:count", {})).toBe(1);
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/scheduler.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement the virtual clock + `scheduler.ts`.** In `compose.ts`, when `opts.now` is absent, own a `let clockMs = 1_700_000_000_000` and pass `now: () => clockMs`; expose `advanceClock(ms)` and `getSchedulerDriver()` (find `name === "scheduler"` in `composed.drivers`) on `BuiltRuntime`. In `scheduler.ts`, implement `finishScheduledFunctions(built)` = loop: advance the clock to the next due job (or by a fixed step), `await driver.__tick()`, re-check due count via the scheduler's peek path — simplest robust version: loop `advanceClock(bigStep)` + `await driver.__tick()` until two consecutive ticks produce no new commits, bounded at 100 iterations. `advanceTimers(built, ms)` = `advanceClock(ms)` + one `__tick`.

- [ ] **Step 4: Run tests to confirm pass.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/scheduler.test.ts`. Expected: PASS.

- [ ] **Step 5: Build + typecheck.** Run: `bun run build --filter @stackbase/test && bun run typecheck --filter @stackbase/test`. Expected: clean.

- [ ] **Step 6: Commit.** `git add packages/test && git commit -m "feat(test): scheduler time control (finishScheduledFunctions/advanceTimers)"`.

---

## Task 9: Conformance — db-crud, index-reads, pagination

**Files:**
- Create: `packages/test/test/conformance/db-crud.test.ts`, `packages/test/test/conformance/index-reads.test.ts`, `packages/test/test/conformance/pagination.test.ts`, `packages/test/test/fixtures/conformance-app.ts`
- Test: the three files above.

**Interfaces:**
- Consumes: `createTestStackbase`, `t.run`, `t.query`, `t.mutation`. Study (do NOT copy) `.reference/convex-backend/npm-packages/demos/convex-test/convex/posts.test.ts` etc. to enumerate behaviors.

A shared fixture app with a `docs` table (indexed) drives all three files.

```ts
// packages/test/test/fixtures/conformance-app.ts
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";
export const schema = defineSchema({
  docs: defineTable({ owner: v.string(), n: v.number(), tag: v.string() }).index("by_owner_n", ["owner", "n"]),
});
export const mod = {
  insert: mutation(async (ctx: any, a: any) => ctx.db.insert("docs", a)),
  patch: mutation(async (ctx: any, a: { id: string; patch: any }) => { await ctx.db.patch(a.id, a.patch); return null; }),
  replace: mutation(async (ctx: any, a: { id: string; doc: any }) => { await ctx.db.replace(a.id, a.doc); return null; }),
  del: mutation(async (ctx: any, a: { id: string }) => { await ctx.db.delete(a.id); return null; }),
  get: query(async (ctx: any, a: { id: string }) => ctx.db.get(a.id)),
  allDesc: query(async (ctx: any) => ctx.db.query("docs", "by_creation").order("desc").collect()),
  ownerRange: query(async (ctx: any, a: { owner: string; lo: number; hi: number }) =>
    ctx.db.query("docs", "by_owner_n").withIndex("by_owner_n", (q: any) => q.eq("owner", a.owner).gte("n", a.lo).lt("n", a.hi)).collect()),
  page: query(async (ctx: any, a: { cursor: string | null; num: number }) =>
    ctx.db.query("docs", "by_creation").paginate({ cursor: a.cursor, numItems: a.num })),
};
```

- [ ] **Step 1: Write `db-crud.test.ts`** with COMPLETE tests for: insert returns a usable id; `get` round-trips; `patch` merges (unspecified fields retained); `replace` overwrites (dropped fields gone); `delete` makes `get` return null; `.order("desc")` returns creation-descending order. Example:

```ts
import { it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";

let t: TestStackbase;
beforeEach(async () => { t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } }); });
afterEach(async () => { await t.close(); });

it("patch merges, replace overwrites", async () => {
  const id = await t.mutation("mod:insert", { owner: "a", n: 1, tag: "x" });
  await t.mutation("mod:patch", { id, patch: { n: 2 } });
  expect((await t.query("mod:get", { id }))).toMatchObject({ owner: "a", n: 2, tag: "x" });
  await t.mutation("mod:replace", { id, doc: { owner: "a", n: 9, tag: "y" } });
  expect((await t.query("mod:get", { id }))).toMatchObject({ owner: "a", n: 9, tag: "y" });
});
```

Cover every behavior in the list above as its own `it(...)`.

- [ ] **Step 2: Write `index-reads.test.ts`** — COMPLETE tests for: `withIndex` equality + range returns only matching rows; the range is **half-open** (`gte(lo)` includes `lo`, `lt(hi)` excludes `hi`); results are index-ordered; an equality-only index read returns all rows for that key. Seed via `t.run` for determinism.

- [ ] **Step 3: Write `pagination.test.ts`** — COMPLETE tests for: first page returns `numItems` rows + a `continueCursor`; passing that cursor returns the next disjoint page; the final page sets `isDone: true`; a page over an empty table returns `{ page: [], isDone: true }`; the union of all pages equals the full ordered set with no dupes/gaps.

- [ ] **Step 4: Run all three.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/conformance/db-crud.test.ts test/conformance/index-reads.test.ts test/conformance/pagination.test.ts`. Expected: all PASS. (If a real semantic divergence is found, STOP and report it — a conformance failure is a finding, not a test to weaken.)

- [ ] **Step 5: Commit.** `git add packages/test && git commit -m "test(test): conformance — db-crud, index-reads, pagination"`.

---

## Task 10: Conformance — validators, ids, errors

**Files:**
- Create: `packages/test/test/conformance/validators.test.ts`, `packages/test/test/conformance/ids.test.ts`, `packages/test/test/conformance/errors.test.ts`

**Interfaces:**
- Consumes: `createTestStackbase`, `t.mutation`, `t.run`. Study (don't copy) `convex-test`'s `error.test.ts` for error-behavior enumeration.

- [ ] **Step 1: Write `validators.test.ts`** — COMPLETE tests: a schema with typed fields REJECTS a wrong-typed insert (e.g. string where `v.number()`); `v.optional` allows omission but rejects a wrong type when present; `v.union` accepts each member and rejects a non-member; `v.int64`/`v.float64`/`v.bytes` accept their runtime types (bigint/number/Uint8Array) and reject others; nested-object validation rejects a bad nested field. Each assertion uses `await expect(t.mutation(...)).rejects.toThrow()` for rejects and a passing insert for accepts. Use per-test fixture schemas defined inline.

- [ ] **Step 2: Write `ids.test.ts`** — COMPLETE tests: an inserted id round-trips through `v.id("docs")`; a `v.id("docs")` field REJECTS an id minted for a different table; `ctx.db.get` of a syntactically-invalid id string rejects (id-codec layer). (Reference existing behavior in `packages/storage/test` where cross-table id rejection is asserted.)

- [ ] **Step 3: Write `errors.test.ts`** — COMPLETE tests: an uncaught `throw new Error("boom")` in a handler surfaces as a rejection whose message contains `boom`; a not-found (`ctx.db.get` of a valid-but-absent id) returns `null` (not a throw); a validation failure rejects with a message identifying the bad field/type. Assert on message substrings, not exact strings (avoid brittleness).

- [ ] **Step 4: Run all three.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/conformance/validators.test.ts test/conformance/ids.test.ts test/conformance/errors.test.ts`. Expected: all PASS (or a reported divergence).

- [ ] **Step 5: Commit.** `git add packages/test && git commit -m "test(test): conformance — validators, ids, errors"`.

---

## Task 11: Conformance — reactivity invalidation precision

**Files:**
- Create: `packages/test/test/conformance/reactivity.test.ts`

**Interfaces:**
- Consumes: `t.subscribe`, `t.mutation`, `t.run`. This is the crown-jewel area — assert SURGICAL invalidation.

- [ ] **Step 1: Write `reactivity.test.ts`** — COMPLETE tests, each with a `waitFor` helper (as in Task 7): (1) an intersecting insert re-fires the subscription with the new row; (2) a write to a DIFFERENT index key does NOT re-fire; (3) a `patch` to a subscribed row re-fires; (4) a `delete` of a subscribed row re-fires with the row gone; (5) two subscriptions to different keys: a write to one re-fires only that one; (6) a subscription over an empty range stays empty and does not fire on an unrelated write. Use the indexed `messages`/`docs` fixture. Structure each so the "must NOT fire" assertions wait a fixed grace period then assert the change counter is unchanged.

- [ ] **Step 2: Run it.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/conformance/reactivity.test.ts`. Expected: all PASS. (A spurious re-fire or a missed invalidation is a genuine engine finding — STOP and report.)

- [ ] **Step 3: Commit.** `git add packages/test && git commit -m "test(test): conformance — reactive invalidation precision"`.

---

## Task 12: Conformance — scheduler, http-router, identity

**Files:**
- Create: `packages/test/test/conformance/scheduler.test.ts`, `packages/test/test/conformance/http-router.test.ts`, `packages/test/test/conformance/identity.test.ts`

**Interfaces:**
- Consumes: `t.finishScheduledFunctions`/`advanceTimers`, `t.fetch`, `t.withIdentity`. Compose `[defineScheduler()]` where needed.

- [ ] **Step 1: Write `scheduler.test.ts`** — COMPLETE tests: `runAfter` runs the target exactly once after `finishScheduledFunctions` (at-most-once — assert the target ran a single time); a canceled job (`ctx.scheduler.cancel`) does NOT run; `advanceTimers` before the due time does NOT run the job, after it does. Import `defineScheduler` from `@stackbase/scheduler`; mirror the fixture in Task 8.

- [ ] **Step 2: Write `http-router.test.ts`** — COMPLETE tests: an exact-path route wins over a longer prefix route for the same method; a wrong method 404s (or the router's documented behavior — confirm via `packages/executor/src/http-router.ts`); a webhook `httpAction` that calls `ctx.runMutation` commits (assert via a follow-up `t.query`); a reserved path (`/api/...`) is rejected at `route()` registration (assert `route(...)` throws). Reuse the Task 6 fixture shape.

- [ ] **Step 3: Write `identity.test.ts`** — COMPLETE tests documenting OUR model: `t.withIdentity("tokenA")` makes `ctx.identity` read `"tokenA"`; the base view reads `null`; two different identities on the same backend are independent. Add a top-of-file comment stating the divergence: Stackbase identity is a string token (resolved by the app's auth component), NOT Convex's stateless JWT-claims object — so `withIdentity` takes a string. This test file is the executable record of that documented divergence.

- [ ] **Step 4: Run all three.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/conformance/scheduler.test.ts test/conformance/http-router.test.ts test/conformance/identity.test.ts`. Expected: all PASS.

- [ ] **Step 5: Commit.** `git add packages/test && git commit -m "test(test): conformance — scheduler, http-router, identity"`.

---

## Task 13: Harness self-tests, docs, and final wiring

**Files:**
- Create: `packages/test/test/harness/isolation.test.ts`, `packages/test/README.md`, `docs/enduser/testing.md`
- Modify: `packages/test/src/index.ts` (ensure all public types exported), root docs index if one lists enduser pages.

**Interfaces:** none new — this task hardens + documents.

- [ ] **Step 1: Write `isolation.test.ts`** — COMPLETE tests: two `createTestStackbase` instances don't share data (write in one, absent in the other); `close()` leaves no active timers (create + close in a loop 20× without leak — assert it completes and a subsequent `vitest` process exit isn't blocked; a simple proxy: after `close()`, `t.query` rejects/throws a clear "closed" error OR the test just asserts no unhandled rejections); `schema: "auto"` enforces validation when a schema is present and permits arbitrary shapes when absent; a string path and the equivalent `anyApi`-proxy ref resolve to the same function (import `anyApi` from `@stackbase/client`, cast, compare results).

- [ ] **Step 2: Run it.** Run: `cd packages/test && ../../node_modules/.bin/vitest run test/harness/isolation.test.ts`. Expected: PASS. Fix any real leak found (e.g. ensure `cleanup` closes the loopback client and the docstore).

- [ ] **Step 3: Write `docs/enduser/testing.md`** — the public guide, adapted CLEAN-ROOM from concave's testing doc (rebranded; our own words). Sections: the 3-layer model table (layer 1 = `@stackbase/test`, layer 2 = the existing E2E pattern, layer 3 = cross-runtime — accurately reflect what exists); `createTestStackbase` usage (`await`, the `modules` map explicit + `import.meta.glob`); function references (typed `api.*` + `"module:fn"` strings); `t.run`; **`t.withIdentity` WITH the honest token-vs-claims note** (Stackbase identity is a string token resolved by the app's auth component, unlike Convex's claims object); `t.fetch`; **`t.subscribe` (reactivity testing — call out that this is a capability convex-test lacks)**; scheduler time control; isolation + always-`close()`; a `bun test`/vitest CI snippet. Cross-link `docs/enduser/files.md` and the deploying docs. Do NOT overclaim (no Bun-only or cross-runtime features we didn't build).

- [ ] **Step 4: Write `packages/test/README.md`** — a short package readme pointing to `docs/enduser/testing.md` and listing the public API.

- [ ] **Step 5: Full monorepo verification.** Run from repo root: `bun run build && bun run typecheck && bun run test`. Expected: all green, `@stackbase/test` included in the task list (Turborepo globs `packages/*`, so no manual wiring; confirm the package appears). Expected: `Tasks: N successful, N total` with the new package present.

- [ ] **Step 6: Commit.** `git add packages/test docs/enduser/testing.md && git commit -m "docs(test): harness self-tests + testing.md (3-layer model, honest identity note)"`.

---

## Self-Review notes (author)

- **Spec coverage:** §4 architecture → Tasks 1–2; §5 API surface → query/mutation/action (T2), run (T3), withIdentity (T5), fetch (T6), subscribe (T7), scheduler control (T8), close (T2); §6 identity divergence → T5 + T12 identity test + T13 docs; §7 conformance areas → T9–T12 (all ten areas mapped); §8 isolation/self-tests → T13; §9 docs → T13; §10 licensing → Global Constraints + reiterated in T9; §11 YAGNI boundaries → Global Constraints; always-on storage (§4) → T4.
- **Ambiguity flagged for implementers:** exact `_storage` schema-injection helper (T4), the runtime's route-install/dispatch call (T6), and the loopback bridge export (T7) each carry a `grep` pointer because the precise symbol must be confirmed against current source; these are lookups, not open design questions.
- **Conformance test depth:** T9–T12 enumerate each behavior as a concrete assertion; implementers write one `it(...)` per listed behavior following the complete examples. A conformance FAILURE is a finding to report, never a test to weaken.
