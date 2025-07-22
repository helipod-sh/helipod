# `stackbase serve` + Docker self-host — design (slice 6a)

**Status:** approved (brainstorming) — 2025-07-19
**Slice:** 6a — the first sub-slice of build-order slice 6 (Production deploy tooling). Slice 6 was decomposed into **6a** (this: production server + Docker self-host on SQLite), **6b** (`stackbase deploy` push-to-remote — deferred), **6c** (Postgres adapter — deferred).
**Goal:** make Stackbase actually deployable — a `stackbase serve` production entrypoint and a `docker compose up` that brings up a working backend on SQLite with a persistent volume. This is the locked "Docker self-host baseline."

---

## 1. The one concept

`stackbase serve` is the **production sibling of `stackbase dev`**: it loads + composes the app's functions from `--dir <convex>` at boot (in-memory; Bun imports `.ts` natively, so **no bundling and no codegen-write**), opens the same embedded engine on SQLite at a persistent `--data` path, and serves the **already-built** surface — sync WS, `/api/*`, httpActions, `/_admin/*`, dashboard. It differs from `dev` only by *removing* the file watcher / hot-reload / codegen-into-source and *adding* production hardening (required persistent admin key, `0.0.0.0` bind, graceful shutdown, structured logging).

The implementation move: **factor the shared boot core out of `devCommand`** (load → compose → make store → make runtime → start server) into one helper both `dev` and `serve` call, so `dev` behavior is unchanged (regression-safe) and `serve` is small and diverges only on watch / key-policy / bind / shutdown.

---

## 2. Locked decisions (from brainstorming)

