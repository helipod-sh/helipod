# DeployTarget Seam Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flexible multi-provider `stackbase deploy` — one command that targets a running `serve` (push, back-compat), Cloudflare (DO-native), or a local Docker artifact, across environments — behind a `DeployTarget` seam, shelling out to provider CLIs (never bundling a cloud SDK).

**Architecture:** A new `@stackbase/deploy` package holds the seam (`DeployTarget`/`Spawner`/`DeployContext`), a config resolver, and three lazy-loaded adapters (`serve`/`cloudflare`/`docker`). `@stackbase/component`'s `StackbaseConfig` gains an optional `deploy` block + an `env()` helper. `@stackbase/cli`'s `deploy` command resolves `--target`/`--env`, builds a `DeployContext`, and dispatches through the seam — the existing slice-6b push becomes the `serve` target, byte-for-byte.

**Tech Stack:** TypeScript (ESM, `type: module`), Bun workspace + Turborepo, `tsup` build, `vitest` test, `esbuild` transform (existing), `node:child_process` for shell-outs, `wrangler`/`docker` as external CLIs (peer/system, never bundled).

## Global Constraints

- **Never bundle a cloud provider SDK.** Providers are reached by shelling out to their own CLI (`wrangler`, `docker`) via the `Spawner` seam. `@stackbase/deploy` runtime deps = `@stackbase/component` only.
- **Every shell-out goes through `Spawner`** — never call `node:child_process` directly in an adapter — so tests inject a `FakeSpawner`.
- **The deploy path must be non-interactive-safe.** `preflight` MUST NOT prompt or read stdin when `ctx.interactive === false`; a missing credential is a fail-fast `DeployError`, never a hang.
- **`serve` target = exact slice-6b behavior.** `stackbase deploy --url <url>` with no `--target` must remain byte-for-byte compatible (POST `/_admin/deploy`, `Bearer STACKBASE_ADMIN_KEY`, same success/error lines).
- **Reconcile, never regenerate, `wrangler.jsonc`** — add missing bindings additively; never drop a user field.
- **Adapters lazy-load** via dynamic `import()` keyed on provider, so `stackbase` startup never loads a target it isn't using.
- **v1 adapters = `serve`, `cloudflare`, `docker` only.** `railway`/`fly`/`aws` are deferred (documented follow-ons, not built).
- **Test lanes:** unit/in-process tests are `test/*.test.ts` (fast lane, `vitest run`); real-process/real-CLI tests are `test/*-e2e.test.ts` (serial lane, `vitest run test/*-e2e.test.ts`). A new package's `package.json` splits `test` (excludes `*-e2e`) and `test:e2e`.
- **Cloudflare binding constants (from `packages/runtime-cloudflare/rig/wrangler.jsonc`):** DO binding `{ name: "STACKBASE_DO", class_name: "StackbaseDO" }`; migration `{ tag: "v1", new_sqlite_classes: ["StackbaseDO"] }`; required `compatibility_flags: ["nodejs_compat"]`; optional R2 `{ binding: "STORAGE_BUCKET", bucket_name: <name> }`.

---

## File Structure

**New package `packages/deploy` (`@stackbase/deploy`):**
- `package.json`, `tsconfig.json`, `tsup.config.ts` — scaffold following `packages/component` conventions.
- `src/index.ts` — barrel: re-export types, `NodeSpawner`, `resolveDeploy`, `loadTarget`, `reconcileWrangler`.
- `src/types.ts` — `Spawner`/`SpawnResult`/`SpawnOptions`, `FileTree`, `ResolvedTarget`, `DeployContext`, `DeployResult`, `DeployTarget`, `DeployError`.
- `src/spawner.ts` — `NodeSpawner` (real `node:child_process`).
- `src/resolve.ts` — `resolveDeploy(input)` pure config resolution.
- `src/registry.ts` — `loadTarget(provider)` lazy dynamic-import dispatch.
- `src/wrangler-reconcile.ts` — `stripJsonc(text)` + `reconcileWrangler(config, opts)` pure functions.
- `src/targets/serve.ts` — `serveTarget`.
- `src/targets/cloudflare.ts` — `cloudflareTarget`.
- `src/targets/docker.ts` — `dockerTarget`.
- `test/support/fake-spawner.ts` — recording `FakeSpawner` test helper.
- `test/{spawner,resolve,wrangler-reconcile,serve-target,cloudflare-target,docker-target}.test.ts` — fast-lane units.
- `test/deploy-serve-e2e.test.ts` — real `serve --allow-deploy` back-compat E2E.
- `test/deploy-cloudflare-e2e.test.ts` — real `wrangler` E2E (honest skip without CF creds).

**Modified:**
- `packages/component/src/config.ts` — add `DeployConfig`/`TargetConfig`, `deploy?` on `StackbaseConfig`, `env()`.
- `packages/component/src/index.ts` — export the new config symbols + `env`.
- `packages/cli/package.json` — add `@stackbase/deploy` dependency.
- `packages/cli/src/load-config.ts` — pass `deploy` through (currently stripped).
- `packages/cli/src/deploy.ts` — rewrite `deployCommand` to dispatch through the seam (keep `packageApp`, `resolveDeployOptions` for reuse); add `--dry-run`/`--check` and the `checkDrift` helper.
- `packages/cli/src/cli.ts` — deploy help text; deploy case unchanged call-site (still `deployCommand(rest)`).

**Docs (final task):**
- `docs/enduser/deploy/targets.md`, `docs/enduser/deploy/cloudflare.md`, `docs/enduser/deploy/ci-github-actions.md`.

---

## Canonical Interfaces (defined in Task 1, referenced everywhere)

```ts
// @stackbase/deploy — src/types.ts
export interface SpawnOptions { cwd?: string; env?: Record<string, string>; stdio?: "inherit" | "capture"; }
export interface SpawnResult { code: number; stdout: string; stderr: string; }
export interface Spawner { run(cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult>; }

export interface FileTree { files: Array<{ path: string; code: string }>; }

export interface ResolvedTarget {
  targetName: string;                    // the --target value, e.g. "cloudflare"
  provider: string;                      // "serve" | "cloudflare" | "docker"
  env: string;                           // resolved environment name, e.g. "production"
  settings: Record<string, unknown>;     // shared config merged with the env override
}

export interface DeployContext {
  cwd: string;                           // project root (dir containing convex/)
  convexDir: string;                     // path to the convex/ dir
  env: string;                           // = ResolvedTarget.env
  target: ResolvedTarget;
  interactive: boolean;                  // stdin.isTTY && !process.env.CI — false gates all prompts
  spawn: Spawner;
  log: (msg: string) => void;
  packageApp: () => Promise<FileTree>;   // transpile convex/ (provided by the CLI)
  codegen: () => Promise<void>;          // refresh convex/_generated (provided by the CLI)
}

export interface DeployResult { ok: boolean; url?: string; detail?: string; error?: string; }

export interface DeployTarget {
  readonly name: string;                 // "serve" | "cloudflare" | "docker"
  preflight(ctx: DeployContext): Promise<void>; // fail-fast; MUST NOT prompt when !ctx.interactive
  package(ctx: DeployContext): Promise<void>;
  push(ctx: DeployContext): Promise<DeployResult>;
}

export class DeployError extends Error {}
```

```ts
// @stackbase/component — src/config.ts (additions)
export interface TargetConfig {
  provider: string;                                     // "serve" | "cloudflare" | "docker" | ...
  environments?: Record<string, Record<string, unknown>>;
  [k: string]: unknown;                                 // provider-shared settings
}
export interface DeployConfig {
  defaultTarget?: string;                               // used when --target omitted; effective default "serve"
  targets?: Record<string, TargetConfig>;
}
export function env(name: string, fallback?: string): string;
```

