# `stackbase deploy` push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push new app code (functions + additive schema) to a running remote `stackbase serve` and apply it live, without a restart — the remote analog of `dev`'s hot reload.

**Architecture:** The CLI transpiles the app's `convex/` per-file to JS (esbuild `transform`, imports untouched) and POSTs the file tree to an opt-in `POST /_admin/deploy` on the running server. The server writes the tree under a writable dir a sibling-chain from its `node_modules` (so `@stackbase/*` resolves), reuses the existing `loadConvexDir → push` pipeline, checks the schema is additive, then atomically `setModules`/`setRoutes`/`setSchema`. Reuses `push`, `setModules`, `server.setRoutes`, and the shipped `@stackbase/*` container resolution.

**Tech Stack:** TypeScript, Bun (pkg manager + runtime), vitest (under Bun), esbuild (transpile), Turborepo. Packages touched: `@stackbase/cli`, `@stackbase/admin`, `@stackbase/runtime-embedded`.

## Global Constraints

- **Bun only.** Never `npm`/`pnpm`/`yarn`. Per-package tests: `bun run --filter <pkg> test`. Whole workspace: `bun run build && bun run typecheck && bun run test`. All green before a task's commit.
- **Live hot-swap, no restart.** Deploy reuses `dev`'s reload machinery (`loadConvexDir → push → runtime.setModules`) remotely. In-process eval of the pushed bundle is acceptable (single-tenant self-host trust); no isolate sandboxing in this slice.
- **Code + additive schema; reject destructive.** Adopt new tables + new **optional** fields with **stable tableNumbers**; reject dropped/renamed tables, changed tableNumbers, incompatible field-type changes, and required-field-adds on existing tables. **No data migrations.**
- **Opt-in endpoint.** `POST /_admin/deploy` is registered ONLY when `serve` is started with `--allow-deploy` (or `STACKBASE_ALLOW_DEPLOY=1`). When registered it is still admin-key gated (`verifyAdminKey(admin.key, bearer(authorization))`). Default = disabled.
- **Payload is `convex/` only.** The project-root `stackbase.config.ts` is NOT pushed; the component set is fixed at the server's boot. A pushed app referencing a non-booted component surfaces as a `load-error`, not a swap.
- **Atomic.** All validation (load + schema-diff) completes BEFORE the first swap call. A failed deploy leaves the previous version fully live.
- **Never leak the DB behind the adapter** and never let the engine learn which DB it's on (holds; N/A here).

---

## File Structure

- `packages/cli/src/schema-diff.ts` — **create**: pure `diffSchema(current, next)`.
- `packages/cli/src/deploy.ts` — **create**: `resolveDeployOptions`, `packageApp` (transpile tree), `deployCommand` (POST).
- `packages/cli/src/deploy-apply.ts` — **create**: `applyDeploy(deps, files)` — the server-side write→load→diff→swap.
- `packages/cli/src/load-modules.ts` — **modify**: make `loadConvexDir` extension-agnostic (`.ts` OR `.js`).
- `packages/cli/src/http-handler.ts` — **modify**: route `POST /_admin/deploy` (gated) before the generic `/_admin/*` delegation.
- `packages/cli/src/server.ts` — **modify**: `DevServerOptions.deploy?`, pass through to `handleHttpRequest` in both backends.
- `packages/cli/src/serve.ts` — **modify**: `--allow-deploy`/`STACKBASE_ALLOW_DEPLOY`, build the deploy deps, pass to the server.
- `packages/cli/src/cli.ts` — **modify**: `runCli` `case "deploy"`.
- `packages/admin/src/admin-api.ts` — **modify**: `AdminApi.setSchema(...)`.
- `packages/runtime-embedded/src/runtime.ts` — **modify**: `setTableNumbers(...)`.
- `packages/cli/package.json` — **modify**: add `esbuild` dependency.
- Tests: `packages/cli/test/schema-diff.test.ts`, `deploy-bundle.test.ts`, `deploy-apply.test.ts`, `serve-deploy.test.ts`, `deploy-e2e.test.ts`; `packages/admin/test/set-schema.test.ts`.
- Docs: `docs/enduser/deploying.md`, `CLAUDE.md`.

---

## Task 1: `diffSchema` — the additive-schema gate

**Files:**
- Create: `packages/cli/src/schema-diff.ts`
- Test: `packages/cli/test/schema-diff.test.ts`

**Interfaces:**
- Produces: `diffSchema(current: DeploySchema, next: DeploySchema): SchemaDiff` where
  `DeploySchema = { schemaJson: { tables: Record<string, { documentType: { type: string; value?: Record<string, { fieldType: { type: string }; optional: boolean }> } }> }; tableNumbers: Record<string, number> }`
  and `SchemaDiff = { ok: true } | { ok: false; reason: string }`.

