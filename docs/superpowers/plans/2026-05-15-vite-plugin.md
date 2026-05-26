# `@stackbase/vite` Single-Origin Dev Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Vite plugin (`plugins: [stackbase()]`) that spawns `stackbase dev` and injects Vite's dev-proxy so `vite` alone serves frontend + backend on one browser origin — no manual proxy, no CORS, any deploy target.

**Architecture:** Auto-proxy a spawned child. Three Vite hooks: `config` resolves a backend port and injects `server.proxy` for the engine-owned prefixes; `configureServer` spawns `stackbase dev --port <port>`, pipes its logs, and awaits port readiness; cleanup kills the child on close + signals. Codegen, hot-reload, and the WebSocket are all the child's job — reused verbatim, zero divergence.

**Tech Stack:** TypeScript (ESM), Bun + Turborepo, `tsup` build, `vitest`, `node:net` (free-port + readiness probe), `node:child_process` (spawn), `vite` (peer). No `@stackbase/*` runtime dependency.

## Global Constraints

- **Runtime dependencies: node builtins only.** `@stackbase/vite` invokes the `stackbase` CLI as a subprocess; it must NOT take any `@stackbase/*` runtime dependency. Peer dep: `vite`.
- **The browser experience is single-origin:** every request goes to Vite's port; the plugin proxies `/api` (with `ws: true` for `/api/sync`), `/_dashboard`, `/_admin` to `http://127.0.0.1:<backendPort>`.
- **Reuse `stackbase dev` verbatim** — the plugin implements no codegen, no hot-reload, no WebSocket handling. The child does all of it.
- **Await readiness before the dev server accepts connections** (poll the backend port) so there is no dead-proxy window; a child that exits before ready or a readiness timeout throws a clear error.
- **Never leak an orphaned child** — idempotent cleanup on Vite server close AND on `SIGINT`/`SIGTERM`/`exit`.
- **Merge, never clobber, the user's `server.proxy`** — the `config` hook returns only the engine prefixes; Vite merges them with the user's config.
- **Two test lanes:** fast (`*.test.ts`, injected fakes) and serial E2E (`*-e2e.test.ts`, real Vite + real `stackbase dev`). Run `bun run --filter @stackbase/vite build` on every task (not just test+typecheck).

---

## Canonical Interfaces (defined across Tasks 1–4)

```ts
// src/free-port.ts (Task 1)
export function freePort(): Promise<number>;

// src/resolve-cli.ts (Task 2)
export interface ResolvedCli { command: string; baseArgs: string[]; }
export function resolveCli(cwd: string, override?: string): ResolvedCli;
export function buildDevArgs(baseArgs: string[], port: number, convexDir: string, extra: string[]): string[];

// src/child.ts (Task 3)
export interface SpawnedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedChild;
export type ProbeFn = (port: number) => Promise<boolean>;
export interface StartBackendOptions {
  command: string; args: string[]; cwd: string; port: number;
  readinessTimeoutMs?: number; pollIntervalMs?: number; onLog?: (line: string) => void;
}
export interface Backend { stop: () => void; }
export function startBackend(opts: StartBackendOptions, deps: { spawn: SpawnFn; probe: ProbeFn }): Promise<Backend>;
export function probePort(port: number, host?: string): Promise<boolean>;
export interface CleanupProc { once(ev: string, cb: (...a: unknown[]) => void): void; }
export function installSignalCleanup(stop: () => void, proc?: CleanupProc, exit?: (code: number) => void): void;

// src/index.ts (Task 4)
export interface StackbaseVitePluginOptions { convexDir?: string; port?: number; command?: string; args?: string[]; }
export function stackbase(options?: StackbaseVitePluginOptions): import("vite").Plugin;
```

---

### Task 1: Scaffold `@stackbase/vite` + `free-port.ts`

**Files:**
- Create: `packages/vite/package.json`, `packages/vite/tsconfig.json`, `packages/vite/tsup.config.ts`
- Create: `packages/vite/src/free-port.ts`, `packages/vite/src/index.ts`
- Test: `packages/vite/test/free-port.test.ts`

**Interfaces:** Produces `freePort()`.

- [ ] **Step 1: Create `packages/vite/package.json`**

```json
{
  "name": "@stackbase/vite",
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
  "peerDependencies": { "vite": ">=5.0.0" },
  "devDependencies": {
    "@stackbase/cli": "workspace:*",
    "@types/node": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vite": "^6.0.7",
    "vitest": "catalog:"
  }
}
```

