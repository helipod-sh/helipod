# `stackbase serve` + Docker self-host Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `stackbase serve` (a production server entrypoint) and a working `docker compose up` self-host on SQLite with a persistent volume.

**Architecture:** `serve` is `dev` minus the file watcher and codegen-write, plus production hardening (required persistent admin key, `0.0.0.0` bind, graceful SIGTERM/SIGINT shutdown). The shared "load → compose → make store → make runtime → make admin API" sequence is extracted from `devCommand` into a `bootProject()` helper both commands call, so `dev` stays behavior-identical. The Docker image is the generic engine; the app's `convex/` is bind-mounted at run time.

**Tech Stack:** TypeScript, Bun (package manager + runtime), vitest (under Bun), Turborepo, Docker + docker compose. Packages touched: `@stackbase/cli`, `@stackbase/docstore-sqlite`.

## Global Constraints

- **Bun only.** Never `npm`/`pnpm`/`yarn`. Per-package tests: `bun run --filter <pkg> test`. Whole workspace: `bun run build && bun run typecheck && bun run test`. All green before a task's commit.
- **`serve` = `dev` − watcher − codegen-write + hardening.** The `bootProject()` extraction MUST be behavior-preserving for `dev` (existing dev/E2E tests are the regression guard).
- **Admin key REQUIRED for `serve` — fail fast.** `serve` returns non-zero + a clear stderr message if `STACKBASE_ADMIN_KEY` is unset/blank. `dev` is UNCHANGED (keeps its ephemeral-key-with-warning behavior).
- **No codegen at runtime.** `serve` composes in-memory and never writes `_generated/`. The `--dir` MUST already contain a committed `_generated/` (its `.ts` imports `./_generated/*`); missing → fail fast with the codegen instruction.
- **Bind `0.0.0.0` by default in `serve`** (dev binds `127.0.0.1`). `--ip` / `PORT` / `--port` override (default port 3000).
- **Graceful shutdown:** SIGTERM/SIGINT → `server.close()` (drains HTTP + WS) → `store.close()` (closes SQLite) → `process.exit(0)`. Idempotent (a second signal doesn't double-run).
- **Dashboard on by default, key-gated, toggleable** via `--no-dashboard` / `STACKBASE_DASHBOARD=off`. `serve` passes `loadDashboard(undefined)` (NO embedded key — the SPA prompts the operator; never embed a persistent key on a `0.0.0.0` bind).
- **Docker:** the image is the generic engine (app bind-mounted); `docker-compose.yml` `target` must name a stage that EXISTS in the `Dockerfile` (fix `runtime` → `runner`); the runtime image invokes `serve`.
- **Docker E2E is a documented manual smoke**, not an automated CI test; a config-parse test guards the stage-name bug.
- Never let engine code learn which DB it's on (no adapter leak). N/A here but holds.

---

## File Structure

- `packages/cli/src/boot.ts` — **create**: `bootProject()` (the shared boot core) + `makeStore()` (moved from cli.ts).
- `packages/cli/src/serve.ts` — **create**: `startServe()` (testable core: boots + starts the server, no signals/exit) + `serveCommand()` (CLI wrapper: flags, fail-fast, signals, run-forever) + `resolveServeOptions()`.
- `packages/cli/src/cli.ts` — **modify**: `devCommand` calls `bootProject()`; `runCli` dispatch gains a `serve` case; `makeStore` moves out to `boot.ts`.
- `packages/docstore-sqlite/src/sqlite-docstore.ts:67` — **modify**: add `close()`.
- `Dockerfile` — **modify**: runtime stage `ENTRYPOINT`/`CMD` invoke `serve`.
- `docker-compose.yml` — **modify**: `target: runner`, bind-mount the app + data, require the key, `serve` command.
- `docs/enduser/self-hosting.md` — **create**: the self-host guide.
- `CLAUDE.md` — **modify**: slice 6a shipped.
- Tests: `packages/docstore-sqlite/test/close.test.ts`, `packages/cli/test/serve.test.ts`, `packages/cli/test/serve-e2e.test.ts`, `packages/cli/test/docker-config.test.ts`.

---

## Task 1: Extract the shared boot core (`bootProject`)

**Files:**
- Create: `packages/cli/src/boot.ts`
- Modify: `packages/cli/src/cli.ts` (`devCommand` uses `bootProject`; move `makeStore`)
- Test: existing `packages/cli/test/*e2e*.test.ts` (regression) + a new assertion in `packages/cli/test/serve.test.ts` is added in Task 3; Task 1's guard is the existing dev tests.

**Interfaces:**
- Produces: `bootProject(opts: { convexDir: string; dataPath: string; adminKey: string }): Promise<BootResult>` where
  `BootResult = { runtime: EmbeddedRuntime; adminApi: AdminApi; project: ProjectArtifacts; generated: GeneratedOutput; store: SqliteDocStore; logSink: InMemoryLogSink }`.
  It performs exactly what `devCommand` lines 61-96 do today: `loadConvexDir` → `loadConfig` → `push` → build `logSink`/`store`/`runtime`/`adminApi`. It does NOT write codegen and does NOT start a server. `makeStore(dataPath)` moves here.

- [ ] **Step 1: Write `boot.ts`**

```ts
// packages/cli/src/boot.ts
/**
 * The shared boot core for `stackbase dev` and `stackbase serve`: load the project, compose
 * app + components, open the SQLite store, build the embedded runtime + admin API. Neither writes
 * codegen nor starts a server — the callers own those (dev writes _generated + watches; serve
 * hardens + serves).
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NodeSqliteAdapter, BunSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, browseTableModule, systemModules, verifyAdminKey } from "@stackbase/admin";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { detectRuntime } from "./dev-options";

export function makeStore(dataPath: string): SqliteDocStore {
  mkdirSync(dirname(resolve(dataPath)), { recursive: true });
  const adapter = detectRuntime() === "bun" ? new BunSqliteAdapter({ path: dataPath }) : new NodeSqliteAdapter({ path: dataPath });
  return new SqliteDocStore(adapter);
}

export interface BootResult {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  project: ReturnType<typeof push>["project"];
  generated: ReturnType<typeof push>["generated"];
  store: SqliteDocStore;
  logSink: InMemoryLogSink;
}

export async function bootProject(opts: { convexDir: string; dataPath: string; adminKey: string }): Promise<BootResult> {
  const loaded = await loadConvexDir(opts.convexDir);
  const config = await loadConfig(dirname(opts.convexDir));
  const { project, generated } = push(loaded, config.components);
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
  return { runtime, adminApi, project, generated, store, logSink };
}
```
> Match the EXACT `createEmbeddedRuntime`/`AdminApi` option objects `devCommand` uses today (cli.ts:75-96) — copy them verbatim so behavior is preserved. If `push`'s return type isn't easily named, import the proper `ProjectArtifacts`/generated types from `./project`/`@stackbase/codegen` instead of the `ReturnType<...>` shortcut.

- [ ] **Step 2: Refactor `devCommand` to call `bootProject`** (`packages/cli/src/cli.ts`)

Replace lines ~61-96 (the load/compose/logSink/adminKey/runtime/adminApi block) so that AFTER computing `adminKey`/`ephemeralKey`/`loopback` (keep that env logic), it calls:
```ts
  const { runtime, adminApi, project, generated, store, logSink } = await bootProject({
    convexDir: opts.convexDir, dataPath: opts.dataPath, adminKey,
  });
  writeGenerated(generated.files, generatedDir);
```
Keep everything after (the `dashboard`/`startDevServer`/`watcher` block, cli.ts:97-135) UNCHANGED except that `runtime`/`adminApi`/`project`/`logSink` now come from `bootProject`. Remove the now-duplicated local `makeStore` from cli.ts (import it from `./boot` if still referenced, e.g. by codegenCommand — it isn't; codegenCommand doesn't make a store). Delete the old inline `createEmbeddedRuntime`/`AdminApi` construction and the local `makeStore` function.

- [ ] **Step 3: Run the regression guard — existing dev tests + whole workspace**

Run: `bun run --filter @stackbase/cli test` then `bun run build && bun run typecheck && bun run test`
Expected: ALL green — `dev` behavior is unchanged (the E2E tests that boot the dev server via `devCommand`/`startDevServer` still pass). If any dev/e2e test regresses, the extraction diverged from the original construction — fix to match verbatim.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/boot.ts packages/cli/src/cli.ts
git commit -m "refactor(cli): extract bootProject() boot core shared by dev (and serve)"
```

---

## Task 2: `SqliteDocStore.close()`

**Files:**
- Modify: `packages/docstore-sqlite/src/sqlite-docstore.ts:67-70`
- Test: `packages/docstore-sqlite/test/close.test.ts`

**Interfaces:**
- Produces: `SqliteDocStore.close(): void` — closes the underlying `DatabaseAdapter` (which already has `close(): void`, adapter.ts:26). Used by `serve`'s graceful shutdown to release the SQLite file cleanly.

- [ ] **Step 1: Write the failing test** (`packages/docstore-sqlite/test/close.test.ts`)

Mirror an existing docstore-sqlite test's setup for constructing a `SqliteDocStore` on a temp file (grep the test dir for how a store + adapter is built; use the Node adapter for test portability). Assert:
```ts
import { describe, it, expect } from "vitest";
// ... build a SqliteDocStore on a temp file path via the sibling test's helper ...

describe("SqliteDocStore.close", () => {
  it("closes the underlying adapter; a write after close throws", () => {
    const store = makeTempStore();          // from the sibling harness
    // (do a trivial successful operation here if the harness makes one easy, else skip)
    expect(() => store.close()).not.toThrow();
    // closing twice must not throw the process down — second close is a no-op or a caught throw
    // (the underlying better-sqlite/bun db throws on double-close; assert close() is safe to call once
    //  and that the store is unusable after — a subsequent query/insert rejects/throws).
  });
  it("data written before close is durable — reopen the same file sees it", async () => {
    const path = tmpFile();
    const s1 = new SqliteDocStore(makeAdapter(path));
    // ... write one document via the store's real insert API (copy the pattern from a sibling test) ...
    s1.close();
    const s2 = new SqliteDocStore(makeAdapter(path));
    // ... read it back via the store's query API; assert the document is present ...
    s2.close();
  });
});
```
> Use whatever real insert/query API the sibling docstore-sqlite tests use — do not invent method names. The durability test is the important one (it proves close() flushes and the file is a real persistent artifact).

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/docstore-sqlite test close`
Expected: FAIL — `store.close` is not a function.

- [ ] **Step 3: Implement** (`packages/docstore-sqlite/src/sqlite-docstore.ts`)

Add to the `SqliteDocStore` class (constructor is `constructor(private readonly db: DatabaseAdapter) {}`):
```ts
  /** Close the underlying database adapter (checkpoint + release the file). Used by graceful shutdown. */
  close(): void {
    this.db.close();
  }
```

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/docstore-sqlite test close`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/docstore-sqlite/src/sqlite-docstore.ts packages/docstore-sqlite/test/close.test.ts
git commit -m "feat(docstore-sqlite): SqliteDocStore.close() — release the file for graceful shutdown"
```

---

## Task 3: `stackbase serve` command

**Files:**
- Create: `packages/cli/src/serve.ts`
- Modify: `packages/cli/src/cli.ts` (`runCli` dispatch gains `serve`)
- Test: `packages/cli/test/serve.test.ts`

**Interfaces:**
- Consumes: `bootProject` (Task 1), `SqliteDocStore.close` (Task 2), `startDevServer`/`DevServer` (`./server`), `loadDashboard` (currently in `cli.ts` — export it or move to a shared spot so `serve.ts` can call it).
- Produces:
  - `startServe(opts: { convexDir: string; dataPath: string; ip: string; port: number; adminKey: string; dashboard: boolean }): Promise<{ server: DevServer; store: SqliteDocStore; runtime: EmbeddedRuntime }>` — the TESTABLE core: boots + starts the server; NO signal handlers, NO `process.exit`, does NOT block.
  - `serveCommand(args: string[]): Promise<number>` — the CLI wrapper: parse flags, fail-fast checks, call `startServe`, install signal handlers, run forever. Returns `1` on a fail-fast (before starting a server).
  - `resolveServeOptions(...)` — prod defaults (ip `0.0.0.0`, port `PORT`||3000, data from `STACKBASE_DATA_DIR`||`./data/db.sqlite`, dashboard on unless `--no-dashboard`/`STACKBASE_DASHBOARD=off`).

- [ ] **Step 1: Write the failing test** (`packages/cli/test/serve.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import { serveCommand, startServe } from "../src/serve";
// reuse an existing e2e harness's fixture-convex-dir builder if present; else build a temp dir with
// schema.ts + one query + _generated/ (copy the pattern from action-e2e/http-action-e2e fixtures).

describe("serveCommand fail-fast", () => {
  const OLD = process.env.STACKBASE_ADMIN_KEY;
  afterEach(() => { if (OLD === undefined) delete process.env.STACKBASE_ADMIN_KEY; else process.env.STACKBASE_ADMIN_KEY = OLD; });

  it("returns 1 with a clear message when STACKBASE_ADMIN_KEY is unset", async () => {
    delete process.env.STACKBASE_ADMIN_KEY;
    const code = await serveCommand(["--dir", someDirWithGenerated]);
    expect(code).toBe(1);
  });
  it("returns 1 when --dir lacks _generated/", async () => {
    process.env.STACKBASE_ADMIN_KEY = "test-key";
    const code = await serveCommand(["--dir", dirWithoutGenerated]);
    expect(code).toBe(1);
  });
});

describe("startServe", () => {
  it("boots and serves /api/health", async () => {
    const { server, store } = await startServe({
      convexDir: fixtureDir, dataPath: tmpDbPath, ip: "127.0.0.1", port: 0, adminKey: "k", dashboard: false,
    });
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    await server.close();
    store.close();
  });
});
```
> `port: 0` asks the OS for a free port; confirm `startDevServer` honors 0 (it returns the actual `server.port`/`url`). If it doesn't, pick a high fixed test port as the sibling e2e tests do.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test serve`
Expected: FAIL — `../src/serve` has no `serveCommand`/`startServe`.

- [ ] **Step 3: Implement `serve.ts`**

```ts
// packages/cli/src/serve.ts
/**
 * `stackbase serve` — the production server. Unlike `dev`: requires a persistent admin key,
 * binds 0.0.0.0, never writes codegen (the mounted convex/ must already contain _generated/),
 * and shuts down gracefully on SIGTERM/SIGINT. Shares the boot core with dev via bootProject().
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DevServer } from "./server";
import { startDevServer } from "./server";
import { bootProject, loadDashboard } from "./boot";   // loadDashboard moves to boot.ts (Step 3b) to avoid a cli<->serve cycle
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";

export interface ServeOptions {
  convexDir: string;
  dataPath: string;
  ip: string;
  port: number;
  dashboard: boolean;
}

export function resolveServeOptions(args: string[]): ServeOptions {
  let convexDir = "convex", dataPath = process.env.STACKBASE_DATA_DIR ? join(process.env.STACKBASE_DATA_DIR, "db.sqlite") : "./data/db.sqlite";
  let ip = "0.0.0.0", port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let dashboard = process.env.STACKBASE_DASHBOARD?.trim().toLowerCase() !== "off";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) convexDir = args[++i];
    else if (a === "--data" && args[i + 1]) dataPath = args[++i];
    else if (a === "--ip" && args[i + 1]) ip = args[++i];
    else if (a === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (a === "--no-dashboard") dashboard = false;
  }
  return { convexDir, dataPath, ip, port, dashboard };
}

/** Testable core: boot + start the server. No signals, no exit, does not block. */
export async function startServe(opts: ServeOptions & { adminKey: string }): Promise<{ server: DevServer; store: SqliteDocStore; runtime: EmbeddedRuntime }> {
  const { runtime, adminApi, project, store } = await bootProject({ convexDir: opts.convexDir, dataPath: opts.dataPath, adminKey: opts.adminKey });
  // No embedded key (0.0.0.0 bind): the dashboard SPA prompts the operator for the admin key.
  const dashboard = opts.dashboard ? loadDashboard(undefined) : undefined;
  const server = await startDevServer(
    runtime,
    { functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) },
    { port: opts.port, ip: opts.ip, admin: { api: adminApi, key: opts.adminKey }, dashboard, routes: project.routes },
  );
  return { server, store, runtime };
}

/** CLI wrapper: flags → fail-fast → startServe → signal handlers → run forever. */
export async function serveCommand(args: string[]): Promise<number> {
  const opts = resolveServeOptions(args);
  const adminKey = process.env.STACKBASE_ADMIN_KEY?.trim();
  if (!adminKey) {
    process.stderr.write("✗ STACKBASE_ADMIN_KEY is required for `serve` — set it to a strong secret.\n");
    return 1;
  }
  if (!existsSync(join(opts.convexDir, "_generated", "server.ts"))) {
    process.stderr.write(`✗ ${opts.convexDir}/_generated not found — run \`stackbase codegen --dir ${opts.convexDir}\` and commit _generated/ before deploying.\n`);
    return 1;
  }
  const { server, store } = await startServe({ ...opts, adminKey });
  process.stdout.write(JSON.stringify({ level: "info", msg: "stackbase serve", url: server.url, dir: opts.convexDir, data: opts.dataPath, dashboard: opts.dashboard }) + "\n");

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ level: "info", msg: "shutting down" }) + "\n");
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  return new Promise<number>(() => { /* run until a signal exits the process */ });
}
```

- [ ] **Step 3b: Move `loadDashboard` from `cli.ts` to `boot.ts`**

`loadDashboard` is currently a non-exported function in `cli.ts`. `serve.ts` needs it, and importing it from `cli.ts` would create a cycle (`cli.ts`'s `runCli` imports `serveCommand` from `serve.ts`). So MOVE `loadDashboard` verbatim into `boot.ts` and `export` it there; update `cli.ts` to import it from `./boot` (replacing its local copy); `serve.ts` imports it from `./boot`. Single source of truth, no cycle. (`loadDashboard` uses `createRequire(import.meta.url).resolve("@stackbase/dashboard/dist")` — a package resolution, so it works identically from `boot.ts`.)

- [ ] **Step 3c: Dispatch `serve` in `runCli`** (`packages/cli/src/cli.ts`)

In `runCli`'s command switch (where `dev`/`codegen` are dispatched), add:
```ts
    case "serve":
      return serveCommand(rest);