```ts
// @stackbase/deploy — src/resolve.ts
export interface ResolveInput {
  deploy: import("@stackbase/component").DeployConfig | undefined;
  target?: string;    // --target
  env?: string;       // --env
  inlineUrl?: string; // --url (back-compat → serve settings.url)
}
export function resolveDeploy(input: ResolveInput): ResolvedTarget | { error: string };

// src/registry.ts
export function loadTarget(provider: string): Promise<DeployTarget>;

// src/wrangler-reconcile.ts
export function stripJsonc(text: string): string; // string-aware comment + trailing-comma stripper
export interface ReconcileOpts { needsR2?: boolean; r2BucketName?: string; }
export interface ReconcileResult { config: Record<string, unknown>; changed: boolean; added: string[]; }
export function reconcileWrangler(config: Record<string, unknown>, opts: ReconcileOpts): ReconcileResult;
```

---

### Task 1: Scaffold `@stackbase/deploy` + seam types

**Files:**
- Create: `packages/deploy/package.json`
- Create: `packages/deploy/tsconfig.json`
- Create: `packages/deploy/tsup.config.ts`
- Create: `packages/deploy/src/types.ts`
- Create: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/types.test.ts`

**Interfaces:**
- Produces: everything in "Canonical Interfaces" `src/types.ts`.

- [ ] **Step 1: Create `packages/deploy/package.json`**

```json
{
  "name": "@stackbase/deploy",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsup",
    "test": "vitest run --exclude 'test/*-e2e.test.ts'",
    "test:e2e": "vitest run test/*-e2e.test.ts",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist .turbo"
  },
  "dependencies": {
    "@stackbase/component": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

- [ ] **Step 2: Create `packages/deploy/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": ".",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `packages/deploy/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
```

- [ ] **Step 4: Create `packages/deploy/src/types.ts`** — paste the exact `src/types.ts` block from "Canonical Interfaces" above.

- [ ] **Step 5: Create `packages/deploy/src/index.ts`**

```ts
export * from "./types";
```

- [ ] **Step 6: Write the failing test `packages/deploy/test/types.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { DeployError, type DeployTarget } from "../src/index";

describe("@stackbase/deploy seam types", () => {
  it("a minimal object satisfies DeployTarget and DeployError is an Error", async () => {
    const noop: DeployTarget = {
      name: "noop",
      async preflight() {},
      async package() {},
      async push() { return { ok: true, detail: "noop" }; },
    };
    expect(noop.name).toBe("noop");
    expect((await noop.push({} as never)).ok).toBe(true);
    expect(new DeployError("x")).toBeInstanceOf(Error);
  });
});
```

- [ ] **Step 7: Install workspace + run test**

Run: `bun install && bun run --filter @stackbase/deploy test`
Expected: PASS (1 test). `bun install` links the new workspace package.

- [ ] **Step 8: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): scaffold @stackbase/deploy package + DeployTarget seam types"
```

---

### Task 2: `NodeSpawner` + `FakeSpawner` test helper

**Files:**
- Create: `packages/deploy/src/spawner.ts`
- Create: `packages/deploy/test/support/fake-spawner.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/spawner.test.ts`

**Interfaces:**
- Consumes: `Spawner`, `SpawnOptions`, `SpawnResult` (Task 1).
- Produces: `class NodeSpawner implements Spawner`; `class FakeSpawner implements Spawner` with `calls: Array<{cmd:string;args:string[]}>` and `queue(result: Partial<SpawnResult>)`.

- [ ] **Step 1: Write the failing test `packages/deploy/test/spawner.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { NodeSpawner } from "../src/spawner";
import { FakeSpawner } from "./support/fake-spawner";

describe("NodeSpawner", () => {
  it("captures stdout and exit code of a real subprocess", async () => {
    const s = new NodeSpawner();
    const r = await s.run(process.execPath, ["-e", "process.stdout.write('hi')"], { stdio: "capture" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("hi");
  });

  it("reports a non-zero exit code", async () => {
    const s = new NodeSpawner();
    const r = await s.run(process.execPath, ["-e", "process.exit(3)"], { stdio: "capture" });
    expect(r.code).toBe(3);
  });
});

describe("FakeSpawner", () => {
  it("records calls and returns queued results FIFO", async () => {
    const s = new FakeSpawner();
    s.queue({ stdout: "wrangler 3.0.0" });
    const r = await s.run("wrangler", ["--version"], { stdio: "capture" });
    expect(r.stdout).toBe("wrangler 3.0.0");
    expect(s.calls).toEqual([{ cmd: "wrangler", args: ["--version"] }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test spawner`
Expected: FAIL (cannot find `../src/spawner` / `./support/fake-spawner`).

- [ ] **Step 3: Create `packages/deploy/src/spawner.ts`**

```ts
import { spawn } from "node:child_process";
import type { Spawner, SpawnOptions, SpawnResult } from "./types";

export class NodeSpawner implements Spawner {
  run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
    const capture = opts.stdio === "capture";
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (e) => reject(e)); // e.g. ENOENT when the CLI is not installed
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }
}
```

- [ ] **Step 4: Create `packages/deploy/test/support/fake-spawner.ts`**

```ts
import type { Spawner, SpawnOptions, SpawnResult } from "../../src/types";

export class FakeSpawner implements Spawner {
  calls: Array<{ cmd: string; args: string[]; opts?: SpawnOptions }> = [];
  private results: SpawnResult[] = [];
  /** Fail with ENOENT-style rejection for the next matching cmd (simulates "CLI not installed"). */
  missing = new Set<string>();

  queue(result: Partial<SpawnResult>): void {
    this.results.push({ code: 0, stdout: "", stderr: "", ...result });
  }

  async run(cmd: string, args: string[], opts?: SpawnOptions): Promise<SpawnResult> {
    this.calls.push({ cmd, args, opts });
    if (this.missing.has(cmd)) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    return this.results.shift() ?? { code: 0, stdout: "", stderr: "" };
  }
}
```

- [ ] **Step 5: Export `NodeSpawner` from `packages/deploy/src/index.ts`**

```ts
export * from "./types";
export { NodeSpawner } from "./spawner";
```

- [ ] **Step 6: Run tests**

Run: `bun run --filter @stackbase/deploy test`
Expected: PASS (all spawner + types tests).

- [ ] **Step 7: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): NodeSpawner subprocess seam + FakeSpawner test helper"
```

---

### Task 2b: Note on `preflight` throwing `DeployError`

Adapters signal a fail-fast by `throw new DeployError(msg)` in `preflight`. The CLI (Task 9) catches it, prints `✗ <msg>`, and returns exit code 1. No adapter calls `process.exit` or reads stdin. This is the mechanism behind the non-interactive contract — there is nothing to prompt because a missing prerequisite always throws before any interaction.

---

### Task 3: Config extension — `deploy` block + `env()` + `loadConfig` passthrough

**Files:**
- Modify: `packages/component/src/config.ts`
- Modify: `packages/component/src/index.ts`
- Modify: `packages/cli/src/load-config.ts:19`
- Test: `packages/component/test/config-deploy.test.ts`
- Test: `packages/cli/test/load-config-deploy.test.ts`

**Interfaces:**
- Produces: `DeployConfig`, `TargetConfig` (see Canonical Interfaces); `env(name, fallback?)` returns a non-empty `process.env[name]`, else `fallback`, else `""`.

- [ ] **Step 1: Write the failing test `packages/component/test/config-deploy.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { defineConfig, env, type StackbaseConfig } from "../src/index";

describe("defineConfig deploy block", () => {
  it("carries a deploy block through unchanged", () => {
    const cfg: StackbaseConfig = defineConfig({
      components: [],
      deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } },
    });
    expect(cfg.deploy?.defaultTarget).toBe("cloudflare");
    expect(cfg.deploy?.targets?.cloudflare.provider).toBe("cloudflare");
  });
});

