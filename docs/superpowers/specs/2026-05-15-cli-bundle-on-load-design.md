# CLI Bundle-on-Load (runtime-agnostic module loading) — Design Spec

**Date:** 2026-05-15
**Status:** SHIPPED (merged to main). **The design below is superseded in two ways by what shipped** — the E2E surfaced gaps this pre-plan design didn't anticipate:
1. **Externalize only `@stackbase/*`, not all packages.** This doc's `packages: "external"` inlines nothing beyond the relative graph, which left third-party CJS deps external — and a native ESM *named* import of a CJS package (e.g. `import { parseExpression } from "cron-parser"`) fails under Node. The shipped loader uses `external: ["@stackbase/*"]`: only the engine's own packages stay external (for singleton identity); **user npm deps are BUNDLED**, so esbuild does the CJS→ESM interop at bundle time. A companion fix (`components/scheduler/src/crons.ts`) default-imports `cron-parser` so `@stackbase/scheduler` itself loads under native Node.
2. **Per-convex-dir cache namespacing.** The cache path is `.cache/stackbase/<sha256(absDir)>/<key>.mjs` (not a flat `<key>.mjs`) so two projects resolving to the same `node_modules` ancestor never collide; and `resolveCacheDir` falls back to the CLI's own `node_modules` root when the app dir has none.

**Known follow-ons (not built):** an externalize-list escape hatch for user deps that can't be bundled (native `.node` bindings, `__dirname` asset reads, dynamic `require`); a CI guard that greps built dists for named imports of lexer-opaque CJS deps (turn the Bun-ism tail into a caught regression).

---

**Type:** Correctness fix to a load-bearing path (`loadConvexDir`), not a new feature.

## Problem (reproduced + root-caused)

`packages/cli/src/load-modules.ts`'s `loadConvexDir` loads an app's `convex/` tree via **bare dynamic `import()`** of each file. That relies on the runtime's own module resolution, which **diverges between Bun and Node**:

- The Convex/Stackbase convention — used by `stackbase codegen`'s scaffolding, every shipped example (`examples/auth-demo`, `examples/chat`), and every doc — is **extensionless relative imports**: `import { query, mutation } from "./_generated/server"`.
- **Bun** (and bundlers) auto-resolve extensionless relative specifiers. **Node's ESM resolver requires an explicit extension** and rejects them with `ERR_MODULE_NOT_FOUND` — even on Node 24 (Node's TypeScript type-stripping handles `.ts`, but does **not** change resolution).

**Reproduced:** `node packages/cli/dist/bin.js codegen --dir <app-with-conventional-imports>` → `ERR_MODULE_NOT_FOUND: Cannot find module '.../_generated/server'`. The same command under `bun` succeeds. Confirmed the failing specifier is a **value** import (`query`/`mutation` are runtime values re-exported from `@stackbase/executor`), not a type-only one.

**Why it went unnoticed:** the existing `loadConvexDir` test fixtures sidestep it by importing directly from `@stackbase/executor` (bare, resolvable) instead of `./_generated/server`; and every real-process CLI E2E spawns the bin via **`bun`**. No test loads a *conventionally-authored* tree under **Node**. So the bug ships in the shipped examples but is masked by the test setup.

**Impact:** `stackbase dev`/`serve`/`codegen`/`build`/`deploy`/`migrate` (all 10 callers route through the one `loadConvexDir`) fail to load a conventional app under plain Node. Production Docker is unaffected (it runs Bun), but an npm-installed user on Node is. This contradicts the breadth of the "Node fully supported" locked decision for the CLI path.

**Secondary bug (noted, scoped as a follow-on):** the CLI **exited 0** despite the fatal load error — it should fail loudly with a non-zero code. Out of scope for this fix (which removes the *cause* for the conventional case); tracked separately.

## Fix (chosen: Option A — bundle-on-load)