(`@stackbase/cli` is a **devDependency** — used only by the E2E to spawn a real `stackbase dev`; it is NOT a runtime dependency of the plugin.)

- [ ] **Step 2: Create `packages/vite/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": ".", "outDir": "dist", "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `packages/vite/tsup.config.ts`**

```ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/index.ts"], format: ["esm"], dts: true, sourcemap: true, clean: true, target: "es2022" });
```

- [ ] **Step 4: Write the failing test `packages/vite/test/free-port.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { createServer } from "node:net";
import { freePort } from "../src/free-port";

describe("freePort", () => {
  it("returns a positive port number that is actually bindable", async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    // Prove it's usable: we can listen on it (it was released after probing).
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.on("error", reject);
      srv.listen(port, () => srv.close(() => resolve()));
    });
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `bun run --filter @stackbase/vite test free-port`
Expected: FAIL (`../src/free-port` not found). (First run `bun install` to link the new package.)

- [ ] **Step 6: Create `packages/vite/src/free-port.ts`**

```ts
import { createServer } from "node:net";

/** Resolve an OS-assigned free TCP port (listen on 0, read it, release it). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("could not resolve a free port"))));
    });
  });
}
```

- [ ] **Step 7: Create `packages/vite/src/index.ts`** (barrel for now — the plugin lands in Task 4)

```ts
export { freePort } from "./free-port";
```

- [ ] **Step 8: Install + run + build**

Run: `bun install && bun run --filter @stackbase/vite test free-port && bun run --filter @stackbase/vite build`
Expected: test PASS, build exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/vite && git commit -m "feat(vite): scaffold @stackbase/vite + freePort"
```

---

### Task 2: `resolve-cli.ts` — `resolveCli` + `buildDevArgs` (pure)

**Files:**
- Create: `packages/vite/src/resolve-cli.ts`
- Modify: `packages/vite/src/index.ts`
- Test: `packages/vite/test/resolve-cli.test.ts`

**Interfaces:** Produces `resolveCli(cwd, override?)`, `buildDevArgs(baseArgs, port, convexDir, extra)`.

- [ ] **Step 1: Write the failing test `packages/vite/test/resolve-cli.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCli, buildDevArgs } from "../src/resolve-cli";

describe("resolveCli", () => {
  const dirs: string[] = [];
  afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });

  it("splits an explicit override into command + baseArgs", () => {
    expect(resolveCli("/x", "bun run stackbase")).toEqual({ command: "bun", baseArgs: ["run", "stackbase"] });
    expect(resolveCli("/x", "stackbase")).toEqual({ command: "stackbase", baseArgs: [] });
  });

  it("uses node_modules/.bin/stackbase when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-")); dirs.push(dir);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "stackbase"), "#!/bin/sh\n");
    expect(resolveCli(dir)).toEqual({ command: join(dir, "node_modules", ".bin", "stackbase"), baseArgs: [] });
  });

  it("falls back to `npx stackbase` when there is no local bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-")); dirs.push(dir);
    expect(resolveCli(dir)).toEqual({ command: "npx", baseArgs: ["stackbase"] });
  });
});