- [ ] **Step 1: Write the failing test** (`packages/cli/test/schema-diff.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { diffSchema, type DeploySchema } from "../src/schema-diff";

// Minimal schema-shape builder for the test.
function schema(tables: Record<string, { num: number; fields: Record<string, { type: string; optional?: boolean }> }>): DeploySchema {
  const tableNumbers: Record<string, number> = {};
  const sj: DeploySchema["schemaJson"] = { tables: {} };
  for (const [name, t] of Object.entries(tables)) {
    tableNumbers[name] = t.num;
    const value: Record<string, { fieldType: { type: string }; optional: boolean }> = {};
    for (const [f, v] of Object.entries(t.fields)) value[f] = { fieldType: { type: v.type }, optional: !!v.optional };
    sj.tables[name] = { documentType: { type: "object", value } };
  }
  return { schemaJson: sj, tableNumbers };
}

const base = schema({ users: { num: 1, fields: { name: { type: "string" } } } });

describe("diffSchema", () => {
  it("allows an unchanged schema", () => {
    expect(diffSchema(base, base)).toEqual({ ok: true });
  });
  it("allows a new table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" } } }, posts: { num: 2, fields: { title: { type: "string" } } } });
    expect(diffSchema(base, next)).toEqual({ ok: true });
  });
  it("allows a new OPTIONAL field on an existing table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" }, nick: { type: "string", optional: true } } } });
    expect(diffSchema(base, next)).toEqual({ ok: true });
  });
  it("rejects a dropped table", () => {
    const next = schema({ posts: { num: 2, fields: { title: { type: "string" } } } });
    const r = diffSchema(base, next);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/users.*removed/i);
  });
  it("rejects a changed tableNumber", () => {
    const next = schema({ users: { num: 9, fields: { name: { type: "string" } } } });
    expect(diffSchema(base, next).ok).toBe(false);
  });
  it("rejects an incompatible field-type change (string→number)", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "number" } } } });
    expect(diffSchema(base, next).ok).toBe(false);
  });
  it("rejects a new REQUIRED field on an existing table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" }, age: { type: "number" } } } });
    const r = diffSchema(base, next);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/age.*required/i);
  });
  it("rejects a removed field on an existing table", () => {
    const twoField = schema({ users: { num: 1, fields: { name: { type: "string" }, nick: { type: "string", optional: true } } } });
    expect(diffSchema(twoField, base).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test schema-diff`
Expected: FAIL — `../src/schema-diff` has no `diffSchema`.

- [ ] **Step 3: Implement** (`packages/cli/src/schema-diff.ts`)

```ts
/**
 * The additive-schema gate for `stackbase deploy`. A deploy may add tables and add OPTIONAL fields
 * (tableNumbers must stay stable); anything destructive — a dropped/renamed table, a changed
 * tableNumber, a removed field, an incompatible field-type change, or a new REQUIRED field on an
 * existing table — is rejected so the running deployment is never left with a schema its data
 * violates. No data migrations (deferred): destructive means "reject", not "migrate".
 */
export interface ObjectFieldJSON {
  fieldType: { type: string };
  optional: boolean;
}
export interface DeploySchema {
  schemaJson: { tables: Record<string, { documentType: { type: string; value?: Record<string, ObjectFieldJSON> } }> };
  tableNumbers: Record<string, number>;
}
export type SchemaDiff = { ok: true } | { ok: false; reason: string };

function fieldsOf(s: DeploySchema, table: string): Record<string, ObjectFieldJSON> {
  return s.schemaJson.tables[table]?.documentType?.value ?? {};
}

// A field-type change is compatible only when the tag is unchanged, or the new validator widens
// (a union, or `any`). Anything else (string→number) is rejected. Over-rejection is safe — it fails
// the deploy, never corrupts data.
function compatibleType(cur: { type: string }, next: { type: string }): boolean {
  if (cur.type === next.type) return true;
  return next.type === "union" || next.type === "any" || cur.type === "any";
}

export function diffSchema(current: DeploySchema, next: DeploySchema): SchemaDiff {
  for (const name of Object.keys(current.tableNumbers)) {
    if (!(name in next.tableNumbers)) return { ok: false, reason: `table "${name}" was removed (destructive — rename/drop not supported)` };
    if (current.tableNumbers[name] !== next.tableNumbers[name])
      return { ok: false, reason: `table "${name}" tableNumber changed ${current.tableNumbers[name]}→${next.tableNumbers[name]} (destructive)` };

    const cur = fieldsOf(current, name);
    const nxt = fieldsOf(next, name);
    for (const [field, curV] of Object.entries(cur)) {
      const nxtV = nxt[field];
      if (nxtV === undefined) return { ok: false, reason: `field "${name}.${field}" was removed (destructive)` };
      if (!compatibleType(curV.fieldType, nxtV.fieldType))
        return { ok: false, reason: `field "${name}.${field}" changed type ${curV.fieldType.type}→${nxtV.fieldType.type} (destructive)` };
    }
    for (const [field, nxtV] of Object.entries(nxt)) {
      if (cur[field] === undefined && !nxtV.optional)
        return { ok: false, reason: `new required field "${name}.${field}" on existing table (destructive — existing rows lack it; make it optional)` };
    }
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/cli test schema-diff`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/schema-diff.ts packages/cli/test/schema-diff.test.ts
git commit -m "feat(cli): diffSchema — the additive-schema gate for deploy"
```

---

## Task 2: CLI packaging — `resolveDeployOptions` + `packageApp`

**Files:**
- Create: `packages/cli/src/deploy.ts` (options + packaging only this task; `deployCommand` POST lands in Task 5)
- Modify: `packages/cli/package.json` (add `esbuild`)
- Test: `packages/cli/test/deploy-bundle.test.ts`

**Interfaces:**
- Produces:
  - `resolveDeployOptions(args: string[], env: NodeJS.ProcessEnv): { url: string; convexDir: string; adminKey: string } | { error: string }` — flags `--url`/`--dir`; `url` falls back to `STACKBASE_DEPLOY_URL`; `adminKey` from `STACKBASE_ADMIN_KEY` (trimmed). Returns `{ error }` if `url` or `adminKey` missing/blank.
  - `packageApp(convexDir: string): Promise<Array<{ path: string; code: string }>>` — recursively transpiles every `.ts` (excluding `.d.ts`) under `convexDir` to JS via esbuild `transform` (imports untouched), returning entries whose `path` is the POSIX relative path with `.ts`→`.js` (e.g. `schema.js`, `messages.js`, `_generated/server.js`).

- [ ] **Step 1: Add esbuild + write the failing test**

Add to `packages/cli/package.json` `dependencies`: `"esbuild": "catalog:"` if a catalog entry exists, else a concrete version (check `bun pm ls esbuild` / the root `package.json` catalog; esbuild is already in the tree via tsup — match its version). Then:

```ts
// packages/cli/test/deploy-bundle.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDeployOptions, packageApp } from "../src/deploy";

describe("resolveDeployOptions", () => {
  it("resolves --url + STACKBASE_ADMIN_KEY", () => {
    const r = resolveDeployOptions(["--url", "http://x:1"], { STACKBASE_ADMIN_KEY: "k" } as NodeJS.ProcessEnv);
    expect(r).toEqual({ url: "http://x:1", convexDir: "convex", adminKey: "k" });
  });
  it("falls back to STACKBASE_DEPLOY_URL", () => {
    const r = resolveDeployOptions([], { STACKBASE_ADMIN_KEY: "k", STACKBASE_DEPLOY_URL: "http://y:2" } as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ url: "http://y:2" });
  });
  it("errors on missing url", () => {
    expect(resolveDeployOptions([], { STACKBASE_ADMIN_KEY: "k" } as NodeJS.ProcessEnv)).toHaveProperty("error");
  });
  it("errors on missing/blank admin key", () => {
    expect(resolveDeployOptions(["--url", "http://x:1"], { STACKBASE_ADMIN_KEY: "  " } as NodeJS.ProcessEnv)).toHaveProperty("error");
  });
});

