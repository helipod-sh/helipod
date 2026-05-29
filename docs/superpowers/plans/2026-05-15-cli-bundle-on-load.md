# CLI Bundle-on-Load Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `loadConvexDir` load an app's `convex/` tree by esbuild-bundling each module before importing it, so the conventional extensionless `./_generated/server` imports resolve identically under Bun and plain Node (fixing `ERR_MODULE_NOT_FOUND` under Node).

**Architecture:** Replace the bare dynamic `import()` in `packages/cli/src/load-modules.ts` with a bundle-then-import step: `esbuild.build({ bundle: true, packages: "external" })` inlines the relative graph (resolving extensionless + `.ts` the bundler way) while keeping bare `@stackbase/*` imports external; write the bundled ESM under `node_modules/.cache/stackbase/` (so those externals resolve) and `import()` it with a `?t=` cache-bust (preserving hot-reload).

**Tech Stack:** TypeScript (ESM), `esbuild` (already a `@stackbase/cli` dep, `^0.27.0`), `vitest`, Node/Bun.

## Global Constraints

- **Only `packages/cli/src/load-modules.ts` changes** — all 10 `loadConvexDir` callers (`dev`/`serve`/`codegen`/`build`/`deploy`/`migrate`/…) are untouched and benefit through the one chokepoint. `loadConvexDir`'s signature (`(dir: string) => Promise<LoadedProject>`) and return shape (`{ schema, modules }`) are unchanged.
- **esbuild config exactly:** `{ entryPoints: [file], bundle: true, packages: "external", format: "esm", platform: "node", write: false, sourcemap: "inline", logLevel: "silent" }`. `packages: "external"` is load-bearing — it keeps `@stackbase/executor`/`@stackbase/client`/`@stackbase/values` (and any user npm dep) as live runtime imports so the engine's singletons keep identity.
- **Cache location:** `<nearest-node_modules-ancestor>/node_modules/.cache/stackbase/<sanitized-key>.mjs`. The file MUST sit under a `node_modules` so its external bare imports resolve via Node's ancestor walk. Sanitize the module key (`/`→`__`) to flat filenames.
- **Preserve hot-reload:** `import(pathToFileURL(cacheFile).href + "?t=" + Date.now())`.
- **Existing tests stay green** — `boot-loaded`, `load-js`, `load-project-components` (their fixtures import `@stackbase/executor` directly; bundling those is a functional passthrough) and the deploy/build/serve serial E2Es.
- **Out of scope (do NOT implement):** the "exit-0 on a genuine load error" loud-failure fix (separate follow-on); esbuild multi-entry batching (per-module is fine).
- Two test lanes: fast (`*.test.ts`) and serial E2E (`*-e2e.test.ts`). Run `bun run --filter @stackbase/cli build` on the load-modules change (not just test+typecheck).

---

## File Structure

- **Modify:** `packages/cli/src/load-modules.ts` — add `resolveCacheDir` + `bundleAndImport`; `loadConvexDir` calls `bundleAndImport` instead of bare `import()`.
- **New fixture:** `packages/cli/test/fixtures/conventional-app/convex/{schema.ts, notes.ts, _generated/*}` — `notes.ts` uses `import { query, mutation } from "./_generated/server"` (the shape the existing fixtures avoid).
- **New test:** `packages/cli/test/load-modules-conventional.test.ts` (fast lane).
- **New E2E:** `packages/cli/test/node-load-e2e.test.ts` (serial lane) — the reproduce-then-pass under real Node.

---

### Task 1: The `conventional-app` fixture + the failing unit test

**Files:**
- Create: `packages/cli/test/fixtures/conventional-app/convex/schema.ts`, `.../notes.ts`, and `.../_generated/{server.ts,dataModel.d.ts,api.d.ts,internal.d.ts,ids.ts}`
- Test: `packages/cli/test/load-modules-conventional.test.ts`

**Interfaces:**
- Consumes: `loadConvexDir(dir: string): Promise<{ schema; modules: Record<string, Record<string, unknown>> }>` (existing).

- [ ] **Step 1: Copy the proven `_generated/` + `schema.ts` from the `deploy-v2` fixture**

```bash
mkdir -p packages/cli/test/fixtures/conventional-app/convex
cp -R packages/cli/test/fixtures/deploy-v2/convex/_generated packages/cli/test/fixtures/conventional-app/convex/_generated
cp packages/cli/test/fixtures/deploy-v2/convex/schema.ts packages/cli/test/fixtures/conventional-app/convex/schema.ts
```

