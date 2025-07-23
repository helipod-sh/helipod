# `stackbase deploy` — push-based deploys — design

**Status:** approved (brainstorming) — 2025-07-19
**Slice:** build-order slice **6b** (production deploy tooling). Slice 6a (`stackbase serve` + Docker self-host) shipped; this is push-based code deploys to a *running* remote engine. 6c (Postgres adapter) remains deferred.
**Reference:** Convex `convex deploy` (bundle functions + schema, push to a running deployment, atomic swap). Studied, not copied.

---

## 1. Goal

Let a developer push new app code (functions + schema) to a **running** remote `stackbase serve` instance over HTTP and have it applied **live, without a restart** — the remote analog of `stackbase dev`'s hot reload. `stackbase deploy --url https://myapp.example` replaces the deployment's functions and adopts additive schema changes with zero downtime.

**The one concept: a deploy is a remote `dev`-reload.** `dev` reloads by re-running `loadConvexDir → push → runtime.setModules` in-process on file change. `deploy` does the same three steps, except the CLI ships the app to the remote first and the remote runs the pipeline against the pushed files. It reuses `push`, `setModules`, `server.setRoutes`, and the `@stackbase/*`→`/app/node_modules` container resolution shipped in 6a — the net-new surface is a CLI packaging step, one admin endpoint, and a schema-diff.

---

## 2. Locked decisions (from brainstorming)

1. **Live push, hot-swap.** The remote loads the pushed app in-process and swaps `setModules` + routes + additive schema live; no restart, no downtime. In-process eval of the pushed bundle is acceptable for single-tenant self-host (same trust level as bind-mounting or baking your own code); true V8-isolate sandboxing (multi-tenant) stays deferred.
2. **Code + additive schema; reject destructive.** Deploy pushes functions AND schema. The engine adopts additive changes (new tables, new optional fields) with **stable tableNumbers**; it detects and **rejects** destructive/incompatible changes (dropped or renamed table, changed tableNumber, incompatible field-type change) with a clear diff, leaving the old version running. **No data migrations/backfills** — deferred.
3. **Opt-in deploy endpoint.** `POST /_admin/deploy` is **disabled by default**; `serve` accepts live code push only when started with `--allow-deploy` (or `STACKBASE_ALLOW_DEPLOY=1`). Defense-in-depth: a leaked admin key can read/write data but cannot inject code unless the operator explicitly opted the deployment into being a push target. When enabled, the endpoint is still admin-key gated.
4. **Approach B — push a transpiled file tree, remote reuses the existing load pipeline.** The CLI transpiles `convex/` per-file to JS (externalizing `@stackbase/*` + node builtins), preserving the tree; the remote writes it under a writable `/app` subdir and runs the existing `loadConvexDir → push → setModules`. Preserves the `path:name` function-path model, rides the shipped `@stackbase/*` resolution, and is runtime-agnostic (plain JS, works under Node too).
5. **Target via flags/env; admin key required.** `stackbase deploy --url <url>` (or `STACKBASE_DEPLOY_URL`); admin key from `STACKBASE_ADMIN_KEY` (fail-fast if missing). No deploy-config file in v1.

---

## 3. API — the surfaces

### CLI

```bash
# Push the local convex/ to a running deployment.
STACKBASE_ADMIN_KEY=<key> stackbase deploy --url https://myapp.example
#   --url <url>     target base URL (or STACKBASE_DEPLOY_URL)
#   --dir <dir>     convex dir (default: convex)
# On success: prints the new revision id + function count.
# On failure: prints the specific error (unreachable / not enabled / load error / destructive schema) and exits non-zero.
```

`deploy` also refreshes local `convex/_generated/` (via the same `push`) so the client's typed API matches what was deployed.

### Server

```bash
stackbase serve --allow-deploy            # enable the deploy endpoint (or STACKBASE_ALLOW_DEPLOY=1)
```

`POST /_admin/deploy` — admin-key gated **and** `allowDeploy` gated. Request body (JSON): `{ files: [{ path: string, code: string }] }` — the transpiled app tree (paths relative to the convex dir, e.g. `schema.js`, `messages.js`, `_generated/server.js`, `stackbase.config.js` if present). Response: `{ ok: true, rev: string, functions: number }` on success; `{ ok: false, error: string, kind: "not-enabled" | "load-error" | "schema-incompatible" }` with the appropriate 4xx status on rejection.

---

## 4. The mechanism (CLI · endpoint · schema-diff · swap)