describe("packageApp", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pkg-"));
    writeFileSync(join(dir, "schema.ts"), `import { defineSchema } from "@stackbase/values";\nexport default defineSchema({});\nconst x: number = 1; void x;\n`);
    writeFileSync(join(dir, "messages.ts"), `import { query } from "./_generated/server";\nexport const list = query({ handler: () => [] });\n`);
    mkdirSync(join(dir, "_generated"));
    writeFileSync(join(dir, "_generated", "server.ts"), `export { query } from "@stackbase/executor";\n`);
    writeFileSync(join(dir, "_generated", "api.d.ts"), `export type API = unknown;\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("transpiles every .ts (not .d.ts) preserving the tree, imports untouched", async () => {
    const files = await packageApp(dir);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.code]));
    expect(Object.keys(byPath).sort()).toEqual(["_generated/server.js", "messages.js", "schema.js"]);
    // TS types stripped, but bare + relative imports pass through verbatim (external — resolved on the remote).
    expect(byPath["schema.js"]).toMatch(/@stackbase\/values/);
    expect(byPath["schema.js"]).not.toMatch(/: number/);
    expect(byPath["messages.js"]).toMatch(/\.\/_generated\/server/);
    expect(byPath["_generated/server.js"]).toMatch(/@stackbase\/executor/);
  });
});
```

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test deploy-bundle`
Expected: FAIL — `../src/deploy` missing.

- [ ] **Step 3: Implement `deploy.ts` (options + packageApp only)**

```ts
// packages/cli/src/deploy.ts
/**
 * `stackbase deploy` — push the local convex/ to a running remote `serve` and apply it live.
 * This module: resolve options, transpile the app to a transferable JS file tree. The POST that
 * ships it (`deployCommand`) is added once the endpoint exists.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";

export interface DeployOptions {
  url: string;
  convexDir: string;
  adminKey: string;
}

export function resolveDeployOptions(args: string[], env: NodeJS.ProcessEnv): DeployOptions | { error: string } {
  let url = env.STACKBASE_DEPLOY_URL?.trim() ?? "";
  let convexDir = "convex";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) url = args[++i];
    else if (args[i] === "--dir" && args[i + 1]) convexDir = args[++i];
  }
  const adminKey = env.STACKBASE_ADMIN_KEY?.trim() ?? "";
  if (!url) return { error: "missing target URL — pass --url <url> or set STACKBASE_DEPLOY_URL" };
  if (!adminKey) return { error: "STACKBASE_ADMIN_KEY is required to deploy" };
  return { url, convexDir, adminKey };
}

function walkTs(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(root, abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(abs);
  }
}

export async function packageApp(convexDir: string): Promise<Array<{ path: string; code: string }>> {
  const absFiles: string[] = [];
  walkTs(convexDir, convexDir, absFiles);
  const out: Array<{ path: string; code: string }> = [];
  for (const abs of absFiles) {
    const source = readFileSync(abs, "utf8");
    // `transform` strips TS types and leaves import specifiers untouched — bare `@stackbase/*`
    // resolve from the remote's node_modules; relative imports resolve within the pushed tree.
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
    const rel = relative(convexDir, abs).split(sep).join("/").replace(/\.ts$/, ".js");
    out.push({ path: rel, code });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
```

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/cli test deploy-bundle`
Expected: PASS. Also `bun run --filter @stackbase/cli typecheck` (esbuild types resolve).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deploy.ts packages/cli/test/deploy-bundle.test.ts packages/cli/package.json
git commit -m "feat(cli): deploy packaging — resolveDeployOptions + packageApp (esbuild transpile)"
```

---

## Task 3: Enabling seams — ext-agnostic loader, `AdminApi.setSchema`, `runtime.setTableNumbers`

**Files:**
- Modify: `packages/cli/src/load-modules.ts` (accept `.js` as well as `.ts`)
- Modify: `packages/admin/src/admin-api.ts` (`setSchema`)
- Modify: `packages/runtime-embedded/src/runtime.ts` (`setTableNumbers`)
- Test: `packages/admin/test/set-schema.test.ts`, and extend an existing loader test or add `packages/cli/test/load-js.test.ts`

**Interfaces:**
- Produces:
  - `loadConvexDir(dir)` — unchanged signature, now loads `schema.{ts,js}` and `.ts`/`.js` modules (prefers `.ts` when both exist, for dev).
  - `AdminApi.setSchema(schemaJson, tableNumbers, manifest): void` — swaps the deps the browser/validation read.
  - `AdminApi.getSchema(): { schemaJson; tableNumbers }` — the live schema/tableNumbers, so a deploy can diff against what's actually running (single source of truth that `setSchema` updates).
  - `EmbeddedRuntime.setTableNumbers(tableNumbers: Record<string, number>): void` — rebuilds the tableNumber→name map used by driver commit fan-out.
- Consumes (in Task 4): all three.

- [ ] **Step 1: Write failing tests**

`packages/admin/test/set-schema.test.ts` — construct an `AdminApi` (mirror an existing admin test's construction of `AdminDeps`), call `setSchema` with a new schema + tableNumbers + manifest, and assert a subsequent `listTables()`/schema read reflects the new table. (Copy the `AdminDeps` fixture from a sibling admin test; grep `new AdminApi(` in `packages/admin/test`.)

```ts
// packages/admin/test/set-schema.test.ts — shape; adapt deps to the sibling fixture
import { describe, it, expect } from "vitest";
import { AdminApi } from "../src/admin-api";
// ...build deps with tableNumbers {a:1}, schemaJson with table "a"...
it("setSchema swaps schema + tableNumbers so new tables become visible", () => {
  const api = new AdminApi(deps);                 // deps has only table "a"
  api.setSchema({ tables: { a: deps.schemaJson.tables.a, b: /* new table def */ } } as any, { a: 1, b: 2 }, deps.manifest);
  // a schema/table listing now includes "b"
  // (assert via whatever read method the sibling test uses, e.g. api.listTables())
});
```

For the loader: add `packages/cli/test/load-js.test.ts` — write a temp dir with `schema.js` + `foo.js` (plain JS defining a query), call `loadConvexDir`, assert the module + schema load. (Model on how the existing project/e2e tests build a fixture dir; the point is `.js` files load.)

- [ ] **Step 2: Run — verify they fail**

Run: `bun run --filter @stackbase/admin test set-schema` and `bun run --filter @stackbase/cli test load-js`
Expected: FAIL (`setSchema` missing; loader ignores `.js`).

- [ ] **Step 3a: Make `loadConvexDir` extension-agnostic** (`packages/cli/src/load-modules.ts`)

```ts
import { readdirSync, existsSync } from "node:fs";
// ...
export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const isModule = (f: string) =>
    (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts") && !f.startsWith("_") &&
    f !== "schema.ts" && f !== "schema.js";
  const entries = readdirSync(absDir).filter(isModule);

  const schemaFile = existsSync(join(absDir, "schema.ts")) ? "schema.ts" : "schema.js";
  const schemaModule = (await import(pathToFileURL(join(absDir, schemaFile)).href + CACHE_BUST())) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const path = file.replace(/\.(ts|js)$/, "");
    modules[path] = (await import(pathToFileURL(join(absDir, file)).href + CACHE_BUST())) as Record<string, unknown>;
  }
  return { schema: schemaModule.default, modules };
}
```
> Keep the existing doc-comment; `basename(file, ".ts")` is replaced by the regex strip so a module can be `.ts` or `.js`. Verify existing dev/e2e loader tests still pass (they use `.ts`).

- [ ] **Step 3b: `AdminApi.setSchema`** (`packages/admin/src/admin-api.ts`)

The class is `constructor(private readonly deps: AdminDeps) {}`; `deps` fields (`schemaJson`, `tableNumbers`, `manifest`) are not `readonly`, so mutate them, and add a getter so a deploy can read the live schema:
```ts
  /** Swap the schema/tableNumbers/manifest the data browser + validation read — after a live deploy. */
  setSchema(schemaJson: AdminDeps["schemaJson"], tableNumbers: Record<string, number>, manifest: AdminDeps["manifest"]): void {
    this.deps.schemaJson = schemaJson;
    this.deps.tableNumbers = tableNumbers;
    this.deps.manifest = manifest;
  }

  /** The live schema + tableNumbers — a deploy diffs its new schema against this. */
  getSchema(): { schemaJson: AdminDeps["schemaJson"]; tableNumbers: Record<string, number> } {
    return { schemaJson: this.deps.schemaJson, tableNumbers: this.deps.tableNumbers };
  }