describe("buildDevArgs", () => {
  it("assembles the dev argv with port, dir, and forwarded extras", () => {
    expect(buildDevArgs([], 3210, "convex", [])).toEqual(["dev", "--port", "3210", "--dir", "convex"]);
    expect(buildDevArgs(["stackbase"], 4000, "backend", ["--database-url", "pg://x"])).toEqual([
      "stackbase", "dev", "--port", "4000", "--dir", "backend", "--database-url", "pg://x",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/vite test resolve-cli`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/vite/src/resolve-cli.ts`**

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedCli {
  command: string;
  baseArgs: string[];
}

/** How to invoke the stackbase CLI: an explicit override (split on whitespace), else the app's local
 *  `node_modules/.bin/stackbase`, else `npx stackbase`. */
export function resolveCli(cwd: string, override?: string): ResolvedCli {
  if (override && override.trim()) {
    const [command, ...baseArgs] = override.trim().split(/\s+/);
    return { command: command!, baseArgs };
  }
  const localBin = join(cwd, "node_modules", ".bin", "stackbase");
  if (existsSync(localBin)) return { command: localBin, baseArgs: [] };
  return { command: "npx", baseArgs: ["stackbase"] };
}

/** Assemble the `dev` argv: `[...baseArgs, "dev", "--port", <port>, "--dir", <convexDir>, ...extra]`. */
export function buildDevArgs(baseArgs: string[], port: number, convexDir: string, extra: string[]): string[] {
  return [...baseArgs, "dev", "--port", String(port), "--dir", convexDir, ...extra];
}
```

- [ ] **Step 4: Export from `packages/vite/src/index.ts`** — add:

```ts
export { resolveCli, buildDevArgs, type ResolvedCli } from "./resolve-cli";
```

- [ ] **Step 5: Run tests + build**

Run: `bun run --filter @stackbase/vite test resolve-cli && bun run --filter @stackbase/vite build`
Expected: tests PASS (4), build exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/vite && git commit -m "feat(vite): resolveCli (local bin / npx / override) + buildDevArgs"
```

---

### Task 3: `child.ts` — `probePort` + `startBackend` + `installSignalCleanup`

**Files:**
- Create: `packages/vite/src/child.ts`
- Modify: `packages/vite/src/index.ts`
- Test: `packages/vite/test/child.test.ts`

**Interfaces:** Produces `probePort`, `startBackend`, `installSignalCleanup`, `SpawnFn`, `ProbeFn`, `Backend`, `SpawnedChild`, `StartBackendOptions`, `CleanupProc` (see Canonical Interfaces).

- [ ] **Step 1: Write the failing test `packages/vite/test/child.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startBackend, installSignalCleanup, type SpawnedChild } from "../src/child";

/** A fake child process: EventEmitter for "exit", PassThrough stdout/stderr, a kill() spy. */
function fakeChild(): SpawnedChild & EventEmitter & { kill: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const child = Object.assign(ee, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  return child as never;
}

describe("startBackend", () => {
  it("resolves once the probe reports ready, and pipes log lines", async () => {
    const child = fakeChild();
    const logs: string[] = [];
    let calls = 0;
    const probe = vi.fn(async () => ++calls >= 2); // ready on the 2nd poll
    const backend = await startBackend(
      { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1, onLog: (l) => logs.push(l) },
      { spawn: () => child, probe },
    );
    (child.stdout as PassThrough).write("hello\nworld\n");
    await new Promise((r) => setTimeout(r, 5));
    expect(logs).toContain("hello");
    expect(logs).toContain("world");
    expect(probe).toHaveBeenCalled();
    backend.stop();
    expect(child.kill).toHaveBeenCalledTimes(1);
    backend.stop(); // idempotent
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects when the child exits before becoming ready", async () => {
    const child = fakeChild();
    const probe = vi.fn(async () => false);
    const p = startBackend(
      { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1 },
      { spawn: () => child, probe },
    );
    setTimeout(() => child.emit("exit", 1), 3);
    await expect(p).rejects.toThrow(/exited before/);
  });

  it("rejects on readiness timeout", async () => {
    const child = fakeChild();
    const probe = vi.fn(async () => false);
    await expect(
      startBackend(
        { command: "x", args: ["dev"], cwd: "/tmp", port: 9999, pollIntervalMs: 1, readinessTimeoutMs: 15 },
        { spawn: () => child, probe },
      ),
    ).rejects.toThrow(/did not become ready/);
  });
});

describe("installSignalCleanup", () => {
  it("calls stop on SIGINT and then exits", () => {
    const proc = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.fn();
    installSignalCleanup(stop, proc as never, exit);
    proc.emit("SIGINT");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(130);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/vite test child`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `packages/vite/src/child.ts`**

```ts
import { connect } from "node:net";

export interface SpawnedChild {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(ev: "exit", cb: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): void;
}
export type SpawnFn = (command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => SpawnedChild;
export type ProbeFn = (port: number) => Promise<boolean>;

export interface StartBackendOptions {
  command: string;
  args: string[];
  cwd: string;
  port: number;
  readinessTimeoutMs?: number;
  pollIntervalMs?: number;
  onLog?: (line: string) => void;
}
export interface Backend { stop: () => void; }

/** True once something accepts a TCP connection on the port (the backend is up). */
export function probePort(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ port, host });
    const done = (ok: boolean) => { sock.destroy(); resolve(ok); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** Spawn the backend child, pipe its output line-wise to `onLog`, and resolve once it's ready.
 *  Rejects if the child exits before ready or readiness times out. `stop` kills the child once. */
export async function startBackend(opts: StartBackendOptions, deps: { spawn: SpawnFn; probe: ProbeFn }): Promise<Backend> {
  const child = deps.spawn(opts.command, opts.args, { cwd: opts.cwd, env: process.env });
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; try { child.kill("SIGTERM"); } catch { /* already gone */ } };

  const pipe = (stream: NodeJS.ReadableStream | null) => {
    stream?.on("data", (d: Buffer | string) => {
      for (const line of d.toString().split("\n")) if (line.trim()) opts.onLog?.(line);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  let exited = false;
  let exitCode: number | null = null;
  child.on("exit", (code) => { exited = true; exitCode = code; });

  const timeout = opts.readinessTimeoutMs ?? 30_000;
  const interval = opts.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (exited) { stop(); throw new Error(`stackbase dev exited before becoming ready (code ${exitCode})`); }
    if (await deps.probe(opts.port)) return { stop };
    await new Promise((r) => setTimeout(r, interval));
  }
  stop();
  throw new Error(`stackbase dev did not become ready on port ${opts.port} within ${timeout}ms`);
}

export interface CleanupProc { once(ev: string, cb: (...a: unknown[]) => void): void; }

/** Ensure the child is killed on Vite/process teardown. Kills on `exit` (backstop) and re-exits on
 *  SIGINT/SIGTERM after killing (so the child never orphans). Injectable proc/exit for tests. */
export function installSignalCleanup(
  stop: () => void,
  proc: CleanupProc = process,
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  proc.once("exit", () => stop());
  proc.once("SIGINT", () => { stop(); exit(130); });
  proc.once("SIGTERM", () => { stop(); exit(143); });
}
```

- [ ] **Step 4: Export from `packages/vite/src/index.ts`** — add:

```ts
export { probePort, startBackend, installSignalCleanup } from "./child";
export type { SpawnFn, ProbeFn, Backend, SpawnedChild, StartBackendOptions, CleanupProc } from "./child";
```

- [ ] **Step 5: Run tests + build**

Run: `bun run --filter @stackbase/vite test child && bun run --filter @stackbase/vite build`
Expected: child tests PASS (4), build exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/vite && git commit -m "feat(vite): child — probePort, startBackend (readiness + idempotent stop), signal cleanup"
```

---

### Task 4: `index.ts` — the `stackbase()` plugin

**Files:**
- Modify: `packages/vite/src/index.ts` (add the plugin + a `nodeSpawn` adapter)
- Test: `packages/vite/test/plugin.test.ts`

**Interfaces:**
- Consumes: `freePort` (T1), `resolveCli`/`buildDevArgs` (T2), `startBackend`/`probePort`/`installSignalCleanup` (T3).
- Produces: `stackbase(options?)`, `StackbaseVitePluginOptions`.

- [ ] **Step 1: Write the failing test `packages/vite/test/plugin.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { stackbase } from "../src/index";

describe("stackbase() plugin — config hook", () => {
  it("injects the engine-owned proxy entries at the resolved port, with ws on /api", async () => {
    const plugin = stackbase({ port: 4567 });
    // `config` may be a function; call it to get the partial config it contributes.
    const configHook = typeof plugin.config === "function" ? plugin.config : (plugin.config as { handler: typeof plugin.config })?.handler;
    const cfg = (await (configHook as (c: unknown, e: unknown) => unknown)({}, { command: "serve" })) as {
      server: { proxy: Record<string, { target: string; ws?: boolean }> };
    };
    const proxy = cfg.server.proxy;
    expect(proxy["/api"]).toMatchObject({ target: "http://127.0.0.1:4567", ws: true });
    expect(proxy["/_dashboard"]).toMatchObject({ target: "http://127.0.0.1:4567" });
    expect(proxy["/_admin"]).toMatchObject({ target: "http://127.0.0.1:4567" });
    // Only the engine prefixes — nothing else.
    expect(Object.keys(proxy).sort()).toEqual(["/_admin", "/_dashboard", "/api"]);
  });

  it("has the plugin name and a configureServer hook", () => {
    const plugin = stackbase();
    expect(plugin.name).toBe("stackbase");
    expect(plugin.configureServer).toBeTypeOf("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/vite test plugin`
Expected: FAIL (`stackbase` not exported).

- [ ] **Step 3: Add the plugin to `packages/vite/src/index.ts`** (keep the existing re-exports; append)

```ts
import { spawn as nodeChildSpawn } from "node:child_process";
import type { Plugin } from "vite";
import { freePort } from "./free-port";
import { resolveCli, buildDevArgs } from "./resolve-cli";
import { startBackend, probePort, installSignalCleanup, type SpawnFn, type Backend } from "./child";

export interface StackbaseVitePluginOptions {
  /** App functions dir → `--dir` (default "convex"). */
  convexDir?: string;
  /** Backend port to proxy to (default: an OS-assigned free port). */
  port?: number;
  /** How to invoke the CLI (default: local node_modules/.bin/stackbase, else `npx stackbase`). */
  command?: string;
  /** Extra flags forwarded to `stackbase dev` (e.g. ["--database-url", "postgres://…"]). */
  args?: string[];
}

/** Adapt node's `spawn` to the SpawnFn seam. */
const nodeSpawn: SpawnFn = (command, args, opts) =>
  nodeChildSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Single-origin dev: spawn `stackbase dev` and proxy the engine-owned prefixes to it, so `vite` alone
 * serves the frontend AND backend on one browser origin (no manual proxy, no CORS).
 */
export function stackbase(options: StackbaseVitePluginOptions = {}): Plugin {
  let port: number;
  let backend: Backend | undefined;
  return {
    name: "stackbase",
    async config() {
      port = options.port ?? (await freePort());
      const target = `http://127.0.0.1:${port}`;
      return {
        server: {
          proxy: {
            "/api": { target, ws: true, changeOrigin: true },
            "/_dashboard": { target, changeOrigin: true },
            "/_admin": { target, changeOrigin: true },
          },
        },
      };
    },
    async configureServer(server) {
      const root = server.config.root;
      const cli = resolveCli(root, options.command);
      const args = buildDevArgs(cli.baseArgs, port, options.convexDir ?? "convex", options.args ?? []);
      backend = await startBackend(
        { command: cli.command, args, cwd: root, port, onLog: (l) => server.config.logger.info(`[stackbase] ${l}`) },
        { spawn: nodeSpawn, probe: probePort },
      );
      const stop = () => backend?.stop();
      server.httpServer?.once("close", stop);
      installSignalCleanup(stop);
    },
  };
}
```

- [ ] **Step 4: Run tests + build + typecheck**

Run: `bun run --filter @stackbase/vite test plugin && bun run --filter @stackbase/vite build && bun run --filter @stackbase/vite typecheck`
Expected: plugin tests PASS (2), build exit 0, typecheck clean. If the `Plugin.config` type shape makes the test's hook-extraction awkward, keep the test's runtime behavior (call the hook, assert the proxy) — adjust only the hook-extraction lines to match Vite 6's `config` object/function union, never weaken the proxy assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/vite && git commit -m "feat(vite): stackbase() plugin — proxy injection + spawn stackbase dev + cleanup"
```

---

### Task 5: E2E (real Vite + real `stackbase dev`) + docs

**Files:**
- Create: `packages/vite/test/vite-plugin-e2e.test.ts`
- Create: `packages/vite/test/fixture/convex/schema.ts`, `packages/vite/test/fixture/convex/health.ts`
- Create: `docs/enduser/local/vite-plugin.md`

**Interfaces:** Consumes the whole plugin; uses Vite's programmatic `createServer` and the built `stackbase` CLI.

- [ ] **Step 1: Create the convex fixture**

`packages/vite/test/fixture/convex/schema.ts`:
```ts
import { defineSchema, defineTable, v } from "@stackbase/values";
export default defineSchema({ notes: defineTable({ text: v.string() }) });
```

`packages/vite/test/fixture/convex/health.ts`:
```ts
import { query } from "./_generated/server";
export const ping = query({ args: {}, handler: async () => "ok" });
```

(The `_generated` dir is produced by `stackbase dev`'s codegen on boot — do not hand-write it.)

- [ ] **Step 2: Write the E2E `packages/vite/test/vite-plugin-e2e.test.ts`**

```ts
import { describe, it, expect, afterAll } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket } from "ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stackbase } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixture");
// Spawn the built CLI directly (deterministic in-repo) rather than relying on a resolved bin.
const cliBin = join(here, "..", "..", "cli", "dist", "bin.js");

describe("@stackbase/vite — single-origin dev (real Vite + real stackbase dev)", () => {
  let vite: ViteDevServer | undefined;
  afterAll(async () => { await vite?.close(); });

  it("proxies /api/health (200) and /api/sync (ws upgrade) through Vite to the engine", async () => {
    vite = await createViteServer({
      root: fixtureRoot,
      logLevel: "warn",
      server: { port: 0 }, // OS-assigned Vite port
      plugins: [stackbase({ convexDir: "convex", command: `${process.execPath} ${cliBin}` })],
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    const vitePort = typeof address === "object" && address ? address.port : 0;
    expect(vitePort).toBeGreaterThan(0);

    // Proof 1: HTTP /api/health proxies to the engine and returns 200.
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/health`);
    expect(res.status).toBe(200);

    // Proof 2: the /api/sync WebSocket upgrade proxies (ws:true) and connects.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${vitePort}/api/sync`);
      const t = setTimeout(() => { ws.close(); reject(new Error("ws did not open")); }, 10_000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
  }, 60_000);
});
```

Add `ws` + `@types/ws` to `packages/vite/package.json` devDependencies (the CLI package already uses `ws`; mirror its versions) so the E2E can open a raw client socket:
```json
    "ws": "^8.18.0",
    "@types/ws": "^8.5.13",
```
(Confirm the exact versions against `packages/cli/package.json` and match them.)

- [ ] **Step 3: Run the E2E**

Run: `bun run build && bun run --filter @stackbase/vite test:e2e`
Expected: PASS. The plugin spawns the built CLI (`node .../cli/dist/bin.js dev --port <free> --dir convex`) in the fixture, codegen runs, readiness is awaited, then both proxied requests succeed. If it flakes on the WS timing, raise the per-test timeout — never assert a fake pass; if the CLI can't boot in the fixture, report specifics.

- [ ] **Step 4: Write `docs/enduser/local/vite-plugin.md`**

Document: install (`@stackbase/vite`, dev dep); `vite.config.ts` → `import { stackbase } from "@stackbase/vite"; export default defineConfig({ plugins: [stackbase()] })`; what it does (one `vite` command → frontend + backend on one origin, no proxy/CORS, `location.host` works); the options table (`convexDir`/`port`/`command`/`args`); that it **complements** `stackbase dev` (still use `stackbase dev` for backend-only/non-Vite work, and `stackbase codegen`/`deploy` are unchanged); and the Phase-2 note that an in-process embed may follow.

- [ ] **Step 5: Full build + both lanes**

Run: `bun run build && bun run --filter @stackbase/vite test && bun run --filter @stackbase/vite test:e2e`
Expected: fast lane green, E2E green.

- [ ] **Step 6: Commit**

```bash
git add packages/vite/test docs/enduser/local/vite-plugin.md packages/vite/package.json
git commit -m "test(vite): E2E — /api + /api/sync ws proxy through real Vite to real stackbase dev; docs"
```

---

## Self-Review

**1. Spec coverage:**
- Auto-proxy mechanism (spawn dev + inject proxy) → Tasks 3 (spawn) + 4 (proxy). ✓
- `config` injects `/api` (ws), `/_dashboard`, `/_admin` at the resolved port, merging user proxy → Task 4 (Vite merges the returned partial config). ✓
- Free-port resolution → Task 1. ✓
- CLI resolution (local bin / npx / override) + dev argv → Task 2. ✓
- Spawn + await readiness + reject on early-exit/timeout → Task 3. ✓
- Idempotent cleanup on close + signals → Task 3 (`installSignalCleanup`) + Task 4 (wires `httpServer close` + `installSignalCleanup`). ✓
- Log piping `[stackbase]` → Task 3 (`onLog`) + Task 4 (logger). ✓
- Options `convexDir`/`port`/`command`/`args` → Task 4. ✓
- Node-builtins-only runtime deps (`@stackbase/cli`/`vite`/`ws` are dev/peer only) → Task 1/5 package.json. ✓
- E2E: `/api/health` 200 + `/api/sync` ws connect through real Vite + real dev → Task 5. ✓
- Docs → Task 5. ✓
- Phase-2 embed deferred → documented in Task 5 docs, not built. ✓

**2. Placeholder scan:** No TBD/handle-cases/similar-to. The E2E's exact `ws`/`@types/ws` versions are given as `^8.18.0`/`^8.5.13` with an instruction to match `packages/cli`'s — a concrete value plus a verify step, not a placeholder. The fixture `_generated` is intentionally not written (codegen produces it).

**3. Type consistency:** `freePort(): Promise<number>`, `resolveCli(cwd, override?): {command, baseArgs}`, `buildDevArgs(baseArgs, port, convexDir, extra)`, `startBackend(opts, {spawn, probe}): Promise<{stop}>`, `probePort(port, host?)`, `installSignalCleanup(stop, proc?, exit?)`, and `stackbase(options?): Plugin` are used identically across Tasks 1–5. `SpawnFn`/`Backend` shapes match between `child.ts` (T3) and the `nodeSpawn` adapter + plugin wiring (T4).
