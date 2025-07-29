# `stackbase build` — Single-Binary Compilation (Slice 6d) — Design Spec

**Status:** Approved (brainstorm complete) — ready for implementation plan
**Date:** 2025-07-19
**Slice:** 6d (production deploy tooling; follows 6a Docker self-host ✅, 6b `deploy` push ✅; precedes 6c Postgres adapter)

## Goal

Ship `stackbase build`: a CLI command that compiles a Stackbase app into a **single self-contained executable** via `bun build --compile`. The binary embeds the Bun runtime, the engine, `bun:sqlite`, the app's `convex/` functions + schema, the composed components (scheduler/workflow), and (by default) the dashboard. Deploying becomes: copy one file, point it at a data directory, run it.

## Why now

`bun build --compile` (the single binary) is a **locked architectural decision** in `CLAUDE.md` ("Bun is primary … the single binary via `bun build --compile`"). It was never built. Worse, ~11 end-user docs (`docs/enduser/deploy/standalone-binary.md`, `quickstart.md`, `configure/configuration.md`, `deploy/{electrobun,tauri,self-hosted,scaling}.md`, `local/dev-server.md`, `build/{testing,data-search}.md`, `reference/api.md`) describe a `stackbase build` / `bunx stackbase init` workflow and `import` packages that **do not exist** (`@stackbase/runtime-bun`, `@stackbase/core`, `@stackbase/docstore-bun-sqlite`, `@stackbase/blobstore-bun-fs`). A user following `standalone-binary.md` hits "package not found" on step one. This slice makes the headline capability real and reconciles the binary-facing docs to reality. (Surfaced by the 2025-07-19 Bun capability audit against a local mirror of the current Bun docs at `.reference/bun-docs/`.)

## Core insight (the one thing to get right)

`bun build --compile` only bundles code that is **statically imported** from the entrypoint. Files embedded via `import x from "./f" with { type: "file" }` are inert **data** (served as bytes), not importable modules. Therefore the app's functions cannot be "loaded from a folder" at runtime — there is no folder inside a compiled binary.

Consequence: `stackbase build` must **codegen an entrypoint that statically imports each `convex/` module by absolute path**, reconstruct the exact `{ schema, modules }` shape `loadConvexDir` returns at runtime, and hand it to the *same* boot core `serve` uses. `dev`/`serve` do **load-then-boot** (dynamic `import()` of a dir); the binary does **static-import-then-boot** (compile-time). Same boot, different front door.

## Locked decisions (from brainstorm)

1. **App-specific binary.** The binary embeds one specific app's functions (matches `standalone-binary.md`), not a generic redistributable CLI.
2. **Binary = compiled `serve`.** It reuses `startServe`'s core and hardening (requires `STACKBASE_ADMIN_KEY`, graceful shutdown), not a new server. Adds a machine-readable `{"ready":true,port,url}` stdout line for parent-process (Electron/Tauri) integration. A desktop wrapper supplies an ephemeral admin key and reads the ready-line.
3. **Reality is the single source of truth for docs.** We build the sensible command, then rewrite the binary-facing docs to match it — we do not build to the fictional prerequisites.
4. **Dashboard embedding is included**, default-on (`--no-dashboard` to skip), but **sequenced last** so the server-binary core lands and is smoke-verified before the (fiddlier) dashboard-embed work.
5. **Cross-compile: pass all Bun targets through** (`--target` → `bun build --compile --target=…`); smoke-test only the host target (E2E) + linux (Docker).
6. **Docs scope:** reconcile only the **binary-relevant** docs in this slice; track the broader phantom-package doc rot (quickstart, configuration, api, data-search, etc.) as a separate follow-up.

## Architecture

### 1. Enabling refactor — split the boot core (`packages/cli/src/boot.ts`)

Today `bootProject({ convexDir, dataPath, adminKey })` does one dynamic thing (`loadConvexDir(convexDir)` + `loadConfig`) then builds runtime + admin API from the loaded project (lines 41-67). Extract that tail into a reusable core:

```
bootLoaded({ loaded, components, dataPath, adminKey, schemaOverride? }) -> BootResult
    // = current boot.ts lines 42-67 (push -> store -> runtime -> AdminApi)
bootProject({ convexDir, dataPath, adminKey }) -> BootResult
    // = loadConvexDir + loadConfig + bootLoaded   (unchanged behavior)
```

`loaded` is a `LoadedProject` (`{ schema, modules }`) — the exact shape `loadConvexDir` returns. `components` is the resolved `ComponentDefinition[]` (what `loadConfig` returns). **No behavior change for `dev`/`serve`** — they still call `bootProject`. The binary's generated entrypoint calls `bootLoaded` with statically-imported values.

### 2. `runBinaryServer` (`packages/cli/src/binary-main.ts`)

The runtime entry the generated binary calls. Thin, reuses `startServe`:

```
runBinaryServer(loaded: LoadedProject, components: ComponentDefinition[], dashboard?: EmbeddedDashboard): Promise<void>
```
- Parse argv/env: `--port` (default 3000), `--hostname` (default `0.0.0.0`), `--data-dir` (default `./data`; the binary places `db.sqlite` inside it), `STACKBASE_ADMIN_KEY` (**required**, fail-fast like `serve`).
- Boot via `bootLoaded({ loaded, components, dataPath: join(dataDir, "db.sqlite"), adminKey })`.
- Start the server via the shared `startServe` core (or a `startServer`-level helper it already exposes), serving sync + HTTP + httpActions + (optionally) the embedded dashboard.
- On successful listen, print exactly one line to stdout: `{"ready":true,"port":<n>,"url":"http://<host>:<n>"}`.
- Graceful `SIGTERM`/`SIGINT` → `server.close()` → `store.close()` → `process.exit(0)`.

`serve`/`startServe` is refactored minimally so its server-start + shutdown logic is callable with a pre-booted project (it already boots then serves; expose the "serve an already-booted project" seam so both `serveCommand` and `runBinaryServer` share it).

### 3. `buildCommand` (`packages/cli/src/build.ts`)

`stackbase build` flow:
1. Resolve options (below); resolve `convexDir` + project root.
2. `loadConvexDir(convexDir)` + `loadConfig(root)` — build-time, to enumerate module paths, the schema module path, and the configured components' import specifiers.
3. Refresh `_generated` (reuse the deploy/dev codegen refresh) so embedded generated types/manifest match what's compiled.
4. **Generate the entrypoint** `.stackbase-build/entry.ts` (see §4).
5. Shell out: `bun build --compile --minify --bytecode [--target=<bunTarget>] --outfile=<outfile> .stackbase-build/entry.ts`. Map friendly `--target` names (`linux-x64`, `darwin-arm64`, `windows-x64`, …) → Bun target triples (`bun-linux-x64`, `bun-darwin-arm64`, `bun-windows-x64`, …). Windows: ensure `.exe` suffix.
6. On success: print the outfile path + size; clean up `.stackbase-build/`. `--verbose` streams the underlying `bun build` output.
7. Fail-fast with clear errors: missing `bun` on PATH; `bun build` non-zero exit (surface its stderr); missing `_generated` after refresh.

### 4. The generated entrypoint (`.stackbase-build/entry.ts`)

Codegen emits (illustrative shape):