```
(import `serveCommand` from `./serve`; `rest` is the args after the subcommand, matching how `dev`/`codegen` receive theirs.)

- [ ] **Step 4: Run — verify it passes**

Run: `bun run --filter @stackbase/cli test serve`
Expected: PASS (fail-fast cases + `startServe` health).

- [ ] **Step 5: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add packages/cli/src/serve.ts packages/cli/src/cli.ts packages/cli/src/boot.ts packages/cli/test/serve.test.ts
git commit -m "feat(cli): stackbase serve — prod server (required key, 0.0.0.0, graceful shutdown)"
```

---

## Task 4: `serve` E2E — reactive + httpAction + durability across restart

**Files:**
- Test: `packages/cli/test/serve-e2e.test.ts`

**Interfaces:**
- Consumes: `startServe` (Task 3) end-to-end.

- [ ] **Step 1: Write the failing E2E** (`packages/cli/test/serve-e2e.test.ts`)

Mirror `packages/cli/test/http-action-e2e.test.ts` (real `startServe` → real WS client via `ws` + real `fetch`). Use a fixture convex dir with `_generated/`, a `pings.list` query, a `pings.add` mutation, and an `http.ts` routing `POST /hook` → an httpAction that `ctx.runMutation`s `pings.add`. Use a temp SQLite file path shared across two `startServe` calls.