(`deploy-v2/_generated/server.ts` re-exports `query, mutation, action, httpAction, httpRouter` from `@stackbase/executor` at runtime — exactly what the conventional import needs. `schema.ts` defines a `notes` table with a `by_box` index.)

- [ ] **Step 2: Create `packages/cli/test/fixtures/conventional-app/convex/notes.ts`** — the ONLY hand-written file; it uses the conventional `./_generated/server` import (this is the shape `deploy-v2/notes.ts` deliberately avoided by importing `@stackbase/executor` directly):

```ts
import { query, mutation } from "./_generated/server";

// The conventional Convex/Stackbase authoring shape — value imports from ./_generated/server
// (extensionless). This is what real apps + every example use, and what fails under Node's ESM
// resolver with bare import(). loadConvexDir only IMPORTS this module (to read its exports); the
// handlers are never executed here.
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })),
});

export const add = mutation({
  handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }),
});
```

- [ ] **Step 3: Write the unit test `packages/cli/test/load-modules-conventional.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadConvexDir } from "../src/load-modules";

describe("loadConvexDir — conventional ./_generated/server imports", () => {
  it("loads a module that value-imports { query, mutation } from ./_generated/server", async () => {
    const loaded = await loadConvexDir("test/fixtures/conventional-app/convex");
    expect(loaded.schema).toBeTruthy(); // schema default export resolved
    // The notes module's exports are present — proving the extensionless ./_generated/server value
    // import resolved (query/mutation are the executor-built function definitions).
    expect(loaded.modules["notes"]).toBeTruthy();
    expect(loaded.modules["notes"]!.list).toBeTruthy();
    expect(loaded.modules["notes"]!.add).toBeTruthy();
  });
});
```

- [ ] **Step 4: Run the unit test under the CURRENT (unfixed) loader**

Run: `bun run --filter @stackbase/cli test load-modules-conventional`
Expected: **FAIL** with `ERR_MODULE_NOT_FOUND` resolving `./_generated/server` (the bare-`import()` bug). 
**If it unexpectedly PASSES** (vitest's own module loader can mask the native-import divergence in-process), that is acceptable — record it in the report; the Task 3 **Node E2E is the authoritative reproduce-then-pass**, and this unit test still serves as a fast-lane regression guard after the fix. Do not fake a failure.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/fixtures/conventional-app packages/cli/test/load-modules-conventional.test.ts
git commit -m "test(cli): conventional-app fixture using ./_generated/server + failing load test"
```

---

### Task 2: Bundle-on-load in `load-modules.ts`

**Files:**
- Modify: `packages/cli/src/load-modules.ts`

**Interfaces:**
- Produces: unchanged `loadConvexDir(dir): Promise<LoadedProject>`; new internal `resolveCacheDir(startDir): string`, `bundleAndImport(file, key, cacheDir): Promise<Record<string, unknown>>`.

- [ ] **Step 1: Rewrite `packages/cli/src/load-modules.ts`** (keep `moduleKeyForFile` + `listConvexModuleFiles` exactly as-is; replace the imports block and `loadConvexDir`, add the two helpers):

```ts
/**
 * Load a `convex/` directory: esbuild-BUNDLE each module (schema + function files) then import the
 * bundle. Bundling resolves relative imports (incl. the conventional extensionless `./_generated/*`
 * value imports every app uses) at bundle time, identically on Bun / Node / any ESM runtime — so
 * loading no longer depends on the runtime's own resolver (plain Node's ESM rejects extensionless
 * specifiers with ERR_MODULE_NOT_FOUND; Bun accepts them). Bare deps (`@stackbase/*`, user npm
 * packages) stay EXTERNAL (`packages: "external"`) and resolve at import time from `node_modules`,
 * so engine singletons keep their identity. Extension-agnostic: a hand-authored dev project is
 * `.ts`, a `stackbase deploy`-pushed tree is `.js` — both bundle+load the same way.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { SchemaDefinition } from "@stackbase/values";
import type { LoadedProject } from "./project";

const CACHE_BUST = () => `?t=${Date.now()}`;

/** The module key `stackbase` uses to address a convex/ function file — strips the extension. */
export function moduleKeyForFile(file: string): string {
  return file.replace(/\.(ts|js)$/, "");
}

/** List a convex/ dir's function module files (excludes schema.{ts,js}, `_`-prefixed, and .d.ts). */
export function listConvexModuleFiles(absDir: string): string[] {
  const isModule = (f: string) =>
    (f.endsWith(".ts") || f.endsWith(".js")) &&
    !f.endsWith(".d.ts") &&
    !f.startsWith("_") &&
    f !== "schema.ts" &&
    f !== "schema.js";
  return readdirSync(absDir).filter(isModule);
}

/** The nearest ancestor of `startDir` that contains a `node_modules` dir; the bundled output goes
 *  under `<that>/node_modules/.cache/stackbase` so the bundle's external bare imports (`@stackbase/*`)
 *  resolve via Node's ancestor walk. Falls back to `startDir` if no `node_modules` ancestor exists. */
function resolveCacheDir(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "node_modules"))) break;
    const parent = dirname(dir);
    if (parent === dir) {
      dir = resolve(startDir);
      break;
    }
    dir = parent;
  }
  const cacheDir = join(dir, "node_modules", ".cache", "stackbase");
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/** Bundle one module (relative graph inlined, bare deps external), write it under the node_modules
 *  cache, and import it. Resolution happens at bundle time — runtime-agnostic. */
