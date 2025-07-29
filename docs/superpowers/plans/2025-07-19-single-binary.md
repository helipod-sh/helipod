# `stackbase build` — Single-Binary Compilation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `stackbase build`, which compiles a Stackbase app into a single self-contained executable (Bun runtime + engine + `bun:sqlite` + the app's `convex/` functions + composed components + optional dashboard) via `bun build --compile`.

**Architecture:** `bun build --compile` only bundles *statically imported* code, so `build` codegens an entrypoint that statically imports the app's modules/schema/config + embedded dashboard files, reconstructs the `{schema, modules}` shape `loadConvexDir` returns at runtime, and hands it to a new `bootLoaded()` core split out of `bootProject`. The produced binary runs a compiled `serve` (`runBinaryServer`) that emits a machine-readable ready-line.

**Tech Stack:** TypeScript, Bun (`bun build --compile`), the existing `@stackbase/cli` boot/serve machinery, vitest (under Bun).

## Global Constraints

- **Bun is the package manager + runtime.** Never invoke pnpm/npm/yarn. `bun install`, `bun run build|test|typecheck`.
- **Node is fully supported; Bun is primary.** `bun build --compile` is build-time tooling and may be Bun-only for the produced artifact; the engine still runs on Node. Do not break the Node path of anything you touch (`bootProject`/`serve` must keep working under Node).
- **A passing `test` does NOT imply passing `typecheck`.** Integrated verification must run `bun run build && bun run typecheck && bun run test` and grep the output for `error TS` and `Failed:` — a green `test` with a red `typecheck` is a failure.
- **Reality is the single source of truth for docs.** Build the sensible command; rewrite the binary-facing docs to match it. Do not build to the fictional prerequisites in the current docs.
- **Never copy `.reference/` (FSL) code into packages.**
- **Commit only your task's files.** Do not stage unrelated working-tree changes.
- **Commit message trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Module keys must match `loadConvexDir` exactly (filename without `.ts`/`.js`), so the compiled `moduleMap` is byte-identical to the runtime-loaded one.

## File Structure

- `packages/cli/src/boot.ts` — **modify**: extract `bootLoaded({loaded, components, dataPath, adminKey})`; `bootProject` composes it. (Enabling seam.)
- `packages/cli/src/binary-main.ts` — **create**: `resolveBinaryOptions`, `startBinaryServer` (testable core), `runBinaryServer` (argv → core → ready-line → signals). The runtime entry the compiled binary calls.
- `packages/cli/src/build-entry.ts` — **create**: `generateEntrySource(inputs)` — pure entrypoint-source string generator.
- `packages/cli/src/build.ts` — **create**: `resolveBuildOptions`, `bunTargetFor`, `buildCommand` (refresh codegen → codegen entry → `bun build --compile` → cleanup).
- `packages/cli/src/load-modules.ts` — **modify**: export shared `listConvexModuleFiles(absDir)` + `moduleKeyForFile(file)`; refactor `loadConvexDir` to use them (single source of truth for key derivation).
- `packages/cli/src/index.ts` — **modify**: export `runBinaryServer` (so the generated entry imports it by package name).
- `packages/cli/src/cli.ts` — **modify**: `case "build"` + help text.
- `packages/cli/src/server.ts` — **modify (Task 6)**: dashboard seam accepting an embedded file map.
- `packages/cli/test/binary-main.test.ts`, `build-entry.test.ts`, `build.test.ts`, `build-e2e.test.ts` (+ `fixtures/build-app/`) — **create**.
- `docs/enduser/deploy/standalone-binary.md` (+ binary refs in `electrobun.md`/`tauri.md`/`self-hosted.md`), `CLAUDE.md` — **modify (Task 7)**.

---

### Task 1: Split `bootProject` → `bootLoaded` (enabling seam)

**Files:**
- Modify: `packages/cli/src/boot.ts:39-68`
- Test: `packages/cli/test/boot-loaded.test.ts` (create)

**Interfaces:**
- Consumes: `loadConvexDir(dir) -> Promise<LoadedProject>` where `LoadedProject = { schema: SchemaDefinition; modules: Record<string, Record<string, unknown>> }`; `loadConfig(projectDir) -> Promise<{components: ComponentDefinition[]}>`; `push(loaded, components) -> {project, generated}`; existing `BootResult`.
- Produces: `bootLoaded(opts: { loaded: LoadedProject; components: ComponentDefinition[]; dataPath: string; adminKey: string }) -> Promise<BootResult>`; `bootProject` unchanged externally.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/boot-loaded.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConvexDir } from "../src/load-modules";
import { bootLoaded } from "../src/boot";
import { rmSync } from "node:fs";

const DATA = "./.tmp-bootloaded/db.sqlite";
afterEach(() => rmSync("./.tmp-bootloaded", { recursive: true, force: true }));