**(a) CLI — `packages/cli/src/deploy.ts`.**
- `resolveDeployOptions(args)`: `url` (flag or `STACKBASE_DEPLOY_URL`), `convexDir` (default `convex`), `adminKey` (`STACKBASE_ADMIN_KEY`). Fail-fast (exit 1, clear stderr) on missing url or missing/blank admin key.
- `deployCommand(args)`: load + `push` locally (validates the app compiles/loads and refreshes `_generated/`); **transpile** each app source file to JS with `@stackbase/*` and node builtins marked **external**, preserving the relative tree (use the project's existing esbuild/`Bun.build` toolchain; per-file transform, not a single bundle, so `path:name` boundaries survive); assemble `{ files }`; `POST` to `<url>/_admin/deploy` with `Authorization: Bearer <adminKey>`; print the result (including the `rev` the remote returns). The `rev` is a short content hash of the pushed files, computed by the remote (authoritative) and echoed in the response.
- `runCli` gains `case "deploy": return deployCommand(rest)`.

**(b) Endpoint — `packages/cli/src/http-handler.ts` (admin surface).**
The deploy handler is registered only when `allowDeploy` is true (threaded from `serve` through `startDevServer`). On `POST /_admin/deploy`, after the existing admin-key check:
1. If `allowDeploy` is false → `403 { ok:false, kind:"not-enabled", error:"deploy endpoint disabled — start serve with --allow-deploy" }`. (When disabled the route is not registered at all, so this is belt-and-suspenders; the primary gate is non-registration.)
2. Write `files[]` under a fresh `deployRoot/<rev>/` where `deployRoot` is a writable dir a sibling-chain away from the engine's `node_modules` (in the image, under `/app`, e.g. `/app/.stackbase-deploy/`; in dev/tests, a temp dir under the project root) so `@stackbase/*` resolves. `rev` = content hash of the files.
3. `loadConvexDir(<rev>/)` → `push(loaded, components)` → new `ProjectArtifacts` (`moduleMap`, `schemaJson`, `tableNumbers`, `routes`, `manifest`). **`components` is the server's boot-time set** (the payload carries only `convex/`, not the project-root `stackbase.config.ts`, so the component set cannot change on a deploy). A throw here (syntax error, bad import, or a function referencing a component the server didn't boot with) → `400 { kind:"load-error", error:<message> }`, **no swap**. (This is how "component-set changes require a restart" is enforced — a pushed app that needs a different component surfaces as a load-error, not a silent swap.)
4. `diffSchema(current, next)` (§4c). Destructive → `400 { kind:"schema-incompatible", error:<diff> }`, no swap.
5. **Atomic swap** (only after 3–4 pass): `runtime.setModules(next.moduleMap)`; `runtime.setTableNumbers(next.tableNumbers)`; `server.setRoutes(next.routes)`; `adminApi.setSchema(next.schemaJson, next.tableNumbers, next.manifest)`. Respond `200 { ok:true, rev, functions: Object.keys(next.moduleMap).length }`.

**(c) Schema-diff — `packages/cli/src/schema-diff.ts`.**
Pure function `diffSchema(current, next): { ok: true } | { ok: false, reason: string }`. Given two `{ tables: { [name]: { tableNumber, fields } } }` shapes (derived from `schemaJson` + `tableNumbers`):
- **Reject** if any table present in `current` is absent in `next` (dropped/renamed) → destructive.
- **Reject** if a table's `tableNumber` changed between `current` and `next` (identity break).
- **Reject** if a field that exists in both changed to an **incompatible** validator (e.g. `string`→`number`; a widening like adding a union member or making a field optional is allowed; a required-field ADD on an existing table is destructive because existing rows lack it — reject unless the new field is optional).
- **Allow** new tables, and new **optional** fields on existing tables. Return `{ ok:true }`.
Unit-tested in isolation (no server).

**(d) Runtime / AdminApi updates.**
- `runtime.setModules` already exists (hot-swaps in place). If the runtime independently caches `tableNumbers` for write validation, add `runtime.setTableNumbers(next)` (additive, so existing numbers are unchanged); otherwise no runtime change beyond `setModules`.
- `AdminApi.setSchema(schemaJson, tableNumbers, manifest)` — updates what the data browser and validation report, so a post-deploy admin browse reflects new tables. Additive, so live subscriptions on existing tables are unaffected.

---

## 5. Data flow (a deploy, end to end)

1. Dev runs `stackbase deploy --url https://myapp.example` (admin key in env).
2. CLI loads + `push`es locally (validates, refreshes `_generated/`), transpiles `convex/` → JS tree (`@stackbase/*` external).
3. CLI `POST`s `{ files }` to `https://myapp.example/_admin/deploy` with the admin key.
4. Remote (allowDeploy on) writes the tree under `/app/.stackbase-deploy/<rev>/`, runs `loadConvexDir → push`.
5. Remote checks: component-set unchanged, schema additive (`diffSchema`). Any failure → 4xx, old version keeps running.
6. Remote atomically `setModules` + `setRoutes` + `setSchema`; responds `{ ok, rev, functions }`.
7. New functions are immediately callable; a newly-deployed mutation's write **fans out reactively** to live subscriptions whose read-set it intersects (the same reactive path `dev` reload uses).