```
> If TS complains the `deps` fields are `readonly`, drop `readonly` on those three fields in the `AdminDeps` interface (they were only incidentally immutable). Add a `getSchema` assertion to the test.

- [ ] **Step 3c: `runtime.setTableNumbers`** (`packages/runtime-embedded/src/runtime.ts`)

The ctor builds `tableNumberToName` from `options.tableNumbers` (around line 269–275). Extract that into a method and call it from both the ctor and the new setter:
```ts
  /** Rebuild the tableNumber→name map after an additive deploy so driver commit fan-out stays correct. */
  setTableNumbers(tableNumbers: Record<string, number>): void {
    this.tableNumberToName.clear();
    for (const [name, num] of Object.entries(tableNumbers)) this.tableNumberToName.set(num, name);
  }
```
> Make `tableNumberToName` a mutable instance field the ctor also populates (or have the ctor call `setTableNumbers(options.tableNumbers ?? {})`). Additive deploys keep existing numbers, so this only ever adds entries.

- [ ] **Step 4: Run — verify passes + no regressions**

Run: `bun run --filter @stackbase/admin test`, `bun run --filter @stackbase/cli test`, `bun run --filter @stackbase/runtime-embedded test`
Expected: new tests PASS; all existing PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/load-modules.ts packages/admin/src/admin-api.ts packages/runtime-embedded/src/runtime.ts packages/admin/test/set-schema.test.ts packages/cli/test/load-js.test.ts
git commit -m "feat: deploy enabling seams — .js loader, AdminApi.setSchema, runtime.setTableNumbers"
```