async function bundleAndImport(file: string, key: string, cacheDir: string): Promise<Record<string, unknown>> {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  const outFile = join(cacheDir, `${key.replace(/[\\/]/g, "__")}.mjs`);
  writeFileSync(outFile, code);
  return (await import(pathToFileURL(outFile).href + CACHE_BUST())) as Record<string, unknown>;
}

export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const entries = listConvexModuleFiles(absDir);
  const cacheDir = resolveCacheDir(absDir);

  const schemaFile = existsSync(join(absDir, "schema.ts")) ? "schema.ts" : "schema.js";
  const schemaModule = (await bundleAndImport(join(absDir, schemaFile), "schema", cacheDir)) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const key = moduleKeyForFile(file);
    modules[key] = await bundleAndImport(join(absDir, file), key, cacheDir);
  }

  return { schema: schemaModule.default, modules };
}
```

- [ ] **Step 2: Run the Task 1 unit test — now GREEN**

Run: `bun run --filter @stackbase/cli build && bun run --filter @stackbase/cli test load-modules-conventional`
Expected: PASS (build first so any downstream dist consumer is fresh; the test imports `../src` directly, but building also surfaces a compile error early).

- [ ] **Step 3: Existing load tests stay green**

Run: `bun run --filter @stackbase/cli test load-js load-project-components boot-loaded`
Expected: all PASS (deploy-v2/js fixtures import `@stackbase/executor` directly — bundling is a functional passthrough).

- [ ] **Step 4: Typecheck**

Run: `bun run --filter @stackbase/cli typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/load-modules.ts
git commit -m "fix(cli): bundle-on-load — esbuild-bundle convex modules so ./_generated imports resolve on Node too"
```

---

### Task 3: Node E2E (reproduce-then-pass) + regression

**Files:**
- Create: `packages/cli/test/node-load-e2e.test.ts`

**Interfaces:** Consumes the built CLI (`packages/cli/dist/bin.js`) + the `conventional-app` fixture (Task 1).

- [ ] **Step 1: Write the E2E `packages/cli/test/node-load-e2e.test.ts`**

The E2E spawns the built CLI under BOTH `node` (the runtime that failed) and `bun`, running `codegen` against the conventional fixture, and asserts the **success signal** (stdout `generated …` + `_generated` present + no `ERR_MODULE_NOT_FOUND`) — because the old broken path exits 0 too, so exit code alone is insufficient.

```ts
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliBin = join(here, "..", "dist", "bin.js");
const fixtureSrc = join(here, "fixtures", "conventional-app", "convex");
const repoRoot = join(here, "..", "..", ".."); // packages/cli/test → repo root

/** Copy the fixture to a throwaway convex dir UNDER the repo (so @stackbase/* resolve), run codegen
 *  via `runner`, and return { code, out }. Deletes the copy after. */