1. **Scope = 6a only.** `stackbase deploy` (push-to-remote) and the Postgres adapter are deferred to 6b/6c.
2. **App delivery = bind-mount (default).** The shipped image is the generic Stackbase engine; `docker compose up` bind-mounts the operator's `./convex` (`:ro`) + a data volume and runs `serve --dir /app/convex`. Baking the app into an image (author's `Dockerfile FROM stackbase`) is the documented immutable-deploy alternative; `serve --dir` supports both.
3. **Admin key REQUIRED — fail fast.** `serve` refuses to start if `STACKBASE_ADMIN_KEY` is unset/blank. A prod server on `0.0.0.0` must not expose an unauthenticated admin surface. (`dev` keeps its ephemeral-key-with-warning behavior; only `serve` is strict.)
4. **No codegen at runtime.** The mounted `convex/` MUST already contain a committed `_generated/` (its `.ts` imports `./_generated/*`, produced by `dev`/`codegen` at author time). `serve` composes in-memory and never writes into the (possibly `:ro`) source dir. Missing `_generated/` → fail fast.
5. **Bind `0.0.0.0` by default** (containers); `--ip` / `PORT` / `--port` override (default port 3000).
6. **Graceful shutdown.** SIGTERM/SIGINT → stop accepting, drain in-flight, close WS sessions, checkpoint + close SQLite, exit 0.
7. **Dashboard: served by default, admin-key-gated, toggleable** via `--no-dashboard` / `STACKBASE_DASHBOARD=off`.
8. **Docker E2E scope:** the automated test suite exercises `serveCommand` in-process (real WS/HTTP/persistence); a full `docker compose up` container run is a **documented manual smoke check**, not an automated CI test (Docker isn't assumed in the test env). The compose stage-name fix is guarded by a config-parse assertion.

---

## 3. API — the command surface

```
stackbase serve [--dir <convex>] [--data <path>] [--port <n>] [--ip <addr>] [--no-dashboard]
```
- `--dir` (default `./convex`) — the app's function dir; must contain `_generated/`.
- `--data` (default `$STACKBASE_DATA_DIR/db.sqlite` or `./data/db.sqlite`) — the SQLite file (persistent).
- `--port` (default `$PORT` or `3000`), `--ip` (default `0.0.0.0`).
- `--no-dashboard` (or `STACKBASE_DASHBOARD=off`) — don't serve the dashboard SPA (the `/_admin` API stays; only the UI is withheld).
- Env: `STACKBASE_ADMIN_KEY` (**required**), `STACKBASE_DATA_DIR`, `PORT`, `STACKBASE_DASHBOARD`.

---

## 4. The mechanism (boot core · serve · signals · docker)

**(a) Shared boot core (`packages/cli/src/boot.ts`, new).** Extract from `devCommand` the sequence: `loadConvexDir(dir)` → `loadConfig(projectRoot)` → `push(loaded, components)` (compose + codegen *artifacts in memory*) → `makeStore(dataPath)` → `createEmbeddedRuntime({...})`. Return `{ runtime, project, generated, store }`. `devCommand` and `serveCommand` both call it; `devCommand` additionally does `writeGenerated` + `createWatchLoop`; `serveCommand` does neither.
> The refactor must be behavior-preserving for `dev` — the extracted core produces the exact same runtime/project `dev` builds today. Existing `dev`/E2E tests are the regression guard.

**(b) `serveCommand(args)` (`packages/cli/src/serve.ts`, new).**
1. Parse flags (reuse `parseFlags`, add `--no-dashboard`).
2. **Require the admin key:** `const key = process.env.STACKBASE_ADMIN_KEY?.trim(); if (!key) { stderr("STACKBASE_ADMIN_KEY is required for `serve` — set it to a strong secret."); return 1; }`.
3. **Require `_generated/`:** before the boot core, assert `<dir>/_generated/` exists (e.g. `server.ts` present); else fail fast with the codegen instruction. (Also surfaces naturally if a `.ts` import of `./_generated/*` throws at load — but check explicitly for a clean message.)
4. Call the boot core (no `writeGenerated`).
5. `startDevServer(runtime, { functions, tables }, { port, ip: opts.ip ?? "0.0.0.0", admin: { api, key }, dashboard: noDashboard ? undefined : loadDashboard(key) })` — same server, prod options. (`loadDashboard(key)` embeds the key for same-origin admin calls, as in dev.)
6. **No watcher.** Instead, install signal handlers (see (c)) and keep the process alive.
7. Structured stdout log line on boot (`{"level":"info","msg":"stackbase serve","url":...,"dir":...,"data":...}` or a concise structured line) — not the dev pretty banner.

**(c) Graceful shutdown (`serve.ts`).** `DevServer` already exposes `close(): Promise<void>` (both backends drain HTTP + close WS). No signal handling exists today. Add: `for (const sig of ["SIGTERM","SIGINT"]) process.on(sig, once(async () => { await server.close(); await runtime.close?.() /* or store.close() — checkpoint + close SQLite */; process.exit(0); }));`. Idempotent (a second signal doesn't double-run). If `runtime`/`store` lacks a close, add a minimal `close()` that closes the SQLite adapter (checkpoint WAL + close handle) so the volume is left clean.

**(d) `bin.ts`.** Add the `serve` subcommand next to `dev`/`codegen`: `case "serve": return serveCommand(rest)`.

**(e) Dockerfile (runtime stage).** Replace the placeholder `CMD`:
```dockerfile
ENTRYPOINT ["bun", "packages/cli/dist/bin.js"]
CMD ["serve", "--dir", "/app/convex", "--data", "/data/db.sqlite"]
```
Keep the non-root `bun` user, `VOLUME ["/data"]`, and `EXPOSE 3000` (align the exposed port to serve's default 3000). The image is the generic engine — the app dir is supplied at run time.

**(f) `docker-compose.yml`.** Fix the stage-name bug (`target: runtime` → `target: runner`); bind-mount the app + data; require the key:
```yaml
services:
  stackbase:
    build: { context: ., target: runner }
    image: stackbase:latest
    ports: ["3000:3000"]
    environment:
      STACKBASE_ADMIN_KEY: ${STACKBASE_ADMIN_KEY:?set STACKBASE_ADMIN_KEY in .env}
      STACKBASE_DATA_DIR: /data
    volumes:
      - ./convex:/app/convex:ro
      - stackbase-data:/data
    command: ["serve", "--dir", "/app/convex", "--data", "/data/db.sqlite"]
    restart: unless-stopped
volumes: { stackbase-data: {} }
```

---

## 5. Data flow (`docker compose up`)

1. Operator has `convex/` (with committed `_generated/`) + `docker-compose.yml` + `STACKBASE_ADMIN_KEY` in `.env`.
2. `docker compose up` → generic stackbase image, bind-mounts `./convex:ro` + `stackbase-data`.
3. Container runs `stackbase serve --dir /app/convex --data /data/db.sqlite`, binds `0.0.0.0:3000`.
4. `serve`: require key → require `_generated/` → boot core (compose in-memory, open SQLite on the volume, boot engine) → start server (sync WS + HTTP + httpActions + dashboard).
5. Clients connect over WS/HTTP; webhooks hit httpActions; the key-gated dashboard is at `:3000/_dashboard`.
6. `docker compose down` → SIGTERM → graceful drain → **data persists on `stackbase-data`** across restarts.

---

## 6. Error handling

Fail fast (non-zero exit, clear stderr message), never serve a half-broken engine:
- Missing/blank `STACKBASE_ADMIN_KEY` → "required for `serve`".
- Missing `_generated/` in `--dir` → "run `stackbase codegen` and commit `_generated/` before deploying".
- `--dir` missing / not a convex dir → clear error.
- Data path unwritable / volume not mounted → clear error at boot (from `makeStore`).
- Boot-time compose/function-load error → log + exit non-zero.
- SIGTERM/SIGINT mid-flight → drain in-flight, close, exit 0.

---

## 7. Testing

- **Unit (`packages/cli/test/serve.test.ts`):** `serveCommand` (a) returns non-zero + a clear message with NO `STACKBASE_ADMIN_KEY`; (b) returns non-zero with a key but a `--dir` lacking `_generated/`; (c) with a key + a valid fixture dir + a temp SQLite path, boots and `GET /api/health` responds ok; (d) `close()`/SIGTERM path drains and closes the store cleanly (the SQLite file is closed — a subsequent open succeeds).
- **E2E through the real `serve` entrypoint (`packages/cli/test/serve-e2e.test.ts`):** run `serveCommand` against a fixture convex dir (with `_generated/`, a query + mutation + an httpAction) + a temp SQLite file (set `STACKBASE_ADMIN_KEY`). Assert: a real WS client subscribes to a query and a real mutation fans out (QueryUpdated); a real httpAction webhook (`POST /hook`) works and its `ctx.runMutation` fans out; then **stop the server and re-`serve` against the SAME SQLite file → the previously-written row is still present** (durability on the persistent path). The "test through the shipped entrypoint" discipline (has caught mechanism-invisible bugs repeatedly in this project).
- **Docker (`packages/cli/test/docker-config.test.ts` or a script):** parse `docker-compose.yml` and assert `services.stackbase.build.target` names a stage that EXISTS in the `Dockerfile` (guards the `runtime`→`runner` bug from regressing); assert the Dockerfile's runtime `CMD`/`ENTRYPOINT` invokes `serve`. A full `docker compose up` container run is a **documented manual smoke check** in the self-host guide, not an automated test.
- **Regression:** all existing `dev`/E2E/package tests green — the shared boot-core refactor is behavior-preserving for `dev`.

---

## 8. File structure

- **Create:** `packages/cli/src/serve.ts`, `packages/cli/src/boot.ts`, `packages/cli/test/serve.test.ts`, `packages/cli/test/serve-e2e.test.ts`, `packages/cli/test/docker-config.test.ts`, `docs/enduser/self-hosting.md`.
- **Modify:** `packages/cli/src/cli.ts` (extract the boot core; `devCommand` calls it), `packages/cli/src/bin.ts` (the `serve` subcommand), `packages/cli/src/server.ts` (ensure `close()` also allows the caller to tear down the store; add a store `close()` if missing), `Dockerfile` (runtime `ENTRYPOINT`/`CMD`), `docker-compose.yml` (stage fix + mounts + key + command).
- **Docs:** `docs/enduser/self-hosting.md` (the compose recipe, the required key, the bake-into-image alternative, the reverse-proxy/TLS note); update `CLAUDE.md` (slice 6a shipped: `stackbase serve` + working Docker self-host).

---

## 9. Non-goals (6a)

- `stackbase deploy` push-to-remote (**6b**) · Postgres adapter (**6c**).
- TLS termination — front with a reverse proxy (nginx/Caddy/Traefik), documented in the self-host guide.
- Multi-node / clustering / horizontal scale (Tier 2).
- Automated Docker-in-CI container E2E (documented manual smoke instead).
- Secrets management beyond env vars (env is the baseline).
- Zero-downtime rolling restart / blue-green (single-container baseline; a restart is a brief downtime).