```ts
// AUTO-GENERATED by `stackbase build` — do not edit.
import * as m0 from "/abs/app/convex/messages.ts";
import * as m1 from "/abs/app/convex/users.ts";
import schema from "/abs/app/convex/schema.ts";
import config from "/abs/app/stackbase.config.ts";        // the user's config, statically imported
import { runBinaryServer } from "@stackbase/cli";
// dashboard assets embedded as files (omitted with --no-dashboard):
import dashIndex from "/abs/.../@stackbase/dashboard/dist/index.html" with { type: "file" };
import dashAsset0 from "/abs/.../@stackbase/dashboard/dist/assets/index-<hash>.js" with { type: "file" };
// … one import per dashboard dist file …

const loaded = {
  schema,
  modules: { "messages": m0, "users": m1 },   // keys = the module paths loadConvexDir would produce
};
const components = config.components ?? [];      // exactly what loadConfig returns at runtime
const dashboard = {                              // urlPath -> embedded $bunfs path (Bun.file-readable)
  "/": dashIndex,
  "/assets/index-<hash>.js": dashAsset0,
  // …
};
await runBinaryServer(loaded, components, dashboard);
```

- **Module keys** must match exactly what `loadConvexDir` derives (the `path:function` module model), so the composed `moduleMap` is byte-identical to the runtime-loaded one. The generator reuses `loadConvexDir`'s path-normalization logic (extract a shared `moduleKeyForFile(convexDir, file)` helper if not already isolated) — single source of truth for the key derivation.
- **Components**: the generated entry **statically imports the user's `stackbase.config.ts`** — which already imports + composes the components (`defineScheduler()`, etc.) — and reads `config.components`, identical to what `loadConfig` returns at runtime but resolved at compile time. `bun build` bundles the config and its transitive component imports; **no re-emission of component calls is needed** (the earlier "reconstruct `defineX()` calls" idea is rejected as fragile — importing the config is the single source of truth). The generator must read the config the same way `loadConfig` does (default export vs named `components` export) so the two agree.
- **Dashboard**: the generator enumerates the resolved `@stackbase/dashboard/dist` tree and emits one `{ type: "file" }` import per file, assembling a `Record<urlPath, embeddedPath>`. Omitted entirely under `--no-dashboard`. `runBinaryServer` is exported from `@stackbase/cli`'s public entry so the generated code imports it by package name (bundled by `bun build`).

### 5. Dashboard serving from embedded files

`serveDashboard`/`resolveStatic` (`packages/cli/src/server.ts`) currently read a real `dist` dir via `readFileSync`. Add a seam so the server can serve from **either** a dist dir (dev/serve) **or** an embedded `Record<urlPath, embeddedPath>` map (binary), reading embedded paths via `Bun.file(embeddedPath)`. The admin key is **not** embedded in the HTML (key-less, like `serve` on `0.0.0.0`); the SPA prompts the operator. `--no-dashboard` yields a binary with no dashboard route (API/sync/httpActions still fully served).

## Flags / UX

**Build (`stackbase build`):**