---

## Task 4: `applyDeploy` + server/handler wiring

**Files:**
- Create: `packages/cli/src/deploy-apply.ts`
- Modify: `packages/cli/src/http-handler.ts` (route `POST /_admin/deploy`), `packages/cli/src/server.ts` (`DevServerOptions.deploy`)
- Test: `packages/cli/test/deploy-apply.test.ts`

**Interfaces:**
- Consumes: `diffSchema` (Task 1), `loadConvexDir` (Task 3), `push` (`./push-pipeline`), `AdminApi.setSchema`/`runtime.setModules`/`runtime.setTableNumbers` (Task 3), `verifyAdminKey` (`@stackbase/admin`).
- Produces:
  - `applyDeploy(deps: DeployDeps, files: Array<{ path: string; code: string }>): Promise<DeployResult>` where
    `DeployDeps = { runtime: EmbeddedRuntime; adminApi: AdminApi; setRoutes: (r: ResolvedRoute[]) => void; components: ComponentDefinition[]; current: () => { schemaJson: unknown; tableNumbers: Record<string, number> }; deployRoot: string }`
    and `DeployResult = { ok: true; rev: string; functions: number } | { ok: false; kind: "load-error" | "schema-incompatible"; error: string }`.
  - `DevServerOptions.deploy?: { allowDeploy: true; apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> }` — present only when deploy is enabled.

- [ ] **Step 1: Write the failing test** (`packages/cli/test/deploy-apply.test.ts`)

Build a fixture `convex/` v1 (a `schema.ts` with one table + one query) under a dir where `@stackbase/*` resolves (put it under `packages/cli/test/fixtures/…` or `mkdtemp` inside `packages/cli`). Construct a real `EmbeddedRuntime` + `AdminApi` on that v1 (reuse the `bootProject`/fixture helpers a sibling e2e test uses). Then:

```ts
// core assertions
// 1. applyDeploy with a valid additive v2 (adds a mutation + optional field) → {ok:true}; the new fn is in runtime after.
// 2. applyDeploy with a file that throws on import → {ok:false, kind:"load-error"}; the OLD moduleMap still serves (runtime.run of v1 fn still works).
// 3. applyDeploy with a destructive schema (drop the v1 table) → {ok:false, kind:"schema-incompatible"}; no swap.
```
Use `packageApp` (Task 2) to produce the `files` from a v2 fixture dir, so the test exercises the real transpile→apply path. `deployRoot` = a temp dir created UNDER `packages/cli` (so the written tree resolves `@stackbase/*` via the package's nested `node_modules`).

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test deploy-apply`
Expected: FAIL — `../src/deploy-apply` missing.

- [ ] **Step 3: Implement `deploy-apply.ts`**

```ts
// packages/cli/src/deploy-apply.ts
/**
 * Server-side apply for `stackbase deploy`: write the pushed tree under a writable dir a sibling
 * chain from the engine's node_modules (so `@stackbase/*` resolves), reuse loadConvexDir → push,
 * gate on an additive-schema diff, then ATOMICALLY swap modules/routes/schema. All validation
 * happens before the first swap, so a rejected deploy leaves the running version fully live.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { AdminApi } from "@stackbase/admin";
import type { ComponentDefinition } from "@stackbase/component";
import { loadConvexDir } from "./load-modules";
import { push } from "./push-pipeline";
import { diffSchema, type DeploySchema } from "./schema-diff";
import type { ResolvedRoute } from "./project";

export interface DeployDeps {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  setRoutes: (routes: ResolvedRoute[]) => void;
  components: ComponentDefinition[];
  current: () => { schemaJson: DeploySchema["schemaJson"]; tableNumbers: Record<string, number> };
  deployRoot: string;
}
export type DeployResult =
  | { ok: true; rev: string; functions: number }
  | { ok: false; kind: "load-error" | "schema-incompatible"; error: string };

export async function applyDeploy(deps: DeployDeps, files: Array<{ path: string; code: string }>): Promise<DeployResult> {
  const rev = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  const dir = join(deps.deployRoot, rev, "convex");
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.code);
  }

  let project;
  try {
    const loaded = await loadConvexDir(dir);
    project = push(loaded, deps.components).project;
  } catch (e) {
    return { ok: false, kind: "load-error", error: e instanceof Error ? e.message : String(e) };
  }

  const diff = diffSchema(
    deps.current(),
    { schemaJson: project.schemaJson as DeploySchema["schemaJson"], tableNumbers: project.tableNumbers },
  );
  if (!diff.ok) return { ok: false, kind: "schema-incompatible", error: diff.reason };

  // Atomic swap — only reached after load + diff succeed.
  deps.runtime.setModules(project.moduleMap);
  deps.runtime.setTableNumbers(project.tableNumbers);
  deps.setRoutes(project.routes);
  deps.adminApi.setSchema(project.schemaJson, project.tableNumbers, project.manifest);
  return { ok: true, rev, functions: Object.keys(project.moduleMap).length };
}
```
> Confirm `push(...).project` exposes `schemaJson`, `tableNumbers`, `moduleMap`, `routes`, `manifest` (it does — `ProjectArtifacts`). If `routes` is named differently, match `project.ts`.

- [ ] **Step 3b: Route `POST /_admin/deploy` in `handleHttpRequest`** (`packages/cli/src/http-handler.ts`)

Add a `deploy` param and handle it BEFORE the generic `/_admin/` delegation:
```ts
import { handleAdminRequest, verifyAdminKey, type AdminApi } from "@stackbase/admin";
import type { DeployResult } from "./deploy-apply";

function bearer(authorization?: string): string | undefined {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  return m ? m[1] : undefined;
}

export async function handleHttpRequest(
  runtime: EmbeddedRuntime,
  req: HttpRequest,
  info: ServerInfo,
  admin?: { api: AdminApi; key: string },
  routes?: ResolvedRoute[],
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> },
): Promise<HttpResponse> {
  if (admin && deploy && req.method === "POST" && req.path === "/_admin/deploy") {
    if (!verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { ok: false, error: "unauthorized" });
    let files: Array<{ path: string; code: string }>;
    try {
      files = (JSON.parse(req.body ?? "{}") as { files?: Array<{ path: string; code: string }> }).files ?? [];
    } catch {
      return json(400, { ok: false, kind: "load-error", error: "invalid deploy payload" });
    }
    const result = await deploy.apply(files);
    return json(result.ok ? 200 : result.kind === "schema-incompatible" ? 409 : 400, result);
  }
  if (admin && req.path.startsWith("/_admin/")) {
    // ...existing delegation unchanged...
  }
  // ...rest unchanged...
}
```
> `verifyAdminKey` is exported from `@stackbase/admin`. The endpoint is reachable only when the server passes a `deploy` object (i.e. `--allow-deploy`); otherwise this branch is skipped and `/_admin/deploy` falls through to `handleAdminRequest` → its normal 404.

- [ ] **Step 3c: Thread `deploy` through the server** (`packages/cli/src/server.ts`)

Add to `DevServerOptions`: `deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> };`. In BOTH `startNodeServer` and `startBunServer`, pass `options.deploy` as the new 6th arg to `handleHttpRequest(runtime, req, info, options.admin, currentRoutes, options.deploy)`. (Both call sites currently pass `options.admin, currentRoutes`.)

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/cli test deploy-apply` then `bun run --filter @stackbase/cli test` (no regressions).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/deploy-apply.ts packages/cli/src/http-handler.ts packages/cli/src/server.ts packages/cli/test/deploy-apply.test.ts
git commit -m "feat(cli): applyDeploy (write→load→diff→atomic swap) + /_admin/deploy route wiring"
```

---

## Task 5: `serve --allow-deploy` + `deploy` command dispatch

**Files:**
- Modify: `packages/cli/src/serve.ts` (`--allow-deploy` → build deploy deps → pass to server), `packages/cli/src/deploy.ts` (`deployCommand` POST), `packages/cli/src/cli.ts` (`runCli` `case "deploy"`)
- Test: `packages/cli/test/serve-deploy.test.ts`

**Interfaces:**
- Consumes: `applyDeploy`/`DeployDeps` (Task 4), `startServe`/`bootProject` (existing), `resolveDeployOptions`/`packageApp` (Task 2).
- Produces: `deployCommand(args: string[]): Promise<number>`; `serve` accepts `--allow-deploy`.

- [ ] **Step 1: Write the failing test** (`packages/cli/test/serve-deploy.test.ts`)

```ts
// Assert:
// (a) resolveServeOptions parses --allow-deploy and STACKBASE_ALLOW_DEPLOY=1 → allowDeploy:true; default false.
// (b) startServe WITHOUT allow-deploy: POST /_admin/deploy (admin key) → 404/not-registered behavior
//     (falls through to admin router 404), proving the endpoint is off by default.
// (c) startServe WITH allow-deploy: the server's handleHttpRequest is passed a deploy object
//     (assert via a real POST returning a deploy-shaped response, not a generic 404).
// Use the startServe fixture harness from serve.test.ts / serve-e2e.test.ts.
```
> The full happy-path deploy is proven in Task 6's E2E; here assert the flag plumbing + the default-off gate.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test serve-deploy`
Expected: FAIL.

- [ ] **Step 3a: `bootProject` surfaces the component set** (`packages/cli/src/boot.ts`)

`applyDeploy` calls `push(loaded, components)` and so needs the boot-time `ComponentDefinition[]`. `bootProject` already calls `loadConfig` internally but does not return its `components`. Add `components` to `BootResult` and set it from the loaded config:
```ts
export interface BootResult { /* ...existing... */ components: ComponentDefinition[]; }
// in bootProject, where `const config = await loadConfig(...)` runs:
return { /* ...existing... */, components: config.components };
```
(Import `ComponentDefinition` from `@stackbase/component`.)

- [ ] **Step 3b: `serve --allow-deploy`** (`packages/cli/src/serve.ts`)

Add to `ServeOptions`: `allowDeploy: boolean`. In `resolveServeOptions`: `let allowDeploy = process.env.STACKBASE_ALLOW_DEPLOY === "1";` and in the flag loop `else if (a === "--allow-deploy") allowDeploy = true;`. In `startServe`, after `bootProject(...)` returns `{ runtime, adminApi, project, store, components }`, wire deploy with a mutable `server` binding (so `setRoutes` can close over it) and read the live schema from `adminApi.getSchema()` (single source of truth — no serve-side bookkeeping):
```ts
import { applyDeploy } from "./deploy-apply";
// ...
let server: DevServer;
const deploy = opts.allowDeploy
  ? {
      apply: (files: Array<{ path: string; code: string }>) =>
        applyDeploy(
          {
            runtime,
            adminApi,
            setRoutes: (r) => server.setRoutes(r),
            components,                               // boot-time component set (from bootProject)
            current: () => adminApi.getSchema(),      // applyDeploy's setSchema keeps this live
            deployRoot: join(process.cwd(), ".stackbase-deploy"),
          },
          files,
        ),
    }
  : undefined;