describe("bootLoaded", () => {
  it("boots a runtime from an already-loaded project (no dir re-scan) and runs a mutation", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v1/convex"); // existing fixture: notes table + notes:list
    const { runtime, adminApi, store } = await bootLoaded({
      loaded, components: [], dataPath: DATA, adminKey: "k",
    });
    expect(typeof runtime.run).toBe("function");
    expect(adminApi.getSchema().tableNumbers.notes).toBe(10001);
    store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test boot-loaded`
Expected: FAIL — `bootLoaded` is not exported.

- [ ] **Step 3: Implement — extract `bootLoaded`, keep `bootProject` as a thin composer**

In `packages/cli/src/boot.ts`, add the `LoadedProject` import and replace the body of `bootProject` (lines 39-68) with:

```ts
import type { LoadedProject } from "./project"; // add to imports

export async function bootLoaded(opts: {
  loaded: LoadedProject;
  components: ComponentDefinition[];
  dataPath: string;
  adminKey: string;
}): Promise<BootResult> {
  const { project, generated } = push(opts.loaded, opts.components);
  const logSink = new InMemoryLogSink();
  const store = makeStore(opts.dataPath);
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    modules: project.moduleMap,
    systemModules: systemModules(),
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(opts.adminKey, key),
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  const adminApi = new AdminApi({
    runtime,
    schemaJson: project.schemaJson,
    tableNumbers: project.tableNumbers,
    manifest: project.manifest,
    logSink,
    catalog: project.catalog,
  });
  return { runtime, adminApi, project, generated, store, logSink, components: opts.components };
}

export async function bootProject(opts: { convexDir: string; dataPath: string; adminKey: string }): Promise<BootResult> {
  const loaded = await loadConvexDir(opts.convexDir);
  const config = await loadConfig(dirname(opts.convexDir));
  return bootLoaded({ loaded, components: config.components, dataPath: opts.dataPath, adminKey: opts.adminKey });
}
```

- [ ] **Step 4: Run tests (new + existing boot users) to verify pass**

Run: `bun run --filter @stackbase/cli test boot-loaded` → PASS.
Run: `bun run --filter @stackbase/cli test serve` and `... test scheduler-e2e` → still PASS (bootProject behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/boot.ts packages/cli/test/boot-loaded.test.ts
git commit -m "refactor(cli): split bootProject into a reusable bootLoaded core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `runBinaryServer` — the compiled binary's runtime entry

**Files:**
- Create: `packages/cli/src/binary-main.ts`
- Modify: `packages/cli/src/index.ts` (export `runBinaryServer`, `startBinaryServer`, `resolveBinaryOptions`)
- Test: `packages/cli/test/binary-main.test.ts`

**Interfaces:**
- Consumes: `bootLoaded` (Task 1); `startDevServer(runtime, { port, ip, admin?, dashboard?, routes? }) -> Promise<DevServer>` (existing); `DevServer.close(): Promise<void>`; `BootResult.project.routes`.
- Produces:
  - `interface BinaryOptions { port: number; ip: string; dataDir: string; adminKey: string }`
  - `resolveBinaryOptions(argv: string[], env: Record<string,string|undefined>) -> BinaryOptions`
  - `startBinaryServer(loaded: LoadedProject, components: ComponentDefinition[], opts: BinaryOptions, dashboard?: EmbeddedDashboard) -> Promise<{ server: DevServer; store: SqliteDocStore }>` (testable core; no signals/exit) — `dashboard` param is `undefined` until Task 6 (type `EmbeddedDashboard` introduced there; declare param as `dashboard?: unknown` here and tighten in Task 6).
  - `runBinaryServer(loaded, components, dashboard?) -> Promise<void>` (argv/env parse → core → ready-line → signal handlers)

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/binary-main.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { loadConvexDir } from "../src/load-modules";
import { resolveBinaryOptions, startBinaryServer } from "../src/binary-main";
import { rmSync } from "node:fs";

afterEach(() => rmSync("./.tmp-binmain", { recursive: true, force: true }));

describe("resolveBinaryOptions", () => {
  it("defaults port 3000 / 0.0.0.0 / ./data and reads flags + admin key env", () => {
    const o = resolveBinaryOptions(["--port", "8080", "--hostname", "127.0.0.1", "--data-dir", "/d"], { STACKBASE_ADMIN_KEY: "sek" });
    expect(o).toEqual({ port: 8080, ip: "127.0.0.1", dataDir: "/d", adminKey: "sek" });
    const d = resolveBinaryOptions([], {});
    expect(d).toEqual({ port: 3000, ip: "0.0.0.0", dataDir: "./data", adminKey: "" });
  });
});

describe("startBinaryServer", () => {
  it("serves a committing mutation from a pre-loaded project (no convex dir at runtime)", async () => {
    const loaded = await loadConvexDir("test/fixtures/deploy-v2/convex"); // notes:list + notes:add
    const { server, store } = await startBinaryServer(loaded, [], { port: 0, ip: "127.0.0.1", dataDir: "./.tmp-binmain", adminKey: "k" });
    const add = await fetch(`${server.url}/api/run`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "notes:add", args: { box: "a", text: "hi" } }),
    });
    expect((await add.json()).committed).toBe(true);
    await server.close(); store.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test binary-main`
Expected: FAIL — module `../src/binary-main` not found.

- [ ] **Step 3: Implement `binary-main.ts`**

```ts
// packages/cli/src/binary-main.ts
/**
 * The runtime entry a `stackbase build` binary calls. It is compiled `serve`: boot an already-loaded
 * project (static imports, not a dir scan), start the shared server, print a machine-readable ready
 * line, and shut down gracefully. `startBinaryServer` is the testable core (no signals/exit).
 */
import { join } from "node:path";
import type { ComponentDefinition } from "@stackbase/component";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { LoadedProject } from "./project";
import { bootLoaded } from "./boot";
import { startDevServer, type DevServer } from "./server";

export interface BinaryOptions { port: number; ip: string; dataDir: string; adminKey: string }

export function resolveBinaryOptions(argv: string[], env: Record<string, string | undefined>): BinaryOptions {
  let port = env.PORT ? Number(env.PORT) : 3000;
  let ip = "0.0.0.0";
  let dataDir = "./data";
  const adminKey = (env.STACKBASE_ADMIN_KEY ?? "").trim();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1] !== undefined) port = Number(argv[++i]);
    else if (a === "--hostname" && argv[i + 1] !== undefined) ip = argv[++i] as string;
    else if (a === "--data-dir" && argv[i + 1] !== undefined) dataDir = argv[++i] as string;
  }
  return { port, ip, dataDir, adminKey };
}

export async function startBinaryServer(
  loaded: LoadedProject,
  components: ComponentDefinition[],
  opts: BinaryOptions,
  dashboard?: unknown, // tightened to EmbeddedDashboard in Task 6
): Promise<{ server: DevServer; store: SqliteDocStore; runtime: EmbeddedRuntime }> {
  const boot = await bootLoaded({ loaded, components, dataPath: join(opts.dataDir, "db.sqlite"), adminKey: opts.adminKey });
  const server = await startDevServer(boot.runtime, {
    port: opts.port,
    ip: opts.ip,
    admin: { api: boot.adminApi, key: opts.adminKey },
    routes: boot.project.routes,
    // dashboard wired in Task 6
  });
  return { server, store: boot.store, runtime: boot.runtime };
}

export async function runBinaryServer(
  loaded: LoadedProject,
  components: ComponentDefinition[],
  dashboard?: unknown,
): Promise<void> {
  const opts = resolveBinaryOptions(process.argv.slice(2), process.env);
  if (!opts.adminKey) {
    process.stderr.write("✗ STACKBASE_ADMIN_KEY is required — set it to a strong secret.\n");
    process.exit(1);
  }
  const { server, store } = await startBinaryServer(loaded, components, opts, dashboard);
  process.stdout.write(JSON.stringify({ ready: true, port: opts.port, url: `http://${opts.ip}:${opts.port}` }) + "\n");
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
```

Add to `packages/cli/src/index.ts` (follow the file's existing export style):

```ts
export { runBinaryServer, startBinaryServer, resolveBinaryOptions } from "./binary-main";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @stackbase/cli test binary-main` → PASS (both describes).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/binary-main.ts packages/cli/src/index.ts packages/cli/test/binary-main.test.ts
git commit -m "feat(cli): runBinaryServer — the compiled-binary runtime entry (compiled serve)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `generateEntrySource` — pure entrypoint-source generator

**Files:**
- Create: `packages/cli/src/build-entry.ts`
- Test: `packages/cli/test/build-entry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface EntryInputs {
    moduleImports: Array<{ key: string; absPath: string }>; // key = loadConvexDir module key
    schemaAbsPath: string;
    configAbsPath: string | null;   // null => components = []
    dashboardFiles: Array<{ urlPath: string; absPath: string }> | null; // null => no dashboard
  }
  function generateEntrySource(inp: EntryInputs): string
  ```
- Consumes: nothing (pure). The generated source imports `runBinaryServer` from `@stackbase/cli` (Task 2) and reconstructs `{schema, modules}` (matches `LoadedProject`).

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/build-entry.test.ts
import { describe, it, expect } from "vitest";
import { generateEntrySource } from "../src/build-entry";

describe("generateEntrySource", () => {
  const base = {
    moduleImports: [{ key: "messages", absPath: "/app/convex/messages.ts" }, { key: "users", absPath: "/app/convex/users.ts" }],
    schemaAbsPath: "/app/convex/schema.ts",
    configAbsPath: "/app/stackbase.config.ts",
    dashboardFiles: null,
  };

  it("statically imports each module, the schema, the config, and runBinaryServer", () => {
    const src = generateEntrySource(base);
    expect(src).toContain(`import * as m0 from "/app/convex/messages.ts"`);
    expect(src).toContain(`import * as m1 from "/app/convex/users.ts"`);
    expect(src).toContain(`import schema from "/app/convex/schema.ts"`);
    expect(src).toContain(`import * as __config from "/app/stackbase.config.ts"`);
    expect(src).toContain(`import { runBinaryServer } from "@stackbase/cli"`);
    expect(src).toContain(`modules: { "messages": m0, "users": m1 }`);
    expect(src).toContain(`const components = (__config.default ?? __config).components ?? []`);
    expect(src).toContain(`runBinaryServer(loaded, components,`);
  });

  it("emits components = [] when there is no config", () => {
    const src = generateEntrySource({ ...base, configAbsPath: null });
    expect(src).not.toContain("__config");
    expect(src).toContain(`const components = []`);
  });

  it("emits a dashboard map of {type:'file'} imports, or undefined when omitted", () => {
    const withDash = generateEntrySource({ ...base, dashboardFiles: [
      { urlPath: "/", absPath: "/d/index.html" },
      { urlPath: "/assets/a.js", absPath: "/d/assets/a.js" },
    ] });
    expect(withDash).toContain(`import d0 from "/d/index.html" with { type: "file" }`);
    expect(withDash).toContain(`import d1 from "/d/assets/a.js" with { type: "file" }`);
    expect(withDash).toContain(`"/": d0`);
    expect(withDash).toContain(`"/assets/a.js": d1`);
    expect(withDash).toContain(`runBinaryServer(loaded, components, dashboard)`);
    expect(generateEntrySource(base)).toContain(`runBinaryServer(loaded, components, undefined)`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test build-entry`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `build-entry.ts`**

```ts
// packages/cli/src/build-entry.ts
/**
 * Pure generator for the `stackbase build` entrypoint. `bun build --compile` only bundles STATIC
 * imports, so we emit static imports of the app's modules/schema/config (+ embedded dashboard files)
 * and reconstruct the `{schema, modules}` shape `loadConvexDir` returns at runtime. `JSON.stringify`
 * on every path/key guards against quotes/backslashes breaking the generated source.
 */
export interface EntryInputs {
  moduleImports: Array<{ key: string; absPath: string }>;
  schemaAbsPath: string;
  configAbsPath: string | null;
  dashboardFiles: Array<{ urlPath: string; absPath: string }> | null;
}

export function generateEntrySource(inp: EntryInputs): string {
  const L: string[] = ["// AUTO-GENERATED by `stackbase build` — do not edit."];
  inp.moduleImports.forEach((m, i) => L.push(`import * as m${i} from ${JSON.stringify(m.absPath)};`));
  L.push(`import schema from ${JSON.stringify(inp.schemaAbsPath)};`);
  if (inp.configAbsPath) L.push(`import * as __config from ${JSON.stringify(inp.configAbsPath)};`);
  (inp.dashboardFiles ?? []).forEach((d, i) => L.push(`import d${i} from ${JSON.stringify(d.absPath)} with { type: "file" };`));
  L.push(`import { runBinaryServer } from "@stackbase/cli";`);
  L.push("");
  const modEntries = inp.moduleImports.map((m, i) => `${JSON.stringify(m.key)}: m${i}`).join(", ");
  L.push(`const loaded = { schema, modules: { ${modEntries} } };`);
  L.push(inp.configAbsPath ? `const components = (__config.default ?? __config).components ?? [];` : `const components = [];`);
  if (inp.dashboardFiles) {
    const dEntries = inp.dashboardFiles.map((d, i) => `${JSON.stringify(d.urlPath)}: d${i}`).join(", ");
    L.push(`const dashboard = { ${dEntries} };`);
    L.push(`await runBinaryServer(loaded, components, dashboard);`);
  } else {
    L.push(`await runBinaryServer(loaded, components, undefined);`);
  }
  return L.join("\n") + "\n";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @stackbase/cli test build-entry` → PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/build-entry.ts packages/cli/test/build-entry.test.ts
git commit -m "feat(cli): generateEntrySource — static-import entrypoint codegen for the binary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `buildCommand` + shared module-file helpers + CLI dispatch

**Files:**
- Create: `packages/cli/src/build.ts`
- Modify: `packages/cli/src/load-modules.ts` (extract `listConvexModuleFiles` + `moduleKeyForFile`; refactor `loadConvexDir` to use them)
- Modify: `packages/cli/src/cli.ts` (`case "build"` + help)
- Test: `packages/cli/test/build.test.ts`

**Interfaces:**
- Consumes: `generateEntrySource` (Task 3); `loadConvexDir`, `loadConfig`, `push`, `writeGenerated` (from `@stackbase/codegen`, called in `devCommand` as `writeGenerated(generated.files, generatedDir)`).
- Produces:
  - `listConvexModuleFiles(absDir: string) -> string[]` and `moduleKeyForFile(file: string) -> string` (exported from `load-modules.ts`)
  - `interface BuildOptions { convexDir: string; outfile: string; target: string | null; dashboard: boolean; verbose: boolean }`
  - `resolveBuildOptions(args: string[]) -> BuildOptions`
  - `bunTargetFor(friendly: string) -> string` (throws on unknown)
  - `buildCommand(args: string[]) -> Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/build.test.ts
import { describe, it, expect } from "vitest";
import { resolveBuildOptions, bunTargetFor } from "../src/build";
import { listConvexModuleFiles, moduleKeyForFile } from "../src/load-modules";

describe("resolveBuildOptions", () => {
  it("defaults and flags", () => {
    expect(resolveBuildOptions([])).toEqual({ convexDir: "convex", outfile: "./stackbase-server", target: null, dashboard: true, verbose: false });
    expect(resolveBuildOptions(["--dir", "cvx", "--outfile", "./out/bin", "--target", "linux-x64", "--no-dashboard", "--verbose"]))
      .toEqual({ convexDir: "cvx", outfile: "./out/bin", target: "linux-x64", dashboard: false, verbose: true });
  });
});

describe("bunTargetFor", () => {
  it("maps friendly names to bun triples and rejects unknown", () => {
    expect(bunTargetFor("linux-x64")).toBe("bun-linux-x64");
    expect(bunTargetFor("darwin-arm64")).toBe("bun-darwin-arm64");
    expect(bunTargetFor("windows-x64")).toBe("bun-windows-x64");
    expect(() => bunTargetFor("plan9-x64")).toThrow(/unknown target/i);
  });
});

describe("shared module-file helpers", () => {
  it("lists function modules (excludes schema/_generated/.d.ts) and derives keys", () => {
    const files = listConvexModuleFiles("test/fixtures/deploy-v2/convex");
    expect(files).toContain("notes.ts");
    expect(files).not.toContain("schema.ts");
    expect(moduleKeyForFile("notes.ts")).toBe("notes");
    expect(moduleKeyForFile("notes.js")).toBe("notes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run --filter @stackbase/cli test build.test`
Expected: FAIL — `../src/build` not found / helpers not exported.

- [ ] **Step 3a: Extract shared helpers in `load-modules.ts`**

Add exports and refactor `loadConvexDir` to use them (replaces the inline `isModule`/`entries`/`path` logic):

```ts
export function moduleKeyForFile(file: string): string {
  return file.replace(/\.(ts|js)$/, "");
}

export function listConvexModuleFiles(absDir: string): string[] {
  const isModule = (f: string) =>
    (f.endsWith(".ts") || f.endsWith(".js")) &&
    !f.endsWith(".d.ts") && !f.startsWith("_") && f !== "schema.ts" && f !== "schema.js";
  return readdirSync(absDir).filter(isModule);
}
```

In `loadConvexDir`, replace `const entries = readdirSync(absDir).filter(isModule);` with `const entries = listConvexModuleFiles(absDir);`, delete the now-inline `isModule`, and replace `const path = file.replace(/\.(ts|js)$/, "");` with `const path = moduleKeyForFile(file);`. Behavior identical.

- [ ] **Step 3b: Implement `build.ts`**

```ts
// packages/cli/src/build.ts
/**
 * `stackbase build` — compile the app to a self-contained executable via `bun build --compile`.
 * Refresh codegen (so the app's `import "./_generated/server"` resolves at compile time), codegen a
 * static-import entrypoint, shell out to `bun build --compile`, then clean up.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { writeGenerated } from "@stackbase/codegen";
import { loadConvexDir, listConvexModuleFiles, moduleKeyForFile } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { generateEntrySource } from "./build-entry";

export interface BuildOptions { convexDir: string; outfile: string; target: string | null; dashboard: boolean; verbose: boolean }

export function resolveBuildOptions(args: string[]): BuildOptions {
  let convexDir = "convex", outfile = "./stackbase-server", target: string | null = null, dashboard = true, verbose = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) convexDir = args[++i] as string;
    else if (a === "--outfile" && args[i + 1]) outfile = args[++i] as string;
    else if (a === "--target" && args[i + 1]) target = args[++i] as string;
    else if (a === "--no-dashboard") dashboard = false;
    else if (a === "--verbose") verbose = true;
  }
  return { convexDir, outfile, target, dashboard, verbose };
}

const TARGETS: Record<string, string> = {
  "linux-x64": "bun-linux-x64", "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64", "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};
export function bunTargetFor(friendly: string): string {
  const t = TARGETS[friendly];
  if (!t) throw new Error(`unknown target "${friendly}" (expected one of: ${Object.keys(TARGETS).join(", ")})`);
  return t;
}

/** Enumerate the built dashboard dist as {urlPath, absPath}. "/" maps to index.html. */
function dashboardFiles(): Array<{ urlPath: string; absPath: string }> | null {
  try {
    const indexPath = createRequire(import.meta.url).resolve("@stackbase/dashboard/dist");
    const dist = dirname(indexPath);
    const out: Array<{ urlPath: string; absPath: string }> = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dist, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else out.push({ urlPath: r === "index.html" ? "/" : `/${r}`, absPath: join(dist, r) });
      }
    };
    walk("");
    return out;
  } catch { return null; }
}

export async function buildCommand(args: string[]): Promise<number> {
  const opts = resolveBuildOptions(args);
  const convexAbs = resolve(opts.convexDir);
  // 1. Load + refresh codegen so `import "./_generated/server"` resolves when bun bundles the modules.
  const loaded = await loadConvexDir(convexAbs);
  const config = await loadConfig(dirname(convexAbs));
  const { generated } = push(loaded, config.components);
  writeGenerated(generated.files, join(convexAbs, "_generated"));
  // 2. Codegen the entrypoint.
  const moduleImports = listConvexModuleFiles(convexAbs).map((f) => ({ key: moduleKeyForFile(f), absPath: join(convexAbs, f) }));
  const schemaAbsPath = join(convexAbs, existsSync(join(convexAbs, "schema.ts")) ? "schema.ts" : "schema.js");
  const cfgTs = join(dirname(convexAbs), "stackbase.config.ts"), cfgJs = join(dirname(convexAbs), "stackbase.config.js");
  const configAbsPath = existsSync(cfgTs) ? cfgTs : existsSync(cfgJs) ? cfgJs : null;
  const entrySrc = generateEntrySource({ moduleImports, schemaAbsPath, configAbsPath, dashboardFiles: opts.dashboard ? dashboardFiles() : null });
  const buildDir = resolve(".stackbase-build");
  mkdirSync(buildDir, { recursive: true });
  const entryPath = join(buildDir, "entry.ts");
  writeFileSync(entryPath, entrySrc);
  // 3. Compile.
  const bunArgs = ["build", "--compile", "--minify", "--bytecode"];
  if (opts.target) bunArgs.push(`--target=${bunTargetFor(opts.target)}`);
  const outfile = opts.target === "windows-x64" && !opts.outfile.endsWith(".exe") ? `${opts.outfile}.exe` : opts.outfile;
  bunArgs.push(`--outfile=${resolve(outfile)}`, entryPath);
  // Shell the external `bun` binary via node:child_process so this works whether the CLI itself is
  // invoked under Bun or Node (the compile step needs Bun, but the caller need not be Bun).
  const proc = spawnSync("bun", bunArgs, { stdio: opts.verbose ? "inherit" : ["ignore", "ignore", "inherit"] });
  rmSync(buildDir, { recursive: true, force: true });
  if (proc.error) {
    process.stderr.write(`✗ could not run 'bun build --compile' — is Bun installed and on PATH? (${(proc.error as Error).message})\n`);
    return 1;
  }
  if (proc.status !== 0) { process.stderr.write("✗ bun build --compile failed\n"); return 1; }
  const size = (statSync(resolve(outfile)).size / (1024 * 1024)).toFixed(0);
  process.stdout.write(`✓ built ${outfile} (${size}MB)\n`);
  return 0;
}
```

- [ ] **Step 3c: Wire the CLI dispatch (`packages/cli/src/cli.ts`)**

Add `import { buildCommand } from "./build";` and a case in `runCli`'s switch:

```ts
    case "build":
      return buildCommand(argv.slice(1));
```

Add a `build` line to the help text (near the existing `dev`/`serve`/`deploy` lines):

```
  build     Compile the app to a self-contained executable (bun build --compile)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run --filter @stackbase/cli test build.test` → PASS.
Run: `bun run --filter @stackbase/cli test load` → existing `loadConvexDir` tests still PASS (helper extraction is behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/build.ts packages/cli/src/load-modules.ts packages/cli/src/cli.ts packages/cli/test/build.test.ts
git commit -m "feat(cli): stackbase build — resolve options, codegen entry, bun build --compile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Host E2E ship gate — compile a fixture app and run the real binary

**Files:**
- Create: `packages/cli/test/fixtures/build-app/convex/{schema.ts,notes.ts}`, `packages/cli/test/fixtures/build-app/stackbase.config.ts`
- Create: `packages/cli/test/build-e2e.test.ts`

**Interfaces:**
- Consumes: `buildCommand` (Task 4); the produced binary's runtime contract (ready-line JSON, `POST /api/run`, SIGTERM).
- Produces: nothing (verification only).

The fixture composes `@stackbase/scheduler` so the build exercises config-based component reconstruction.

- [ ] **Step 1: Write the fixture app**

```ts
// packages/cli/test/fixtures/build-app/convex/schema.ts
import { v, defineSchema, defineTable } from "@stackbase/values";
export default defineSchema({
  notes: defineTable({ box: v.string(), text: v.string() }).index("by_box", ["box"]),
});
```
```ts
// packages/cli/test/fixtures/build-app/convex/notes.ts
import { query, mutation } from "@stackbase/executor";
export const list = query({ handler: async (ctx) => (await ctx.db.query("notes", "by_box").collect()).map((d) => ({ box: d.box, text: d.text })) });
export const add = mutation({ handler: (ctx, { box, text }: { box: string; text: string }) => ctx.db.insert("notes", { box, text }) });
```
```ts
// packages/cli/test/fixtures/build-app/stackbase.config.ts
import { defineScheduler } from "@stackbase/scheduler";
export default { components: [defineScheduler()] };
```

- [ ] **Step 2: Write the E2E test (expected to fail until the binary compiles + runs)**

```ts
// packages/cli/test/build-e2e.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { buildCommand } from "../src/build";
import { existsSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

const OUT = resolve("./.tmp-build/server");
const DATA = resolve("./.tmp-build/data");
afterAll(() => rmSync("./.tmp-build", { recursive: true, force: true }));

async function readReadyLine(proc: { stdout: ReadableStream<Uint8Array> }): Promise<{ url: string }> {
  const reader = proc.stdout.getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("binary exited before ready line");
    buf += new TextDecoder().decode(value);
    const nl = buf.indexOf("\n");
    if (nl >= 0) { reader.releaseLock(); return JSON.parse(buf.slice(0, nl)); }
  }
}

describe("stackbase build (real compiled binary)", () => {
  it("compiles a fixture app (with a component) and the binary serves a committing mutation", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/convex", "--outfile", OUT, "--no-dashboard"]);
    expect(rc).toBe(0);
    expect(existsSync(OUT)).toBe(true);

    const proc = Bun.spawn([OUT, "--port", "3599", "--hostname", "127.0.0.1", "--data-dir", DATA], {
      env: { ...process.env, STACKBASE_ADMIN_KEY: "e2e" }, stdout: "pipe", stderr: "inherit",
    });
    try {
      const { url } = await readReadyLine(proc as unknown as { stdout: ReadableStream<Uint8Array> });
      expect(url).toBe("http://127.0.0.1:3599");
      const add = await fetch(`${url}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes:add", args: { box: "a", text: "compiled" } }) });
      expect((await add.json()).committed).toBe(true);
      const list = await fetch(`${url}/api/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "notes:list", args: {} }) });
      expect((await list.json()).value).toEqual([{ box: "a", text: "compiled" }]);
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 120_000);

  it("cross-compiles to linux-x64 (produces a non-empty file, not executed here)", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/convex", "--outfile", `${OUT}-linux`, "--target", "linux-x64", "--no-dashboard"]);
    expect(rc).toBe(0);
    expect(statSync(`${OUT}-linux`).size).toBeGreaterThan(1_000_000);
  }, 120_000);
});
```

- [ ] **Step 3: Run — iterate until green**

Run: `bun run --filter @stackbase/cli test build-e2e`
Expected initially: may fail if `runBinaryServer` isn't reachable from the compiled entry (the generated entry imports `@stackbase/cli`, which must resolve + expose `runBinaryServer` — Task 2 exported it). Fix resolution issues (ensure `@stackbase/cli` resolves from the fixture's module graph the same way `deploy` fixtures resolve `@stackbase/*`) until both tests pass. No production-code change should be needed beyond Tasks 1-4; if one is, it belongs here.

- [ ] **Step 4: Confirm green**

Run: `bun run --filter @stackbase/cli test build-e2e` → PASS (both).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/test/build-e2e.test.ts packages/cli/test/fixtures/build-app
git commit -m "test(cli): E2E — stackbase build compiles a fixture app; the binary serves a mutation

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Embedded dashboard support (sequenced last — additive)

**Files:**
- Modify: `packages/cli/src/server.ts` (dashboard-serving seam), `packages/cli/src/binary-main.ts` (thread + materialize embedded dashboard)
- Test: extend `packages/cli/test/build-e2e.test.ts`

**Interfaces:**
- Produces: `interface EmbeddedDashboard { html: string; assets: Record<string, string> }` (exported from `binary-main.ts`); `startBinaryServer`/`runBinaryServer`'s `dashboard?` param tightened to `Record<string, string> | undefined` (the generated `{urlPath: embeddedPath}` map).
- Consumes: `Bun.file(path)` for `$bunfs` embedded reads; the existing `serveDashboard(path, dashboard)` in `server.ts`.

- [ ] **Step 1: Write the failing test (extend build-e2e)**

Add to `build-e2e.test.ts`:

```ts
  it("embeds the dashboard by default (served) and omits it with --no-dashboard", async () => {
    const rc = await buildCommand(["--dir", "test/fixtures/build-app/convex", "--outfile", `${OUT}-dash`]); // dashboard ON
    expect(rc).toBe(0);
    const proc = Bun.spawn([`${OUT}-dash`, "--port", "3601", "--hostname", "127.0.0.1", "--data-dir", `${DATA}-dash`], {
      env: { ...process.env, STACKBASE_ADMIN_KEY: "e2e" }, stdout: "pipe", stderr: "inherit",
    });
    try {
      const { url } = await readReadyLine(proc as unknown as { stdout: ReadableStream<Uint8Array> });
      const root = await fetch(`${url}/`);
      expect(root.status).toBe(200);
      expect((await root.text()).toLowerCase()).toContain("stackbase");
    } finally { proc.kill("SIGTERM"); await proc.exited; }
  }, 120_000);
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/cli test build-e2e -t "embeds the dashboard"`
Expected: FAIL — `/` returns 404 (dashboard not wired into the binary yet).

- [ ] **Step 3: Implement the embedded-dashboard seam**

In `packages/cli/src/binary-main.ts`, add materialization + thread it through:

```ts
export interface EmbeddedDashboard { html: string; assets: Record<string, string> }

// in startBinaryServer signature, replace `dashboard?: unknown` with:
//   dashboard?: Record<string, string>
// and before startDevServer:
let dash: EmbeddedDashboard | undefined;
if (dashboard) {
  const html = await Bun.file((dashboard as Record<string, string>)["/"]).text();
  dash = { html, assets: dashboard as Record<string, string> };
}
// pass `dashboard: dash` into startDevServer's options.
```

In `packages/cli/src/server.ts`, extend the dashboard option type and `serveDashboard` to accept the embedded variant (union with the existing `{distDir, html}`):

```ts
// DevServerOptions.dashboard type:
//   dashboard?: { distDir: string; html: string } | { assets: Record<string, string>; html: string };

// in serveDashboard(path, dashboard):
//   - path === "/" (or "/index.html") -> serve dashboard.html (content-type text/html)
//   - else if "distDir" in dashboard -> existing resolveStatic(dashboard.distDir, path)
//   - else (embedded) -> const p = dashboard.assets[path]; if (p) return Bun.file(p) bytes with
//     a content-type derived from the extension; else undefined (falls through to 404)
```

Keep the existing `{distDir, html}` branch untouched so `dev`/`serve` are unaffected. Serve embedded assets via `Bun.file(p).arrayBuffer()` → `Uint8Array`, content-type by extension (`.js`→`application/javascript`, `.css`→`text/css`, `.html`→`text/html`, else `application/octet-stream`).

- [ ] **Step 4: Run to verify it passes**

Run: `bun run --filter @stackbase/cli test build-e2e` → all PASS (mutation, cross-compile, dashboard).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/binary-main.ts packages/cli/src/server.ts packages/cli/test/build-e2e.test.ts
git commit -m "feat(cli): embed + serve the dashboard from a compiled binary (\$bunfs via Bun.file)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Reconcile the binary-facing docs

**Files:**
- Modify: `docs/enduser/deploy/standalone-binary.md`
- Modify: binary references in `docs/enduser/deploy/electrobun.md`, `docs/enduser/deploy/tauri.md`, `docs/enduser/deploy/self-hosted.md`
- Modify: `CLAUDE.md` (single binary → shipped)
- Test: `packages/cli/test/docs-binary.test.ts` (grep guard)

**Interfaces:** none (docs). Reality is the source of truth: match what Tasks 1-6 shipped.

- [ ] **Step 1: Write the failing guard test**

```ts
// packages/cli/test/docs-binary.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
describe("standalone-binary docs match reality", () => {
  const doc = readFileSync("../../docs/enduser/deploy/standalone-binary.md", "utf8");
  it("does not reference non-existent packages", () => {
    for (const phantom of ["@stackbase/runtime-bun", "@stackbase/core", "@stackbase/docstore-bun-sqlite", "@stackbase/blobstore-bun-fs"]) {
      expect(doc).not.toContain(phantom);
    }
  });
  it("documents the real command surface", () => {
    expect(doc).toContain("stackbase build");
    expect(doc).toContain("--outfile");
    expect(doc).toContain("--target");
    expect(doc).toContain('"ready":true'); // machine-readable startup line
    expect(doc).toContain("STACKBASE_ADMIN_KEY");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run --filter @stackbase/cli test docs-binary`
Expected: FAIL — the doc still references phantom packages / lacks `STACKBASE_ADMIN_KEY`.

- [ ] **Step 3: Rewrite `standalone-binary.md`**

Rewrite to match what ships:
- **Prerequisites:** `bun add @stackbase/cli` (+ `@stackbase/scheduler`/`@stackbase/workflow` only if the app composes them). Remove all phantom packages and `bunx stackbase init` (no init command exists — the app just needs a `convex/` dir + optional `stackbase.config.ts`).
- **Build:** `stackbase build` (via the installed CLI) → `./stackbase-server`. Document `--outfile`, `--target <linux-x64|linux-arm64|darwin-x64|darwin-arm64|windows-x64>`, `--dir`, `--no-dashboard`, `--verbose`.
- **What's in the binary:** Bun runtime, engine, `bun:sqlite`, the app's `convex/` functions + schema, composed components, dashboard (default on). External: the SQLite DB under `--data-dir`.
- **Run:** `STACKBASE_ADMIN_KEY=… ./stackbase-server --port 3000 --hostname 0.0.0.0 --data-dir ./data`. Note the **required** admin key.
- **Machine-readable startup:** the `{"ready":true,"port":…,"url":…}` stdout line for Electron/Tauri parents.
- **Minimal Docker image:** a short `Dockerfile.binary` example — build a `--target=linux-x64` binary, `COPY` it into a `distroless`/`scratch` base, run it — as the tiny-image alternative to the 6a runtime image.

In `electrobun.md`/`tauri.md`/`self-hosted.md`, fix any `stackbase build`/binary invocation + the ready-line to match; leave non-binary phantom-package references in place (tracked follow-up).

- [ ] **Step 4: Update `CLAUDE.md`**

Move the single binary from the "locked but unbuilt" framing to shipped: in the "What works" list add a `stackbase build` entry (compiles an app to a self-contained executable via `bun build --compile`; embeds functions + components + dashboard; SQLite external via `--data-dir`; `{"ready":…}` line; cross-compile), and remove/adjust any wording implying it's unbuilt.

- [ ] **Step 5: Run guard test + commit**

Run: `bun run --filter @stackbase/cli test docs-binary` → PASS.

```bash
git add docs/enduser/deploy/standalone-binary.md docs/enduser/deploy/electrobun.md docs/enduser/deploy/tauri.md docs/enduser/deploy/self-hosted.md CLAUDE.md packages/cli/test/docs-binary.test.ts
git commit -m "docs(single-binary): reconcile standalone-binary docs to the real stackbase build

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Integrated verification (after all tasks)

Run from repo root and GREP the output — a green `test` with a red `typecheck` is a failure:

```bash
bun run build 2>&1 | grep -iE "error|Failed" | grep -v "0 errors"   # expect no matches
bun run typecheck 2>&1 | grep -iE "error TS|Failed:"                 # expect no matches
bun run test 2>&1 | grep -iE "FAIL"                                  # expect no matches (E2E "✗ …" prose lines are OK)
```

All three green → the slice is complete. The `build-e2e` test is the ship gate (it compiles + runs a real binary). A follow-up **Docker-linux smoke** (build `--target=linux-x64`, run in a `distroless`/`scratch` container, commit → read-back → persistence across restart) is the manual production gate, per the 6a/6b lesson.

## Non-goals (do not build)

- No `stackbase init` scaffolder. No auto-Docker-build subcommand (docs example only). No bundling the mutable DB into the binary. No Postgres in the binary (slice 6c). No keyless local mode. No reconciliation of the broader phantom-package doc rot beyond the binary-facing pages (tracked follow-up).