| Flag | Default | Description |
|------|---------|-------------|
| `--outfile <path>` | `./stackbase-server` | Output binary path |
| `--target <platform>` | host | Cross-compile: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64` |
| `--dir <path>` | `convex` | App functions dir (matches `dev`/`serve`/`deploy`) |
| `--no-dashboard` | — | Exclude the dashboard from the binary |
| `--verbose` | — | Stream underlying `bun build` output |

**Runtime (the produced binary):**

| Flag / env | Default | Description |
|------|---------|-------------|
| `--port` | `3000` | Listen port |
| `--hostname` | `0.0.0.0` | Bind host (`127.0.0.1` for local-only) |
| `--data-dir` | `./data` | Directory for `db.sqlite` |
| `STACKBASE_ADMIN_KEY` | — | **Required** (fail-fast) — guards the admin API + dashboard |

On listen, the binary prints exactly `{"ready":true,"port":3000,"url":"http://0.0.0.0:3000"}` to stdout.

## Error handling

- `stackbase build`: missing `bun` on PATH → clear message; `bun build` failure → surface its stderr + non-zero exit; codegen/load failure → the existing load-error path (same as `dev`).
- Binary runtime: missing `STACKBASE_ADMIN_KEY` → fail-fast (same message as `serve`); bind failure / port in use → clear error; the machine-readable ready-line is emitted only after a successful listen so a parent process can distinguish success from failure.

## Testing strategy (verify the *artifact*, per the 6a/6b lesson)

1. **Unit** — option resolution (`buildCommand` flag/target mapping), entrypoint codegen (module-key derivation matches `loadConvexDir`; `--no-dashboard` omits imports), friendly-target → Bun-triple mapping, `.exe` suffixing.
2. **Host E2E** (`packages/cli/test/build-e2e.test.ts`) — the ship gate: run `stackbase build` on a fixture app (with a component composed, to exercise component reconstruction) → execute the produced **host** binary as a child process → assert the `{"ready":…}` line → `POST /api/run` mutation commits → read-back → (dashboard route 200 when embedded) → SIGTERM shuts down cleanly. Uses a temp `--data-dir`.
3. **Cross-compile** — assert `stackbase build --target=linux-x64` **produces a non-empty file** (cannot execute a linux binary on macOS).
4. **Docker linux smoke** (manual ship gate, documented) — build a `--target=linux-x64` binary → run it in a minimal (`gcr.io/distroless` or `scratch`) container → health → mutation commit → read-back → persistence across container recreate on a volume. This minimal-image path is also documented as the "tiny image" alternative to 6a's runtime-based image.

## Docs reconciliation (this slice)

Rewrite the **binary-facing** docs to match what ships:
- `docs/enduser/deploy/standalone-binary.md` — real prerequisites (`@stackbase/cli`, not phantom packages), real flags, the real `bun build --compile` under the hood, the `{"ready":…}` line, the minimal-Docker-image example.
- The deploy pages that reference the binary (`electrobun.md`, `tauri.md`, `self-hosted.md`) — align the binary invocation + ready-line; leave their non-binary phantom-package references flagged for the follow-up.
- Add a short note to `CLAUDE.md` moving the single binary from "locked but unbuilt" to "shipped."

**Tracked follow-up (NOT this slice):** the broader phantom-package doc rot across `quickstart.md`, `configure/configuration.md`, `reference/api.md`, `build/data-search.md`, `local/dev-server.md`, `build/testing.md`, `deploy/scaling.md`.

## Non-goals (YAGNI)

- No `stackbase init` project scaffolder (separate concern).
- No auto-Docker-build subcommand — the binary + a documented `Dockerfile.binary` example instead.
- No bundling of the mutable SQLite DB into the binary (it's external, under `--data-dir`).
- No Postgres in the binary (that's slice 6c; the binary embeds `bun:sqlite` only for v1).
- No keyless "local mode" — desktop wrappers pass an ephemeral admin key.

## Package / file layout

- `packages/cli/src/boot.ts` — refactor: extract `bootLoaded`; `bootProject` composes it.
- `packages/cli/src/binary-main.ts` — `runBinaryServer` (argv/env → bootLoaded → startServe seam → ready-line → signals).
- `packages/cli/src/build.ts` — `buildCommand` (resolve → codegen entry → `bun build --compile` → cleanup) + friendly-target mapping.
- `packages/cli/src/build-entry.ts` — pure entrypoint-source generator (given loaded project paths + components + dashboard file list → the `entry.ts` string).
- `packages/cli/src/server.ts` — embedded-dashboard seam (`Bun.file` for `$bunfs` paths).
- `packages/cli/src/serve.ts` — expose a "serve an already-booted project" seam shared by `serveCommand` + `runBinaryServer`.
- `packages/cli/src/cli.ts` — `case "build"`.
- `packages/cli/test/build-e2e.test.ts` + fixtures — host E2E ship gate.
- `docs/enduser/deploy/standalone-binary.md` (+ binary-facing deploy pages) — reconciled.

## Success criteria

`stackbase build` in a fixture app produces a host binary that, run with a temp data dir + admin key, prints the ready-line and serves a committing mutation whose write reads back — proven by `build-e2e.test.ts` through the real produced executable; `--target=linux-x64` produces a file; the binary-facing docs no longer reference non-existent packages.