---

## 6. Error handling

- **Missing `--url`/`STACKBASE_DEPLOY_URL` or blank `STACKBASE_ADMIN_KEY`** → CLI fail-fast, exit 1, clear stderr.
- **Target unreachable / non-2xx** → CLI prints the status + server error body, exit 1.
- **`--allow-deploy` off on the target** → the route isn't registered → 404/403; CLI translates to "deploy not enabled on target (start serve with --allow-deploy)".
- **Pushed app fails to load** (syntax error, bad import, or a reference to a component the server didn't boot with — the component set is fixed at boot since `stackbase.config.ts` isn't in the payload) → remote `400 kind:load-error`, **no swap**; CLI prints the message.
- **Destructive schema change** → remote `400 kind:schema-incompatible` with the offending table/field, no swap; CLI prints it.
- **Atomicity:** load + component-check + schema-diff all complete **before** the first swap call; the swap itself is a synchronous `setModules`/`setRoutes`/`setSchema` sequence on already-validated artifacts. A failed deploy never leaves a half-applied state; the previous version stays live.

---

## 7. Testing

- **Unit — transpile/package (`packages/cli/test/deploy-bundle.test.ts`):** the CLI transform emits JS with `@stackbase/*` + node builtins marked external (not inlined), preserves the file tree/paths, and includes `_generated/` + `stackbase.config` when present.
- **Unit — schema-diff (`packages/cli/test/schema-diff.test.ts`):** additive (new table, new optional field) → `ok:true`; each destructive case (dropped table, changed tableNumber, `string`→`number`, required-field-add on existing table) → `ok:false` with a reason.
- **Unit — deploy endpoint (`packages/cli/test/deploy-endpoint.test.ts`):** allowDeploy-off → not-enabled; admin-key missing/wrong → 401; a valid additive push loads + swaps; a load-error and a destructive-schema push each 4xx **without** swapping (the prior moduleMap still serves).
- **E2E through the real `serve` server (`packages/cli/test/deploy-e2e.test.ts`)** — the project's "test through the shipped entrypoint" discipline: start `serve --allow-deploy` on app-v1 (a query + a table); run the **real `deployCommand`** against it pushing app-v2 that adds a mutation + an additive table; assert (a) the new mutation is callable via `POST /api/run`, (b) its write **fans out to a live WS subscription** (reactive path intact across a live deploy), (c) a subsequent **destructive** push is rejected and v1's functions still serve, (d) a deploy against a **`--allow-deploy`-off** server is refused with the not-enabled message.
- **Regression:** all existing tests green — deploy is additive (a new command, a new opt-in endpoint, reused pipeline; `dev`/`serve`/existing admin routes unchanged).

---

## 8. File structure

- **New:** `packages/cli/src/deploy.ts` (`resolveDeployOptions`, `deployCommand`, transpile/package, POST), `packages/cli/src/schema-diff.ts` (`diffSchema`), plus the four test files above.
- **Modify:** `packages/cli/src/serve.ts` (`--allow-deploy`/`STACKBASE_ALLOW_DEPLOY` option → thread through), `packages/cli/src/server.ts` (accept `allowDeploy` + a deploy hook: access to `runtime.setModules`, `currentRoutes`/`setRoutes`, and `adminApi.setSchema`), `packages/cli/src/http-handler.ts` (`POST /_admin/deploy` handler, registered only when `allowDeploy`), `packages/cli/src/cli.ts` (`runCli` `case "deploy"`), `packages/runtime-embedded/src/runtime.ts` (`setTableNumbers` if needed) and `packages/admin` (`AdminApi.setSchema`).
- **Docs:** `docs/enduser/` deploy guide (push to a running deployment; `--allow-deploy`; additive-only schema; TLS/reverse-proxy note reused from self-hosting); `CLAUDE.md` (move `stackbase deploy` push from deferred → shipped 6b; keep 6c deferred).

---

## 9. Non-goals (v1)

- **Data migrations / backfills** — destructive schema changes are rejected, not migrated (a future slice).
- **Changing the composed component set live** (adding/removing `@stackbase/scheduler`/`workflow`) — requires a restart; deploy hot-swaps functions + routes + additive schema only.
- **Deploy history / `rollback` to a prior revision** — a failed deploy keeps the old version live, but there is no command to roll back a *successful* deploy (redeploy the prior code instead).
- **Multi-environment / project management, secret management, build caching** — out of scope.
- **True V8-isolate sandboxing of pushed code** — in-process eval; single-tenant trust, identical to the bind-mount/bake paths.
- **A deploy-config file / named deployments** — flags + env only in v1.
- **Auth/identity changes** — the admin key is the deploy gate; request identity resolution is unchanged.