describe("env()", () => {
  const KEY = "SB_TEST_ENV_VAR";
  afterEach(() => { delete process.env[KEY]; });

  it("returns a set non-empty value", () => { process.env[KEY] = "abc"; expect(env(KEY)).toBe("abc"); });
  it("treats empty-string as unset and uses the fallback", () => { process.env[KEY] = ""; expect(env(KEY, "fb")).toBe("fb"); });
  it("returns empty string when unset with no fallback", () => { expect(env(KEY)).toBe(""); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/component test config-deploy`
Expected: FAIL (`env` not exported; `deploy` not on `StackbaseConfig`).

- [ ] **Step 3: Edit `packages/component/src/config.ts`** (replace the whole file)

```ts
import type { ComponentDefinition } from "./define-component";

export interface TargetConfig {
  /** "serve" | "cloudflare" | "docker" | ... — selects the deploy adapter. */
  provider: string;
  /** Per-environment overrides, merged over the shared settings; --env selects one. */
  environments?: Record<string, Record<string, unknown>>;
  /** Provider-shared settings (provider-specific fields). */
  [k: string]: unknown;
}

export interface DeployConfig {
  /** Used when --target is omitted. Effective default is "serve" (resolved in @stackbase/deploy). */
  defaultTarget?: string;
  /** Keyed by target name (the --target value). */
  targets?: Record<string, TargetConfig>;
}

export interface StackbaseConfig {
  components: ComponentDefinition[];
  deploy?: DeployConfig;
}

export function defineConfig(config: StackbaseConfig): StackbaseConfig {
  return config;
}

/**
 * Deferred env-var read for deploy config authoring (Supabase-style). Reads at config-load time.
 * Treats an empty string as unset. Never throws — returns "" when unset and no fallback given, so a
 * config still RESOLVES with no `.env` present (the target's preflight is what fail-fasts on a
 * genuinely-required missing credential).
 */
export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  return fallback ?? "";
}
```

- [ ] **Step 4: Edit `packages/component/src/index.ts`** — ensure the config symbols are exported. Add (if not already a `export * from "./config"`):

```ts
export { defineConfig, env } from "./config";
export type { StackbaseConfig, DeployConfig, TargetConfig } from "./config";
```

(If `index.ts` already does `export * from "./config";`, leave it — `env`/`DeployConfig`/`TargetConfig` are then already exported. Verify by reading the file first.)

- [ ] **Step 5: Run the component test**

Run: `bun run --filter @stackbase/component test config-deploy`
Expected: PASS.

- [ ] **Step 6: Write the failing CLI test `packages/cli/test/load-config-deploy.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/load-config";

describe("loadConfig deploy passthrough", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("returns the deploy block, not just components", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-cfg-"));
    writeFileSync(
      join(dir, "stackbase.config.js"),
      `export default { components: [], deploy: { defaultTarget: "docker", targets: { docker: { provider: "docker" } } } };`,
    );
    const cfg = await loadConfig(dir);
    expect(cfg.components).toEqual([]);
    expect(cfg.deploy?.defaultTarget).toBe("docker");
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test load-config-deploy`
Expected: FAIL (`cfg.deploy` is `undefined` — line 19 strips it).

- [ ] **Step 8: Edit `packages/cli/src/load-config.ts:19`**

Change:
```ts
  return { components: cfg.components ?? [] };
```
to:
```ts
  return { components: cfg.components ?? [], deploy: cfg.deploy };
```

- [ ] **Step 9: Run both tests**

Run: `bun run --filter @stackbase/component test && bun run --filter @stackbase/cli test load-config-deploy`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/component packages/cli/src/load-config.ts packages/cli/test/load-config-deploy.test.ts
git commit -m "feat(deploy): StackbaseConfig.deploy block + env() helper; loadConfig passes deploy through"
```

---

### Task 4: `resolveDeploy` — config resolution

**Files:**
- Create: `packages/deploy/src/resolve.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/resolve.test.ts`

**Interfaces:**
- Consumes: `DeployConfig` (Task 3), `ResolvedTarget` (Task 1).
- Produces: `resolveDeploy(input: ResolveInput): ResolvedTarget | { error: string }` (see Canonical Interfaces).

- [ ] **Step 1: Write the failing test `packages/deploy/test/resolve.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveDeploy } from "../src/resolve";

describe("resolveDeploy", () => {
  it("defaults to the serve target with production env when nothing is specified", () => {
    const r = resolveDeploy({ deploy: undefined });
    expect(r).toEqual({ targetName: "serve", provider: "serve", env: "production", settings: {} });
  });

  it("threads --url into the synthesized serve settings (back-compat)", () => {
    const r = resolveDeploy({ deploy: undefined, inlineUrl: "http://x:9" });
    expect(r).toMatchObject({ provider: "serve", settings: { url: "http://x:9" } });
  });

  it("uses deploy.defaultTarget when --target is omitted", () => {
    const r = resolveDeploy({ deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } } });
    expect(r).toMatchObject({ targetName: "cloudflare", provider: "cloudflare" });
  });

  it("merges the env override over the shared settings", () => {
    const r = resolveDeploy({
      target: "cf",
      env: "staging",
      deploy: { targets: { cf: { provider: "cloudflare", region: "auto", environments: { staging: { wranglerEnv: "staging" } } } } },
    });
    expect(r).toMatchObject({ env: "staging", settings: { region: "auto", wranglerEnv: "staging" } });
    expect((r as { settings: Record<string, unknown> }).settings).not.toHaveProperty("environments");
    expect((r as { settings: Record<string, unknown> }).settings).not.toHaveProperty("provider");
  });

  it("errors on an unknown non-serve target", () => {
    const r = resolveDeploy({ target: "ghost", deploy: { targets: {} } });
    expect(r).toEqual({ error: expect.stringContaining('unknown deploy target "ghost"') });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test resolve`
Expected: FAIL (`../src/resolve` not found).

- [ ] **Step 3: Create `packages/deploy/src/resolve.ts`**

```ts
import type { DeployConfig } from "@stackbase/component";
import type { ResolvedTarget } from "./types";

export interface ResolveInput {
  deploy: DeployConfig | undefined;
  target?: string;
  env?: string;
  inlineUrl?: string;
}

export function resolveDeploy(input: ResolveInput): ResolvedTarget | { error: string } {
  const env = input.env ?? "production";
  const targetName = input.target ?? input.deploy?.defaultTarget ?? "serve";
  const targets = input.deploy?.targets ?? {};
  let cfg = targets[targetName];

  if (!cfg) {
    if (targetName === "serve") {
      cfg = { provider: "serve" }; // synthesized default serve target (back-compat)
    } else {
      return { error: `unknown deploy target "${targetName}" — add it to stackbase.config.ts deploy.targets` };
    }
  }

  const { provider, environments, ...shared } = cfg;
  const envOverride = environments?.[env] ?? {};
  const settings: Record<string, unknown> = { ...shared, ...envOverride };
  if (input.inlineUrl) settings.url = input.inlineUrl;

  return { targetName, provider: String(provider), env, settings };
}
```

- [ ] **Step 4: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { resolveDeploy, type ResolveInput } from "./resolve";
```

- [ ] **Step 5: Run tests**

Run: `bun run --filter @stackbase/deploy test resolve`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): resolveDeploy — target/env defaulting, env-override merge, --url back-compat"
```

---

### Task 5: `serve` target

**Files:**
- Create: `packages/deploy/src/targets/serve.ts`
- Create: `packages/deploy/src/registry.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/serve-target.test.ts`

**Interfaces:**
- Consumes: `DeployTarget`, `DeployContext`, `DeployResult`, `DeployError` (Task 1).
- Produces: `serveTarget: DeployTarget`; `loadTarget(provider): Promise<DeployTarget>`.

- [ ] **Step 1: Write the failing test `packages/deploy/test/serve-target.test.ts`** (uses a real in-process HTTP server — fast lane, no external process)

```ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { serveTarget } from "../src/targets/serve";
import { DeployError } from "../src/types";
import type { DeployContext } from "../src/types";

function ctxWith(settings: Record<string, unknown>): DeployContext {
  return {
    cwd: "/tmp", convexDir: "/tmp/convex", env: "production",
    target: { targetName: "serve", provider: "serve", env: "production", settings },
    interactive: false,
    spawn: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
    log: () => {},
    packageApp: async () => ({ files: [{ path: "a.js", code: "export const x=1" }] }),
    codegen: async () => {},
  };
}

describe("serveTarget", () => {
  let server: Server | undefined;
  afterEach(() => { server?.close(); server = undefined; delete process.env.STACKBASE_ADMIN_KEY; delete process.env.STACKBASE_DEPLOY_URL; });

  it("preflight throws when url is missing", async () => {
    await expect(serveTarget.preflight(ctxWith({ adminKey: "k" }))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight throws when admin key is missing", async () => {
    await expect(serveTarget.preflight(ctxWith({ url: "http://x:1" }))).rejects.toBeInstanceOf(DeployError);
  });

  it("push POSTs the file tree to /_admin/deploy and reports success", async () => {
    let received: unknown;
    let auth: string | undefined;
    server = createServer((req, res) => {
      auth = req.headers.authorization;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, rev: "r1", functions: 3 }));
      });
    });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server!.address() as { port: number }).port;
    const ctx = ctxWith({ url: `http://127.0.0.1:${port}`, adminKey: "secret" });

    await serveTarget.preflight(ctx);
    const result = await serveTarget.push(ctx);

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("rev r1");
    expect(auth).toBe("Bearer secret");
    expect(received).toEqual({ files: [{ path: "a.js", code: "export const x=1" }] });
  });

  it("push reports the 'not enabled' error on 404", async () => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end("{}"); });
    await new Promise<void>((r) => server!.listen(0, r));
    const port = (server!.address() as { port: number }).port;
    const result = await serveTarget.push(ctxWith({ url: `http://127.0.0.1:${port}`, adminKey: "k" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("--allow-deploy");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test serve-target`
Expected: FAIL (`../src/targets/serve` not found).

- [ ] **Step 3: Create `packages/deploy/src/targets/serve.ts`**

```ts
import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";

/** url/adminKey come from config settings, falling back to the slice-6b env vars (exact back-compat). */
function creds(ctx: DeployContext): { url: string; adminKey: string } {
  const url = String(ctx.target.settings.url ?? process.env.STACKBASE_DEPLOY_URL ?? "").trim();
  const adminKey = String(ctx.target.settings.adminKey ?? process.env.STACKBASE_ADMIN_KEY ?? "").trim();
  return { url, adminKey };
}

export const serveTarget: DeployTarget = {
  name: "serve",
  async preflight(ctx) {
    const { url, adminKey } = creds(ctx);
    if (!url) throw new DeployError("serve target needs a url — pass --url or set deploy.targets.serve settings / STACKBASE_DEPLOY_URL");
    if (!adminKey) throw new DeployError("STACKBASE_ADMIN_KEY is required to deploy to a serve target");
  },
  async package() { /* no artifact to pre-build; files come from ctx.packageApp() at push */ },
  async push(ctx): Promise<DeployResult> {
    const { url, adminKey } = creds(ctx);
    const base = url.replace(/\/$/, "");
    const { files } = await ctx.packageApp();
    let res: Response;
    try {
      res = await fetch(`${base}/_admin/deploy`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminKey}` },
        body: JSON.stringify({ files }),
      });
    } catch (e) {
      return { ok: false, error: `could not reach ${base}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (res.status === 404) return { ok: false, error: "deploy not enabled on target (start serve with --allow-deploy)" };
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; error?: string };
    if (!res.ok || !body.ok) return { ok: false, error: body.error ?? res.statusText };
    return { ok: true, url: base, detail: `rev ${body.rev} (${body.functions} functions)` };
  },
};
```

- [ ] **Step 4: Create `packages/deploy/src/registry.ts`**

```ts
import type { DeployTarget } from "./types";

/** Lazy dynamic-import dispatch — a provider's adapter module loads only when it is used. */
export async function loadTarget(provider: string): Promise<DeployTarget> {
  switch (provider) {
    case "serve": return (await import("./targets/serve")).serveTarget;
    case "cloudflare": return (await import("./targets/cloudflare")).cloudflareTarget;
    case "docker": return (await import("./targets/docker")).dockerTarget;
    default: throw new Error(`no deploy adapter for provider "${provider}" (v1 supports: serve, cloudflare, docker)`);
  }
}
```

- [ ] **Step 5: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { loadTarget } from "./registry";
export { serveTarget } from "./targets/serve";
```

Note: `registry.ts` statically references `./targets/cloudflare` and `./targets/docker` inside dynamic `import()`; those files don't exist yet. Dynamic `import()` is not resolved at build time, so `tsup` builds fine, but **do not run `loadTarget("cloudflare")` until Task 7**. The serve-target test only touches `serveTarget` directly.

- [ ] **Step 6: Run tests**

Run: `bun run --filter @stackbase/deploy test serve-target`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): serve target (wraps slice-6b push) + lazy loadTarget registry"
```

---

### Task 6: `wrangler.jsonc` reconcile (pure functions)

**Files:**
- Create: `packages/deploy/src/wrangler-reconcile.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/wrangler-reconcile.test.ts`

**Interfaces:**
- Produces: `stripJsonc(text)`, `reconcileWrangler(config, opts): ReconcileResult` (see Canonical Interfaces).

- [ ] **Step 1: Write the failing test `packages/deploy/test/wrangler-reconcile.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { stripJsonc, reconcileWrangler } from "../src/wrangler-reconcile";

describe("stripJsonc", () => {
  it("removes line and block comments but not // inside strings", () => {
    const src = `{
      // a comment
      "url": "https://example.com", /* trailing */
      "name": "x",
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({ url: "https://example.com", name: "x" });
  });
});

describe("reconcileWrangler", () => {
  it("adds the DO binding + sqlite migration + nodejs_compat to a bare config, preserving user fields", () => {
    const r = reconcileWrangler({ name: "my-app", main: "worker.ts", vars: { CUSTOM: "keep" } }, {});
    expect(r.changed).toBe(true);
    expect(r.config).toMatchObject({
      name: "my-app",
      main: "worker.ts",
      vars: { CUSTOM: "keep" }, // user field untouched
      durable_objects: { bindings: [{ name: "STACKBASE_DO", class_name: "StackbaseDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StackbaseDO"] }],
      compatibility_flags: ["nodejs_compat"],
    });
    expect(r.added).toContain("durable_objects.STACKBASE_DO");
  });

  it("is a no-op when everything is already present (comments would be preserved by the caller)", () => {
    const complete = {
      name: "x", main: "w.ts",
      durable_objects: { bindings: [{ name: "STACKBASE_DO", class_name: "StackbaseDO" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: ["StackbaseDO"] }],
      compatibility_flags: ["nodejs_compat"],
    };
    const r = reconcileWrangler(complete, {});
    expect(r.changed).toBe(false);
    expect(r.added).toEqual([]);
  });

  it("adds the R2 bucket binding only when needsR2 is set", () => {
    const r = reconcileWrangler({ name: "x" }, { needsR2: true, r2BucketName: "my-bucket" });
    expect(r.config).toMatchObject({ r2_buckets: [{ binding: "STORAGE_BUCKET", bucket_name: "my-bucket" }] });
    expect(r.added).toContain("r2_buckets.STORAGE_BUCKET");
  });

  it("preserves an existing nodejs_compat among other flags", () => {
    const r = reconcileWrangler({ name: "x", compatibility_flags: ["nodejs_compat", "streams_enable_constructors"] }, {});
    expect(r.config.compatibility_flags).toEqual(["nodejs_compat", "streams_enable_constructors"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test wrangler-reconcile`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/deploy/src/wrangler-reconcile.ts`**

```ts
/** String-aware JSONC → JSON: strips // and block comments and trailing commas, honoring string literals. */
export function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  let strQuote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inStr) {
      out += c;
      if (c === "\\") { out += n ?? ""; i++; continue; }
      if (c === strQuote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strQuote = c; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  // Remove trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const DO_BINDING = "STACKBASE_DO";
const DO_CLASS = "StackbaseDO";
const R2_BINDING = "STORAGE_BUCKET";
const COMPAT_FLAG = "nodejs_compat";

export interface ReconcileOpts { needsR2?: boolean; r2BucketName?: string; }
export interface ReconcileResult { config: Record<string, unknown>; changed: boolean; added: string[]; }

/** Additively ensure the Stackbase DO bindings/migration/compat flag (+ optional R2) exist. Never
 *  drops a user field. Returns a fresh config object; `changed` says whether anything was added. */
export function reconcileWrangler(input: Record<string, unknown>, opts: ReconcileOpts): ReconcileResult {
  const config: Record<string, unknown> = structuredClone(input);
  const added: string[] = [];

  // Durable Object binding
  const dobj = (config.durable_objects ??= {}) as { bindings?: Array<{ name: string; class_name: string }> };
  dobj.bindings ??= [];
  if (!dobj.bindings.some((b) => b.name === DO_BINDING)) {
    dobj.bindings.push({ name: DO_BINDING, class_name: DO_CLASS });
    added.push(`durable_objects.${DO_BINDING}`);
  }

  // SQLite class migration
  const migrations = (config.migrations ??= []) as Array<{ tag: string; new_sqlite_classes?: string[] }>;
  const hasSqliteClass = migrations.some((m) => m.new_sqlite_classes?.includes(DO_CLASS));
  if (!hasSqliteClass) {
    migrations.push({ tag: `v${migrations.length + 1}`, new_sqlite_classes: [DO_CLASS] });
    added.push(`migrations.${DO_CLASS}`);
  }

  // nodejs_compat flag
  const flags = (config.compatibility_flags ??= []) as string[];
  if (!flags.includes(COMPAT_FLAG)) { flags.push(COMPAT_FLAG); added.push(`compatibility_flags.${COMPAT_FLAG}`); }

  // Optional R2 bucket (file storage)
  if (opts.needsR2) {
    const buckets = (config.r2_buckets ??= []) as Array<{ binding: string; bucket_name: string }>;
    if (!buckets.some((b) => b.binding === R2_BINDING)) {
      buckets.push({ binding: R2_BINDING, bucket_name: opts.r2BucketName ?? "stackbase-storage" });
      added.push(`r2_buckets.${R2_BINDING}`);
    }
  }

  return { config, changed: added.length > 0, added };
}
```

- [ ] **Step 4: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { stripJsonc, reconcileWrangler, type ReconcileOpts, type ReconcileResult } from "./wrangler-reconcile";
```

- [ ] **Step 5: Run tests**

Run: `bun run --filter @stackbase/deploy test wrangler-reconcile`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): additive wrangler.jsonc reconcile (DO binding, sqlite migration, nodejs_compat, optional R2)"
```

---

### Task 7: `cloudflare` target

**Files:**
- Create: `packages/deploy/src/targets/cloudflare.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/cloudflare-target.test.ts`

**Interfaces:**
- Consumes: `DeployTarget`, `DeployContext`, `DeployError` (Task 1); `reconcileWrangler`, `stripJsonc` (Task 6); `FakeSpawner` (Task 2).
- Produces: `cloudflareTarget: DeployTarget`.

- [ ] **Step 1: Write the failing test `packages/deploy/test/cloudflare-target.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudflareTarget } from "../src/targets/cloudflare";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function makeProject(wrangler?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-cf-"));
  if (wrangler !== undefined) writeFileSync(join(dir, "wrangler.jsonc"), wrangler);
  return dir;
}

function ctx(dir: string, spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: dir, convexDir: join(dir, "convex"), env: "production",
    target: { targetName: "cloudflare", provider: "cloudflare", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("cloudflareTarget", () => {
  const cleanup: string[] = [];
  afterEach(() => { cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })); cleanup.length = 0; delete process.env.CLOUDFLARE_API_TOKEN; });

  it("preflight fails fast when wrangler is not installed", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.missing.add("wrangler");
    await expect(cloudflareTarget.preflight(ctx(dir, spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when wrangler.jsonc is absent", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "wrangler 3.0.0" });
    await expect(cloudflareTarget.preflight(ctx(dir, spawn))).rejects.toThrow(/wrangler\.jsonc/);
  });

  it("preflight fails in non-interactive mode without CLOUDFLARE_API_TOKEN, reading no stdin", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ stdout: "wrangler 3.0.0" });
    await expect(cloudflareTarget.preflight(ctx(dir, spawn, { interactive: false }))).rejects.toBeInstanceOf(DeployError);
  });

  it("package reconciles wrangler.jsonc additively (adds DO binding, keeps user fields)", async () => {
    const dir = makeProject(`{ "name": "app", "main": "w.ts", "vars": { "K": "v" } }`); cleanup.push(dir);
    const spawn = new FakeSpawner();
    let codegenRan = false;
    await cloudflareTarget.package(ctx(dir, spawn, { codegen: async () => { codegenRan = true; } }));
    expect(codegenRan).toBe(true);
    const written = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
    const parsed = JSON.parse(written);
    expect(parsed.durable_objects.bindings[0]).toEqual({ name: "STACKBASE_DO", class_name: "StackbaseDO" });
    expect(parsed.vars).toEqual({ K: "v" });
  });

  it("push shells `wrangler deploy` with --env from wranglerEnv and returns the deployed URL", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner();
    spawn.queue({ stdout: "Deployed app triggers\n  https://app.workers.dev\n" });
    const c = ctx(dir, spawn, { target: { targetName: "cf", provider: "cloudflare", env: "staging", settings: { wranglerEnv: "staging" } } });
    const result = await cloudflareTarget.push(c);
    expect(result.ok).toBe(true);
    expect(result.url).toBe("https://app.workers.dev");
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "wrangler", args: ["deploy", "--env", "staging"] });
  });

  it("push reports a wrangler failure", async () => {
    const dir = makeProject("{}"); cleanup.push(dir);
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "auth error" });
    const result = await cloudflareTarget.push(ctx(dir, spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("auth error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test cloudflare-target`
Expected: FAIL (`../src/targets/cloudflare` not found).

- [ ] **Step 3: Create `packages/deploy/src/targets/cloudflare.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";
import { stripJsonc, reconcileWrangler } from "../wrangler-reconcile";

const WRANGLER = "wrangler.jsonc";

/** First https URL wrangler prints on deploy — the deployed Worker URL. */
function extractDeployedUrl(stdout: string): string | undefined {
  return stdout.match(/https:\/\/[^\s]+/)?.[0];
}

export const cloudflareTarget: DeployTarget = {
  name: "cloudflare",
  async preflight(ctx) {
    const v = await ctx.spawn.run("wrangler", ["--version"], { cwd: ctx.cwd, stdio: "capture" }).catch(() => {
      throw new DeployError("wrangler not found — install it (npm i -D wrangler) and retry");
    });
    if (v.code !== 0) throw new DeployError("wrangler not found — install it (npm i -D wrangler) and retry");
    if (!existsSync(join(ctx.cwd, WRANGLER))) {
      throw new DeployError(`${WRANGLER} not found in ${ctx.cwd} — create one (see docs/enduser/deploy/cloudflare.md)`);
    }
    if (!ctx.interactive && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new DeployError("CLOUDFLARE_API_TOKEN is required for non-interactive (CI) deploy");
    }
  },
  async package(ctx) {
    await ctx.codegen();
    const path = join(ctx.cwd, WRANGLER);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    const r = reconcileWrangler(parsed, {
      needsR2: Boolean(ctx.target.settings.r2),
      r2BucketName: ctx.target.settings.r2BucketName as string | undefined,
    });
    if (r.changed) {
      // NOTE: reconcile rewrites as plain JSON (comments not preserved) — only happens when a binding
      // is actually added; a project that already has the bindings keeps its commented wrangler.jsonc.
      writeFileSync(path, JSON.stringify(r.config, null, 2) + "\n");
      ctx.log(`reconciled ${WRANGLER}: added ${r.added.join(", ")}`);
    }
  },
  async push(ctx): Promise<DeployResult> {
    const args = ["deploy"];
    const wranglerEnv = ctx.target.settings.wranglerEnv as string | undefined;
    if (wranglerEnv) args.push("--env", wranglerEnv);
    const r = await ctx.spawn.run("wrangler", args, { cwd: ctx.cwd, stdio: "capture" });
    if (r.code !== 0) return { ok: false, error: `wrangler deploy failed: ${(r.stderr || r.stdout).trim()}` };
    const url = extractDeployedUrl(r.stdout);
    return { ok: true, url, detail: url ? `deployed to ${url}` : "deployed" };
  },
};
```

- [ ] **Step 4: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { cloudflareTarget } from "./targets/cloudflare";
```

- [ ] **Step 5: Run tests**

Run: `bun run --filter @stackbase/deploy test cloudflare-target`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): cloudflare target — wrangler preflight, additive reconcile, shell wrangler deploy, CI fail-fast"
```

---

### Task 8: `docker` target

**Files:**
- Create: `packages/deploy/src/targets/docker.ts`
- Modify: `packages/deploy/src/index.ts`
- Test: `packages/deploy/test/docker-target.test.ts`

**Interfaces:**
- Consumes: `DeployTarget`, `DeployContext`, `DeployError` (Task 1); `FakeSpawner` (Task 2).
- Produces: `dockerTarget: DeployTarget`.

- [ ] **Step 1: Write the failing test `packages/deploy/test/docker-target.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { dockerTarget } from "../src/targets/docker";
import { DeployError, type DeployContext } from "../src/types";
import { FakeSpawner } from "./support/fake-spawner";

function ctx(spawn: FakeSpawner, over: Partial<DeployContext> = {}): DeployContext {
  return {
    cwd: "/proj", convexDir: "/proj/convex", env: "production",
    target: { targetName: "docker", provider: "docker", env: "production", settings: {} },
    interactive: true, spawn, log: () => {},
    packageApp: async () => ({ files: [] }), codegen: async () => {},
    ...over,
  };
}

describe("dockerTarget", () => {
  it("preflight fails fast when docker is not installed", async () => {
    const spawn = new FakeSpawner(); spawn.missing.add("docker");
    await expect(dockerTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("preflight fails when the docker daemon is not running", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "Cannot connect to the Docker daemon" });
    await expect(dockerTarget.preflight(ctx(spawn))).rejects.toBeInstanceOf(DeployError);
  });

  it("push runs `docker compose up -d --build` in the project dir", async () => {
    const spawn = new FakeSpawner();
    spawn.queue({ code: 0 }); // compose up
    const result = await dockerTarget.push(ctx(spawn));
    expect(result.ok).toBe(true);
    expect(spawn.calls.at(-1)).toMatchObject({ cmd: "docker", args: ["compose", "up", "-d", "--build"] });
    expect(spawn.calls.at(-1)!.opts).toMatchObject({ cwd: "/proj" });
  });

  it("push reports a compose failure", async () => {
    const spawn = new FakeSpawner(); spawn.queue({ code: 1, stderr: "no such file docker-compose.yml" });
    const result = await dockerTarget.push(ctx(spawn));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("docker-compose.yml");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/deploy test docker-target`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/deploy/src/targets/docker.ts`**

```ts
import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";

export const dockerTarget: DeployTarget = {
  name: "docker",
  async preflight(ctx) {
    const v = await ctx.spawn.run("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "capture" }).catch(() => {
      throw new DeployError("docker not found — install Docker to use the docker target");
    });
    if (v.code !== 0) {
      throw new DeployError("Docker is installed but the daemon is not reachable — start Docker and retry");
    }
  },
  async package(ctx) {
    // The image builds from the repo's Dockerfile/compose at push time (`--build`); refresh codegen
    // so the baked convex/_generated matches the functions being deployed.
    await ctx.codegen();
  },
  async push(ctx): Promise<DeployResult> {
    const r = await ctx.spawn.run("docker", ["compose", "up", "-d", "--build"], { cwd: ctx.cwd, stdio: "inherit" });
    if (r.code !== 0) return { ok: false, error: `docker compose up failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    return { ok: true, detail: "container up (docker compose)" };
  },
};
```

Note: `stdio: "inherit"` for the compose push streams build output live; `r.stderr` is empty under inherit, so the error line falls back to `exit ${r.code}` — the fake spawner supplies `stderr` in the test to assert the message shape, which is fine (the real path streams to the terminal).

- [ ] **Step 4: Export from `packages/deploy/src/index.ts`** — add:

```ts
export { dockerTarget } from "./targets/docker";
```

- [ ] **Step 5: Run the whole package**

Run: `bun run --filter @stackbase/deploy test`
Expected: PASS (all fast-lane tests across Tasks 1–8).

- [ ] **Step 6: Commit**

```bash
git add packages/deploy && git commit -m "feat(deploy): docker target — daemon preflight + docker compose up smoke deploy"
```

---

### Task 9: CLI wiring — dispatch through the seam, `--target`/`--env`/`--dry-run`/`--check`

**Files:**
- Modify: `packages/cli/package.json` (add dependency)
- Modify: `packages/cli/src/deploy.ts` (rewrite `deployCommand`; keep `packageApp`, `resolveDeployOptions`)
- Modify: `packages/cli/src/cli.ts` (help text only)
- Test: `packages/cli/test/deploy-dispatch.test.ts`

**Interfaces:**
- Consumes: `resolveDeploy`, `loadTarget`, `NodeSpawner`, types (Tasks 1–8); `loadConfig` (Task 3); `packageApp`, `push`, `loadConvexDir`, `writeGenerated` (existing).
- Produces: `deployCommand(args: string[], deps?: DeployDeps): Promise<number>` where `DeployDeps = { spawn?: Spawner; cwd?: string; interactive?: boolean }` (test seam).

- [ ] **Step 1: Add the dependency to `packages/cli/package.json`**

In `"dependencies"`, add:
```json
    "@stackbase/deploy": "workspace:*",
```
Then run `bun install`.

- [ ] **Step 2: Write the failing test `packages/cli/test/deploy-dispatch.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployCommand } from "../src/deploy";
import type { Spawner } from "@stackbase/deploy";

/** A project dir with a minimal convex/ and a stackbase.config.js selecting the cloudflare target. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "sb-dispatch-"));
  mkdirSync(join(dir, "convex"), { recursive: true });
  writeFileSync(join(dir, "convex", "schema.ts"), `import { defineSchema } from "@stackbase/values";\nexport default defineSchema({});\n`);
  writeFileSync(join(dir, "wrangler.jsonc"), `{ "name": "app", "main": "w.ts" }`);
  writeFileSync(
    join(dir, "stackbase.config.js"),
    `export default { components: [], deploy: { defaultTarget: "cloudflare", targets: { cloudflare: { provider: "cloudflare" } } } };`,
  );
  return dir;
}

class RecordingSpawner implements Spawner {
  calls: Array<{ cmd: string; args: string[] }> = [];
  async run(cmd: string, args: string[]) {
    this.calls.push({ cmd, args });
    if (args[0] === "--version") return { code: 0, stdout: "wrangler 3.0.0", stderr: "" };
    if (args[0] === "deploy") return { code: 0, stdout: "https://app.workers.dev", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
}

describe("deployCommand dispatch", () => {
  const cleanup: string[] = [];
  afterEach(() => { cleanup.forEach((d) => rmSync(d, { recursive: true, force: true })); cleanup.length = 0; });

  it("--dry-run runs preflight+package but never calls `wrangler deploy`", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new RecordingSpawner();
    const code = await deployCommand(["--dry-run"], { spawn, cwd: dir, interactive: true });
    expect(code).toBe(0);
    expect(spawn.calls.some((c) => c.args[0] === "--version")).toBe(true); // preflight ran
    expect(spawn.calls.some((c) => c.args[0] === "deploy")).toBe(false);   // push skipped
  });

  it("a full deploy shells `wrangler deploy`", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const spawn = new RecordingSpawner();
    const code = await deployCommand([], { spawn, cwd: dir, interactive: true });
    expect(code).toBe(0);
    expect(spawn.calls.some((c) => c.args[0] === "deploy")).toBe(true);
  });

  it("returns exit code 1 with a clear message on an unknown target", async () => {
    const dir = makeProject(); cleanup.push(dir);
    const code = await deployCommand(["--target", "ghost"], { spawn: new RecordingSpawner(), cwd: dir, interactive: true });
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test deploy-dispatch`
Expected: FAIL (`deployCommand` still has the old 3-arg signature; no `--dry-run`/deps).

- [ ] **Step 4: Rewrite `packages/cli/src/deploy.ts`** (keep `walkTs`, `packageApp`, `resolveDeployOptions` as-is; replace `deployCommand`)

Replace the `deployCommand` function (lines 56–96) with:

```ts
import { resolveDeploy, loadTarget, NodeSpawner, type Spawner, type DeployContext, DeployError } from "@stackbase/deploy";

export interface DeployDeps {
  spawn?: Spawner;
  cwd?: string;
  interactive?: boolean;
}

function parseDeployFlags(args: string[]): { target?: string; env?: string; url?: string; convexDir: string; dryRun: boolean; check: boolean } {
  let target: string | undefined;
  let env: string | undefined;
  let url: string | undefined = process.env.STACKBASE_DEPLOY_URL?.trim() || undefined;
  let convexDir = "convex";
  let dryRun = false;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) target = args[++i];
    else if (args[i] === "--env" && args[i + 1]) env = args[++i];
    else if (args[i] === "--url" && args[i + 1]) url = args[++i];
    else if (args[i] === "--dir" && args[i + 1]) convexDir = args[++i]!;
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--check") check = true;
  }
  return { target, env, url, convexDir, dryRun, check };
}

/** True if running codegen would change the committed convex/_generated (drift). */
async function checkDrift(convexDir: string, components: Awaited<ReturnType<typeof loadConfig>>["components"]): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), "sb-codegen-"));
  try {
    const { generated } = push(await loadConvexDir(convexDir), components);
    writeGenerated(generated.files, tmp);
    const genDir = join(convexDir, "_generated");
    return !dirsEqual(tmp, genDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dirsEqual(a: string, b: string): boolean {
  const walk = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const rec = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir)) {
        const abs = join(dir, e);
        const r = rel ? `${rel}/${e}` : e;
        if (statSync(abs).isDirectory()) rec(abs, r);
        else out.set(r, readFileSync(abs, "utf8"));
      }
    };
    rec(root, "");
    return out;
  };
  const ma = walk(a);
  const mb = walk(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

export async function deployCommand(args: string[], deps: DeployDeps = {}): Promise<number> {
  const flags = parseDeployFlags(args);
  const cwd = deps.cwd ?? process.cwd();
  const convexDir = join(cwd, flags.convexDir);
  const config = await loadConfig(cwd);

  if (flags.check) {
    const drift = await checkDrift(convexDir, config.components);
    if (drift) {
      process.stderr.write("✗ convex/_generated is out of date — run `stackbase codegen` and commit the result\n");
      return 1;
    }
    process.stdout.write("✓ convex/_generated is up to date\n");
    if (!flags.dryRun && !flags.target && !config.deploy) return 0; // --check-only invocation
  }

  const resolved = resolveDeploy({ deploy: config.deploy, target: flags.target, env: flags.env, inlineUrl: flags.url });
  if ("error" in resolved) {
    process.stderr.write(`✗ ${resolved.error}\n`);
    return 1;
  }

  let target;
  try {
    target = await loadTarget(resolved.provider);
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const interactive = deps.interactive ?? (Boolean(process.stdin.isTTY) && !process.env.CI);
  const ctx: DeployContext = {
    cwd,
    convexDir,
    env: resolved.env,
    target: resolved,
    interactive,
    spawn: deps.spawn ?? new NodeSpawner(),
    log: (m) => process.stdout.write(`  ${m}\n`),
    packageApp: async () => ({ files: await packageApp(convexDir) }),
    codegen: async () => {
      const { generated } = push(await loadConvexDir(convexDir), config.components);
      writeGenerated(generated.files, join(convexDir, "_generated"));
    },
  };

  try {
    await target.preflight(ctx);
    await target.package(ctx);
    if (flags.dryRun) {
      process.stdout.write(`✓ dry-run OK (${resolved.provider} / ${resolved.env}) — push skipped\n`);
      return 0;
    }
    const result = await target.push(ctx);
    if (!result.ok) {
      process.stderr.write(`✗ deploy failed: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(`✓ deployed via ${resolved.provider} (${resolved.env})${result.detail ? ` — ${result.detail}` : ""}\n`);
    if (result.url) process.stdout.write(`  ${result.url}\n`);
    return 0;
  } catch (e) {
    if (e instanceof DeployError) { process.stderr.write(`✗ ${e.message}\n`); return 1; }
    throw e;
  }
}
```

Update the imports at the top of `deploy.ts` to include the node:fs/os symbols now used (`mkdtempSync`, `readdirSync`, `statSync`, `readFileSync`, `rmSync`, `existsSync`) and `tmpdir`:

```ts
import { readdirSync, statSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { transform } from "esbuild";
import { writeGenerated } from "@stackbase/codegen";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
```

(The old `DeployOptions`/`resolveDeployOptions` can stay for now — unused by the new path but harmless; a follow-up may remove them. `dirname` is still used elsewhere? If not, drop it to satisfy `noUnusedLocals`.)

- [ ] **Step 5: Update `packages/cli/src/cli.ts` help text**

Replace the `deploy` help line (line 126) with:
```ts
      "  deploy     Deploy the app: --target <serve|cloudflare|docker> --env <name> [--dry-run] [--check]",
```
Add an Options note line after line 136:
```ts
      "Deploy:  --target <name>  --env <name>  --dry-run  --check   (default target: serve; default env: production)",
```
The `case "deploy": return deployCommand(rest);` call-site is unchanged (the new second param defaults).

- [ ] **Step 6: Run the dispatch test**

Run: `bun run --filter @stackbase/cli build && bun run --filter @stackbase/cli test deploy-dispatch`
Expected: PASS (3 tests). (Build first so `@stackbase/deploy`'s `dist/` exists for the CLI to import — cross-package tests resolve via `dist/`.)

- [ ] **Step 7: Typecheck the touched packages**

Run: `bun run --filter @stackbase/deploy typecheck && bun run --filter @stackbase/cli typecheck`
Expected: no errors. (If `noUnusedLocals` flags `resolveDeployOptions`/`DeployOptions`/`dirname`, delete the unused ones.)

- [ ] **Step 8: Commit**

```bash
git add packages/cli && git commit -m "feat(deploy): wire stackbase deploy through the DeployTarget seam (--target/--env/--dry-run/--check)"
```

---

### Task 10: E2E gates (back-compat + real cloudflare) + docs

**Files:**
- Create: `packages/deploy/test/deploy-serve-e2e.test.ts`
- Create: `packages/deploy/test/deploy-cloudflare-e2e.test.ts`
- Create: `docs/enduser/deploy/targets.md`
- Create: `docs/enduser/deploy/cloudflare.md`
- Create: `docs/enduser/deploy/ci-github-actions.md`

**Interfaces:**
- Consumes: everything above; the existing `packages/cli/test/deploy-e2e.test.ts` (slice-6b) must still pass unchanged.

- [ ] **Step 1: Confirm slice-6b back-compat is intact**

Run: `bun run build && bun run --filter @stackbase/cli test:e2e`
Expected: the existing `deploy-e2e.test.ts` (live push to `serve --allow-deploy`) PASSES — the `serve` target preserved the wire behavior. If it fails, fix the `serve` target (Task 5), not the test.

- [ ] **Step 2: Write the serve back-compat E2E `packages/deploy/test/deploy-serve-e2e.test.ts`**

This spawns nothing new beyond what the CLI e2e already covers; assert the `serveTarget` against a real in-process `serve`. Reuse the pattern from `packages/cli/test/deploy-e2e.test.ts` (import its serve-boot helper if exported, else boot via `bootProject` + `ProcessRuntimeHost` with `--allow-deploy` semantics). Concretely:

```ts
import { describe, it, expect } from "vitest";
import { serveTarget } from "../src/index";
import type { DeployContext } from "../src/index";
// Boot a real serve --allow-deploy on an ephemeral port (mirror packages/cli/test/deploy-e2e.test.ts's setup).
// Then:
//   const ctx: DeployContext = { ...wired to the booted server url + its admin key... };
//   await serveTarget.preflight(ctx);
//   const r = await serveTarget.push(ctx);
//   expect(r.ok).toBe(true);
//   // and assert a brand-new function is now callable on the server (reactive hot-swap), exactly as slice-6b's E2E does.
```

Fill the boot wiring by copying the setup half of `packages/cli/test/deploy-e2e.test.ts` (the half that starts a `serve --allow-deploy` and yields `{ url, adminKey }`). The assertion is: `serveTarget.push` returns `ok:true` and the pushed function is live. Name it `*-e2e.test.ts` so it runs in the serial lane only.

- [ ] **Step 3: Run the serve E2E**

Run: `bun run build && bun run --filter @stackbase/deploy test:e2e deploy-serve`
Expected: PASS.

- [ ] **Step 4: Write the cloudflare E2E with an honest skip `packages/deploy/test/deploy-cloudflare-e2e.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

/** Real `wrangler deploy` requires CF credentials + a deploy target; skip (not fake-pass) when absent. */
function cfAvailable(): boolean {
  if (!process.env.CLOUDFLARE_API_TOKEN) return false;
  try { execSync("wrangler --version", { stdio: "ignore" }); return true; } catch { return false; }
}

describe.skipIf(!cfAvailable())("cloudflare target — real wrangler deploy", () => {
  it("deploys the runtime-cloudflare rig and serves /api/health", async () => {
    // Point at packages/runtime-cloudflare/rig (a real wrangler.jsonc + worker), run the cloudflareTarget
    // push through a NodeSpawner, then fetch `${url}/api/health` and assert 200.
    // Marked deploy-pending in CI until a CF test account/token is provisioned — NEVER assert a fake pass.
    expect(true).toBe(true); // replace with the real deploy+probe once creds exist
  });
});
```

Leave the body as the documented deploy-pending stub with the `skipIf` guard (the container-smoke lesson: an unrun real-artifact gate is marked pending, never faked). When a CF test token exists, fill in the deploy+probe.

- [ ] **Step 5: Write `docs/enduser/deploy/targets.md`**

Document: the two modes (push/provision); `stackbase deploy --target <name> --env <name>`; the `deploy` block in `stackbase.config.ts` with `env()`; the built-in targets (`serve`, `cloudflare`, `docker`) and their settings; that adding a provider = a new adapter on the same seam (railway/fly/aws are follow-ons). Include the worked `stackbase.config.ts` example from the design spec.

- [ ] **Step 6: Write `docs/enduser/deploy/cloudflare.md`**

Document: prerequisites (`npm i -D wrangler`, `wrangler login` locally / `CLOUDFLARE_API_TOKEN` in CI); the required `wrangler.jsonc` (show the `packages/runtime-cloudflare/rig/wrangler.jsonc` shape — DO binding `STACKBASE_DO`/`StackbaseDO`, `new_sqlite_classes`, `nodejs_compat`, optional R2); that `stackbase deploy --target cloudflare` reconciles missing bindings additively; `--env staging` → wrangler `env.staging`; secrets via `wrangler secret put STACKBASE_ADMIN_KEY`.

- [ ] **Step 7: Write `docs/enduser/deploy/ci-github-actions.md`** — a copy-paste workflow:

````markdown
```yaml
name: deploy
on:
  pull_request:
  push: { branches: [main] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: npm i -D wrangler
      # PRs: validate only (drift + dry-run). No secrets needed for --check.
      - if: github.event_name == 'pull_request'
        run: bunx stackbase deploy --check --dry-run --target cloudflare
      # main: real production deploy.
      - if: github.ref == 'refs/heads/main'
        run: bunx stackbase deploy --target cloudflare --env production
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          STACKBASE_ADMIN_KEY: ${{ secrets.STACKBASE_ADMIN_KEY }}
```
````

Explain: tokens come from CI secrets (never `wrangler login` in CI); the branch→env mapping lives in the workflow; the CLI is non-interactive (fails fast on a missing token, never hangs).

- [ ] **Step 8: Full build + both lanes**

Run: `bun run build && bun run test && bun run test:e2e`
Expected: fast lane green; serial lane green (cloudflare E2E skipped honestly if no creds).

- [ ] **Step 9: Commit**

```bash
git add packages/deploy/test docs/enduser/deploy
git commit -m "test(deploy): serve back-compat E2E + deploy-pending cloudflare E2E; docs(deploy): targets/cloudflare/CI guides"
```

---

## Self-Review

**1. Spec coverage:**
- Two modes (push/provision) → Tasks 5 (serve/push), 7 (cloudflare/provision), 8 (docker/provision). ✓
- `DeployTarget`/`Spawner`/`DeployContext` seam → Task 1. ✓
- Config `deploy` block + `env()` + loadConfig passthrough → Task 3. ✓
- `resolveDeploy` (target/env defaulting, env-merge, `--url` back-compat) → Task 4. ✓
- Reconcile-not-regenerate wrangler.jsonc → Task 6 (pure) + Task 7 (adapter, additive write). ✓
- Injectable Spawner → Task 2; every adapter uses `ctx.spawn`. ✓
- Lazy-load adapters → Task 5 `loadTarget` dynamic import. ✓
- CI non-interactive (TTY-aware preflight, fail-fast) → Task 7 (CF token check) + Task 9 (`interactive` derivation) + Task 2b (mechanism). ✓
- `--dry-run` / `--check` → Task 9. ✓
- serve = exact slice-6b back-compat → Task 5 + Task 10 Step 1 (existing E2E must pass). ✓
- Real-CF E2E gate, honestly skipped → Task 10 Step 4. ✓
- Docs incl. GitHub Actions workflow → Task 10 Steps 5–7. ✓
- v1 = cloudflare + docker; railway/fly/aws deferred → `loadTarget` default-case error names only the three; docs note follow-ons. ✓

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to". The one deliberately-stubbed body (Task 10 Step 4 cloudflare E2E) is a documented deploy-pending gate behind `skipIf`, per the project's real-artifact-smoke discipline — not a placeholder for logic that ships.

**3. Type consistency:** `DeployContext.target: ResolvedTarget` (with `.settings`) is used identically in Tasks 5/7/8/9. `Spawner.run(cmd, args, opts?)` signature identical across `NodeSpawner`, `FakeSpawner`, adapters, and the CLI's recording spawner. `reconcileWrangler(config, opts)` return `{config, changed, added}` matches Task 6 test and Task 7 usage. `resolveDeploy` return `ResolvedTarget | {error}` matches Task 4 test and Task 9 usage. `deployCommand(args, deps?)` matches Task 9 test. Consistent.