```ts
// 1. startServe({ dataPath: tmpDb, adminKey: "k", dashboard: false, ip: "127.0.0.1", port: <free> });
// 2. WS subscribe to pings:list -> initial [].
// 3. fetch POST `${url}/hook` {msg:"hi"} -> 200; assert the WS subscription pushes ["hi"]
//    (webhook -> ctx.runMutation -> reactive fan-out through the real serve server).
// 4. await server.close(); store.close();
// 5. startServe AGAIN with the SAME tmpDb path.
// 6. WS subscribe to pings:list -> assert it now returns ["hi"] (DURABILITY: the row survived the
//    restart on the persistent SQLite file — the whole point of a self-hostable prod server).
// 7. close.
```
If a real-server wiring gap surfaces (e.g. the store isn't actually flushed on close, so the row is missing after restart), FIX at root cause — do not weaken the assertion. Subscribe event-drivenly (not a polling timer) to observe the transient fan-out, per the saga/http E2E harness note.

- [ ] **Step 2: Run — verify it fails, then passes**

Run: `bun run --filter @stackbase/cli test serve-e2e`
Expected: FAIL first (fixture not wired), then PASS once wired. Root-cause any durability gap.

- [ ] **Step 3: Commit**

```bash
git add packages/cli/test/serve-e2e.test.ts
git commit -m "test(cli): serve E2E — webhook->mutation->reactive + durability across restart"
```

---

## Task 5: Docker image + compose + self-host docs

**Files:**
- Modify: `Dockerfile` (runtime stage), `docker-compose.yml`, `CLAUDE.md`
- Create: `docs/enduser/self-hosting.md`, `packages/cli/test/docker-config.test.ts`

**Interfaces:**
- Consumes: the `serve` command (Task 3) as the container entrypoint.

- [ ] **Step 1: Write the failing config-guard test** (`packages/cli/test/docker-config.test.ts`)

Text-parse the two files (no YAML dep) and guard the stage-name bug + the `serve` entrypoint:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../../..");   // repo root from packages/cli/test
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

describe("docker config", () => {
  it("compose build.target names a stage that exists in the Dockerfile", () => {
    const target = compose.match(/target:\s*(\S+)/)?.[1];
    expect(target).toBeTruthy();
    expect(dockerfile).toMatch(new RegExp(`AS\\s+${target}\\b`));   // e.g. "FROM base AS runner"
  });
  it("the runtime image invokes `serve`", () => {
    // CMD or ENTRYPOINT+CMD must run the serve subcommand.
    expect(dockerfile).toMatch(/serve/);
    expect(dockerfile).toMatch(/bin\.js|stackbase/);
  });
  it("compose mounts the app dir and a data volume and requires the admin key", () => {
    expect(compose).toMatch(/\/app\/convex/);
    expect(compose).toMatch(/STACKBASE_ADMIN_KEY/);
    expect(compose).toMatch(/serve/);
  });
});
```
> Adjust the repo-root relative path (`../../..`) to reach the actual repo root from the test file — verify by logging `root` once; the Dockerfile/compose live at the repo root.

- [ ] **Step 2: Run — verify it fails**

Run: `bun run --filter @stackbase/cli test docker-config`
Expected: FAIL — compose `target: runtime` has no matching `AS runtime` stage; Dockerfile CMD doesn't run `serve`.

- [ ] **Step 3: Fix the `Dockerfile` runtime stage**

Replace the placeholder `CMD` in the `runner` stage with:
```dockerfile
# Production entrypoint: serve the app mounted at /app/convex, SQLite on the /data volume.
ENTRYPOINT ["bun", "packages/cli/dist/bin.js"]
CMD ["serve", "--dir", "/app/convex", "--data", "/data/db.sqlite"]
```
Keep the `USER bun`, `VOLUME ["/data"]`, `ENV`, and set `EXPOSE 3000` (serve's default port). Leave the build stages (`prepare`/`builder`) unchanged.

- [ ] **Step 4: Fix `docker-compose.yml`**

```yaml
# Stackbase self-host — the generic engine image + your app's convex/ bind-mounted.
services:
  stackbase:
    build:
      context: .
      target: runner
    image: stackbase:latest
    ports:
      - "3000:3000"
    environment:
      STACKBASE_ADMIN_KEY: ${STACKBASE_ADMIN_KEY:?set STACKBASE_ADMIN_KEY in a .env file}
      STACKBASE_DATA_DIR: /data
    volumes:
      - ./convex:/app/convex:ro
      - stackbase-data:/data
    command: ["serve", "--dir", "/app/convex", "--data", "/data/db.sqlite"]
    restart: unless-stopped

volumes:
  stackbase-data:
```

- [ ] **Step 5: Write the self-host guide** (`docs/enduser/self-hosting.md`)

Cover: prerequisites (a `convex/` with committed `_generated/` — run `stackbase codegen` first); the `.env` with a strong `STACKBASE_ADMIN_KEY`; `docker compose up`; where the dashboard is (`:3000/_dashboard`, prompts for the key); data persistence (the `stackbase-data` volume); the **bake-into-image** immutable alternative (a `Dockerfile FROM stackbase:latest` that `COPY ./convex /app/convex`); and the **reverse-proxy/TLS** note (front with nginx/Caddy/Traefik; Stackbase serves plain HTTP). Include a **manual Docker smoke check**: `docker compose up`, `curl localhost:3000/api/health`, open the dashboard, `docker compose down && up` and confirm data persists.

- [ ] **Step 6: Run — verify the config test passes**

Run: `bun run --filter @stackbase/cli test docker-config`
Expected: PASS.

- [ ] **Step 7: Update `CLAUDE.md`**

Move Docker self-host / production server from "deferred" to shipped (slice 6a): `stackbase serve` (prod entrypoint — required key, `0.0.0.0`, graceful shutdown, serves sync + HTTP + httpActions + dashboard), a working `docker compose up` (generic image + bind-mounted app + persistent SQLite volume). Keep accurate what remains: `stackbase deploy` push (6b), Postgres adapter (6c), TLS/multi-node still deferred. Update build-order item 6 status.

- [ ] **Step 8: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add Dockerfile docker-compose.yml docs/enduser/self-hosting.md packages/cli/test/docker-config.test.ts CLAUDE.md
git commit -m "feat(deploy): working Docker self-host — serve entrypoint, compose stage fix, mounts, docs"
```

---

## Notes for the executor of this plan

- **DRY:** `bootProject` is the single boot core — `dev` and `serve` both call it; do not duplicate the runtime/adminApi construction. `loadDashboard` is one function — move it to a shared module rather than copy it into `serve.ts`.
- **YAGNI:** no `deploy`-push, no Postgres, no TLS, no automated Docker-in-CI run in this slice (see Global Constraints / spec §9).
- **The regression risk is Task 1** — the `bootProject` extraction must produce the identical `dev` runtime. The existing dev/E2E tests are the guard; if any regress, the extraction diverged.
- **The load-bearing gate is Task 4** — the durability-across-restart E2E proves the persistent-volume story that makes self-host real. Do not weaken it.
- **Security:** `serve` never embeds the persistent admin key in the dashboard HTML (`loadDashboard(undefined)`) — the SPA prompts; the key lives only in the operator's env.