server = await startDevServer(
  runtime,
  { functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) },
  { port: opts.port, ip: opts.ip, admin: { api: adminApi, key: opts.adminKey }, dashboard, routes: project.routes, deploy },
);
return { server, store, runtime };
```
> `let server: DevServer;` is assigned by the `await startDevServer(...)` call; the `setRoutes` closure runs only on a later deploy request, by which time `server` is assigned. Import `join` from `node:path` and `DevServer` from `./server`.

- [ ] **Step 3c: `deployCommand` POST** (`packages/cli/src/deploy.ts`)

```ts
export async function deployCommand(args: string[]): Promise<number> {
  const opts = resolveDeployOptions(args, process.env);
  if ("error" in opts) { process.stderr.write(`✗ ${opts.error}\n`); return 1; }
  // Refresh local _generated so the client's typed API matches what we deploy.
  // (reuse the same load+push+writeGenerated the codegen command uses; see cli.ts codegenCommand)
  const files = await packageApp(join(opts.convexDir));
  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/$/, "")}/_admin/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.adminKey}` },
      body: JSON.stringify({ files }),
    });
  } catch (e) {
    process.stderr.write(`✗ could not reach ${opts.url}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; error?: string };
  if (res.status === 404) { process.stderr.write("✗ deploy not enabled on target (start serve with --allow-deploy)\n"); return 1; }
  if (!res.ok || !body.ok) { process.stderr.write(`✗ deploy failed: ${body.error ?? res.statusText}\n`); return 1; }
  process.stdout.write(`✓ deployed rev ${body.rev} (${body.functions} functions)\n`);
  return 0;
}
```
> Also run the local codegen refresh (mirror `codegenCommand`: `loadConvexDir` + `push` + `writeGenerated` into `<convexDir>/_generated`) before `packageApp`, so the pushed `_generated/` and the client types are current. Keep it DRY — call the same helper `codegenCommand` uses if one exists.

- [ ] **Step 3d: Dispatch** (`packages/cli/src/cli.ts`)

`runCli`: add `case "deploy": return deployCommand(rest);` (import from `./deploy`) and a `deploy` line in `printHelp`.

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/cli test serve-deploy` then `bun run build && bun run typecheck && bun run test`.
Expected: PASS + workspace green.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve.ts packages/cli/src/deploy.ts packages/cli/src/cli.ts packages/cli/test/serve-deploy.test.ts
git commit -m "feat(cli): serve --allow-deploy + stackbase deploy command (POST + dispatch)"
```

---

## Task 6: Deploy E2E through the real server + docs

**Files:**
- Test: `packages/cli/test/deploy-e2e.test.ts`
- Docs: `docs/enduser/deploying.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the whole slice (`startServe --allow-deploy`, `deployCommand`).