function codegenWith(runner: string): { ok: boolean; out: string } {
  const tmp = mkdtempSync(join(repoRoot, ".tmp-node-load-"));
  const convex = join(tmp, "convex");
  cpSync(fixtureSrc, convex, { recursive: true });
  // Remove the committed _generated so codegen regenerates it — proves the load path ran to completion.
  rmSync(join(convex, "_generated"), { recursive: true, force: true });
  try {
    const out = execFileSync(runner, [cliBin, "codegen", "--dir", convex], { encoding: "utf8", stdio: "pipe" });
    return { ok: existsSync(join(convex, "_generated", "server.ts")) && /generated/.test(out) && !/ERR_MODULE_NOT_FOUND/.test(out), out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("CLI loads a conventional (./_generated/server) app across runtimes", () => {
  it("codegen succeeds under NODE (the runtime that failed before bundle-on-load)", () => {
    const r = codegenWith(process.execPath); // node
    expect(r.ok, `node codegen output:\n${r.out}`).toBe(true);
  });

  it("codegen still succeeds under BUN", () => {
    const r = codegenWith("bun");
    expect(r.ok, `bun codegen output:\n${r.out}`).toBe(true);
  });
});
```

Wait — but the fixture's `notes.ts` re-imports `./_generated/server`, and Step "remove _generated" would break that import before codegen regenerates it. Handle this: do NOT remove `_generated` up front; instead assert codegen **re-writes** it (compare mtime or content) OR simply assert codegen exits successfully AND stdout contains `generated` AND no `ERR_MODULE_NOT_FOUND`. Adjust `codegenWith` to keep `_generated` in place and assert on stdout + exit success only:

```ts
function codegenWith(runner: string): { ok: boolean; out: string } {
  const tmp = mkdtempSync(join(repoRoot, ".tmp-node-load-"));
  const convex = join(tmp, "convex");
  cpSync(fixtureSrc, convex, { recursive: true }); // keep _generated — notes.ts imports it
  try {
    const out = execFileSync(runner, [cliBin, "codegen", "--dir", convex], { encoding: "utf8", stdio: "pipe" });
    return { ok: /generated/.test(out) && !/ERR_MODULE_NOT_FOUND/.test(out), out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

Use THIS version (keep `_generated`; assert stdout `generated` + no module-not-found). `execFileSync` throws on non-zero exit, so a hard failure lands in the catch; the current bug's exit-0-but-errored path is caught by the `ERR_MODULE_NOT_FOUND` string check (which appears in the error output).

- [ ] **Step 2: Run the E2E**

Run: `bun run --filter @stackbase/cli build && bun run --filter @stackbase/cli test:e2e node-load`
Expected: PASS — both the `node` and `bun` cases succeed. (The `node` case is the exact command that reproduced the original bug; it now passes because bundle-on-load resolved the relative graph at bundle time.)

- [ ] **Step 3: Regression — the existing serial E2Es still pass**

Run: `bun run --filter @stackbase/cli test:e2e deploy-e2e build-e2e`
Expected: PASS (these exercise `loadConvexDir` through the real deploy/build entrypoints; bundle-on-load must not regress them).

- [ ] **Step 4: Full fast lane (no cross-package regression)**

Run: `bun run --filter @stackbase/cli test`
Expected: the CLI fast lane green (existing load tests + the new conventional test).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/node-load-e2e.test.ts
git commit -m "test(cli): node-load E2E — codegen loads a conventional app under real Node (reproduce-then-pass) + bun"
```

---

## Self-Review

**1. Spec coverage:**
- Bundle-on-load (`esbuild build`, `packages:"external"`, cache under `node_modules/.cache/stackbase`, `?t=` cache-bust) → Task 2. ✓
- Only `load-modules.ts` changes; signature preserved → Task 2. ✓
- Conventional-import fixture (the shape existing fixtures avoid) → Task 1. ✓
- Unit test under Node-vitest → Task 1 (with the honest note that vitest may mask the in-process repro; the E2E is authoritative). ✓
- Node E2E reproduce-then-pass + bun → Task 3. ✓
- Existing load tests + deploy/build E2Es stay green → Task 2 Step 3, Task 3 Step 3. ✓
- Out-of-scope (exit-0 loud-fail, esbuild batching) → not in any task. ✓

**2. Placeholder scan:** No TBD/handle-cases. Task 3 Step 1 shows two versions of `codegenWith` and explicitly instructs using the SECOND (keep `_generated`, assert on stdout) — the first is shown only to explain why it's wrong; the implementer writes the second. No other placeholders.

**3. Type consistency:** `loadConvexDir(dir): Promise<LoadedProject>` unchanged; `resolveCacheDir(startDir: string): string` and `bundleAndImport(file: string, key: string, cacheDir: string): Promise<Record<string, unknown>>` are used consistently within Task 2. `moduleKeyForFile`/`listConvexModuleFiles` signatures preserved verbatim.