Make `loadConvexDir` **bundle each module with esbuild before importing it**, so relative resolution happens at bundle time (esbuild's bundler-style resolver handles extensionless + `.ts`), identically on every runtime. Bare package imports (`@stackbase/*` and any user npm dep) stay **external** and resolve from the real `node_modules` at import time.

`esbuild` is already a `@stackbase/cli` dependency (`^0.27.0`), used by the deploy transpile — no new dependency.

### Mechanism

For each file (schema + each function module), instead of `import(pathToFileURL(file))`:

1. `esbuild.build({ entryPoints: [file], bundle: true, packages: "external", format: "esm", platform: "node", write: false, sourcemap: "inline" })`.
   - `bundle: true` inlines the relative graph (`./_generated/*`, `./schema`, cross-module relatives), resolving extensionless + `.ts` the way a bundler does.
   - `packages: "external"` keeps every bare specifier (`@stackbase/executor`, `@stackbase/client`, `@stackbase/values`, user npm deps) as a live `import` in the output — resolved at runtime, never inlined (so the engine's singletons keep their identity).
2. Write the bundled ESM text to a cache file **inside `node_modules`** so those external bare imports resolve: `node_modules/.cache/stackbase/<sanitized-module-key>.mjs`. (Placing it under `node_modules/` means Node's ancestor walk finds `node_modules/@stackbase/*`. The dir is conventional — `node_modules/.cache` already exists — and gitignored by virtue of being under `node_modules`.)
3. `import(pathToFileURL(cacheFile).href + "?t=" + Date.now())` — the `?t=` cache-bust preserves the existing hot-reload behavior (each reload re-bundles, re-writes, re-imports fresh).

The module key is sanitized to a flat filename (path separators → `__`) to avoid nested-dir collisions in the cache.

### What stays the same

- `loadConvexDir`'s async signature and return shape (`{ schema, modules }`) are unchanged — all 10 callers are untouched.
- The default export (schema) and each module's named exports are read exactly as before, from the imported (now-bundled) module.
- Cache-bust-per-load hot-reload semantics preserved.

### Runtime-agnostic

Works identically under Bun, Node ≥18, and any ESM runtime — the resolution divergence is eliminated at bundle time. This aligns with the deploy-anywhere / runtime-agnostic thesis and makes the "Node supported" claim true for the CLI path.

## Alternatives considered (and why not)

- **B. Register a Node loader (`tsx`/esbuild-register).** Cheapest, but adds a runtime dep and a Node-specific code path; doesn't unify the runtimes (Bun path stays different). Bundle-on-load is one path for all runtimes.
- **C. Rewrite user import specifiers to add extensions.** Invasive and fragile — the extensionless convention is the user's source, and codegen-emitted files aren't the only offenders.
- **D. Document Bun-only for the CLI.** No parity gained; the user chose A.

## Files

- **Modify:** `packages/cli/src/load-modules.ts` — `loadConvexDir` bundles-then-imports via a new internal `bundleAndImport(file, cacheDir)` helper; resolves the cache dir under `node_modules/.cache/stackbase`.
- **New (test fixture):** `packages/cli/test/fixtures/conventional-app/convex/{schema.ts, notes.ts, _generated/*}` — a fixture whose `notes.ts` uses the **conventional** `import { query, mutation } from "./_generated/server"` (the shape the current fixtures avoid), so the regression is pinned.
- **Test:** `packages/cli/test/load-modules-conventional.test.ts` — `loadConvexDir` loads the conventional fixture and exposes its exports (runs under Node-vitest — the exact environment that failed with bare `import()`).
- **E2E:** `packages/cli/test/node-load-e2e.test.ts` — spawn the built CLI under **`node`** (`process.execPath`) running `codegen --dir <conventional fixture>` and assert exit 0 (the reproduce-then-pass), plus the same under `bun` still works.

## Testing

- **Unit (fast lane):** `loadModules-conventional` — `loadConvexDir(conventional-app/convex)` under Node-vitest returns the schema + a `notes` module whose `list`/`add` are the executor-built functions (proving the `./_generated/server` value import resolved). Assert the cache file was produced under `node_modules/.cache/stackbase`. Keep the existing `boot-loaded`/`load-js`/`load-project-components` tests green (bundling a `@stackbase/executor`-direct module is a functional no-op).
- **E2E (serial lane):** `node dist/bin.js codegen --dir <conventional fixture>` exits 0 and writes `_generated` (the exact command that reproduced the bug); same under `bun`. This is the honest cross-runtime proof.
- **Regression:** the existing deploy/build/serve E2Es (which exercise `loadConvexDir` through the real entrypoints) stay green — run the CLI serial lane.

## Non-goals

- The loud-failure (exit-non-zero on a genuine load error) fix — separate follow-on.
- Bundling performance optimization (batch all entrypoints in one esbuild call) — per-module is simple and fast enough (~ms/file); batching is a later optimization if startup latency ever matters.
- Changing the deploy push format (it already transpiles to `.js`; those `.js` files also load through the same fixed `loadConvexDir`, so they benefit too — but no push-format change is needed).