- [ ] **Step 1: Write the failing E2E** (`packages/cli/test/deploy-e2e.test.ts`)

Mirror `serve-e2e.test.ts`/`http-action-e2e.test.ts`. Two app fixtures under `packages/cli/test/fixtures/deploy-v1` and `deploy-v2` (both with committed `_generated/`, resolvable `@stackbase/*`): v1 = a `notes` table (`box`,`text`) + `notes:list` query; v2 = adds a `notes:add` mutation + an additive optional field. A third fixture `deploy-bad` drops the `notes` table (destructive).

```ts
// 1. startServe({ ...fixture: v1, allowDeploy:true, dashboard:false, adminKey:"k" }).
// 2. WS subscribe to notes:list -> [].
// 3. Run the REAL deployCommand against the running server (STACKBASE_ADMIN_KEY="k", --url server.url, --dir v2)
//    -> exit 0.
// 4. POST /api/run notes:add -> committed; assert the WS subscription pushes the new row
//    (new mutation is live AND its write fans out reactively across a live deploy).
// 5. Run deployCommand with --dir deploy-bad -> exit 1; assert notes:list still works (v2 stays live).
// 6. Start a SECOND server WITHOUT allowDeploy; deployCommand against it -> exit 1 with the not-enabled message.
```
Set `STACKBASE_ADMIN_KEY` in `process.env` for the deploy calls (restore in `afterEach`). Use an OS-assigned/free port. Subscribe event-drivenly to observe the fan-out (per the harness note).

- [ ] **Step 2: Run — verify it fails, then passes**

Run: `bun run --filter @stackbase/cli test deploy-e2e`
Expected: FAIL first (fixtures/wiring), then PASS. Root-cause any real gap (e.g. `@stackbase/*` not resolving under `deployRoot` — ensure `deployRoot` is under a dir with resolvable `node_modules`, matching how the container places it under `/app`).

- [ ] **Step 3: Write `docs/enduser/deploying.md`**

Cover: what `stackbase deploy` does (push functions + additive schema to a running deployment, live, no restart); enabling it (`serve --allow-deploy` / `STACKBASE_ALLOW_DEPLOY=1`, and WHY it's opt-in — a leaked admin key shouldn't be code-exec); usage (`STACKBASE_ADMIN_KEY=… stackbase deploy --url https://myapp.example`); the additive-only schema rule + that destructive changes are rejected (no migrations yet); that the component set is fixed at boot (adding scheduler/workflow needs a restart); reuse the TLS/reverse-proxy note. Link from `self-hosting.md`.

- [ ] **Step 4: Update `CLAUDE.md`**

Move `stackbase deploy` push from deferred → shipped: slice 6b done (live hot-swap push to a running `serve`, opt-in `--allow-deploy`, additive schema with destructive-reject, atomic swap, E2E through the real server). Keep 6c (Postgres adapter) deferred. Update build-order item 6 status.

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add packages/cli/test/deploy-e2e.test.ts packages/cli/test/fixtures docs/enduser/deploying.md CLAUDE.md
git commit -m "test(cli): deploy E2E through real serve (v1→v2 live, destructive-reject, opt-in gate) + docs"
```

---

## Notes for the executor

- **DRY:** the remote reuses `loadConvexDir → push` and `setModules`/`setRoutes` — do NOT reimplement loading or a bundler. `packageApp` uses esbuild `transform` (no bundling), so imports pass through and `@stackbase/*` resolves on the remote exactly as the 6a bind-mount/bake paths do.
- **YAGNI:** no migrations, no rollback command, no deploy-config file, no component-set changes, no isolate sandbox (see spec §9).
- **The load-bearing gate is Task 6** — the E2E proves a live deploy hot-swaps functions AND its writes still fan out reactively, plus the two rejections (destructive schema, `--allow-deploy` off). Do not weaken it.
- **Resolution reminder (from 6a):** the pushed tree must be written where `@stackbase/*` resolves — under `/app` in the container (cwd is `/app`, which has the `node_modules/@stackbase` symlinks), and under a workspace package dir in tests. `deployRoot = join(process.cwd(), ".stackbase-deploy")` achieves the container case; the E2E overrides it to a resolvable temp dir.
- **Atomicity:** `applyDeploy` must complete load + `diffSchema` before the first `setModules`. Never swap partially.
