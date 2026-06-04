# `@stackbase/vite` Single-Origin Dev Plugin — Design Spec

**Date:** 2026-05-15
**Status:** Design (pre-plan). Brainstorming complete; awaiting user review before the implementation plan.
**Slice:** Follow-on #2 to the DeployTarget seam ([[deploy-target-seam-shipped]]). Phase 1 of the single-origin dev integration (the generic, in-process-agnostic path). Phase 2 (in-process embed / `@cloudflare/vite-plugin` parity) is deferred.

## Goal

Let a developer run a single `vite` command and get their frontend **and** the Stackbase backend on one browser origin — no manual Vite proxy, no CORS, `@stackbase/client`'s existing `` `${location.host}/api/sync` `` "just works." For **any** deploy target (serve/docker/cloudflare), since dev is decoupled from the deploy mechanism.

## Approach (decided): auto-proxy a spawned `stackbase dev`

The plugin **spawns `stackbase dev` as a child process** and **injects Vite's dev-server proxy** so the browser only ever talks to `:5173`. Chosen over the in-process embed because it delivers the *identical* browser-facing DX (one origin, zero CORS, zero config) while **reusing `stackbase dev` verbatim** — codegen, `convex/` hot-reload, and the reactive WebSocket are all handled by the child, with **zero divergence risk** and no HMR-ws-collision code. This is the project's proven "wrap the tool, don't reimplement" pattern (`stackbase build`→`bun build`, the cloudflare deploy target→`wrangler`).

The user's browser experience is single-origin regardless of the two processes underneath: every request goes to `localhost:5173`, and Vite proxies the engine-owned prefixes to the child.

**Phase 2 (deferred, documented): in-process embed** — boot the `EmbeddedRuntime` as Vite connect-middleware (one process, no proxy hop), behind the *same* `stackbase()` public surface. Built only if one-process purity becomes a real need.

## Current state this builds on

- `@stackbase/client` connects to `` `${location.host}/api/sync` `` (see `examples/chat/web/main.tsx:16`) — already same-origin-aware; **no client change needed**.
- `stackbase dev` (`packages/cli/src/cli.ts`) accepts `--port`, `--dir`, `--data`, `--database-url`, etc., watches `convex/`, hot-reloads, and serves `/api` + `/api/sync` (WebSocket) + `/_dashboard` + `/_admin`. On start it prints `stackbase dev → <url>` (no machine-readable ready line — readiness is detected by polling the port).
- Reference studied: `.reference/lunora/packages/vite` (it composes `@cloudflare/vite-plugin` for the workerd path — we borrow the plugin-composition shape, not the workerd mechanism).

## Architecture

New package **`packages/vite`** (`@stackbase/vite`). Peer dependency: `vite`. **Runtime dependencies: node builtins only** (`node:child_process`, `node:net`) — it invokes the `stackbase` CLI as a subprocess, so it needs no `@stackbase/*` runtime dependency. A thin spawner + proxy (~150 lines).

### The plugin (`stackbase(options?)` → Vite `Plugin`)

Three hooks:

1. **`config` (async):** resolve the backend port — the `port` option, else a free ephemeral port (via a `node:net` listen-on-0 probe). Return a partial config that sets `server.proxy` for the engine-owned prefixes, all targeting `http://localhost:<port>`:
   - `/api` → `{ target, ws: true, changeOrigin: true }` (data plane **and** the `/api/sync` WebSocket).
   - `/_dashboard` → `{ target }`.
   - `/_admin` → `{ target }`.
   Store the resolved port for `configureServer`. (Vite merges this proxy config with the user's own `server.proxy` — the plugin never clobbers unrelated proxy entries.)

2. **`configureServer(server)`:** spawn `stackbase dev --port <port> --dir <convexDir> [...args]` via the resolved `command`. Pipe the child's stdout/stderr into Vite's logger, line-prefixed `[stackbase]`, so backend logs share the terminal. **Await readiness** — poll `localhost:<port>` (TCP connect) until it accepts, with a timeout; on timeout or an early child exit, throw a clear error (so `vite` fails loudly rather than serving a dead proxy). Register cleanup (below).

3. **Cleanup:** kill the child on Vite server close (`server.httpServer.on("close")` / the `configureServer` teardown) **and** on `process` `SIGINT`/`SIGTERM`/`exit`. Idempotent (guarded flag) so double-signals don't double-kill. Goal: never leak an orphaned `stackbase dev`.

### CLI resolution (`command`)

Default resolution order: (1) `node_modules/.bin/stackbase` if present (the app's local install); (2) fall back to `npx stackbase`. Overridable via the `command` option (a string; split on spaces or an argv array). The `dev` subcommand + flags are appended by the plugin.

### Options

```ts
export interface StackbaseVitePluginOptions {
  convexDir?: string;   // → --dir  (default "convex")
  port?: number;        // backend port (default: a resolved free port)
  command?: string;     // CLI invocation (default: resolve node_modules/.bin/stackbase, else "npx stackbase")
  args?: string[];      // extra flags forwarded to `stackbase dev` (e.g. ["--database-url", "postgres://…"])
}
export function stackbase(options?: StackbaseVitePluginOptions): import("vite").Plugin;
```

## Data flow (dev)

```
browser (localhost:5173)
  ├─ GET /            → Vite (frontend + HMR ws)          [Vite owns this]
  ├─ /api/*, /api/sync(ws) → Vite proxy → stackbase dev (localhost:<port>)  → engine
  ├─ /_dashboard      → Vite proxy → stackbase dev
  └─ /_admin/*        → Vite proxy → stackbase dev
```
Frontend HMR (Vite's ws) and reactive sync (`/api/sync`, proxied) are on separate servers → no collision. Two independent reload loops.

## Error handling

- **Child fails to boot / exits early:** `configureServer` throws with the child's stderr tail → `vite` exits with a clear message (not a silent dead proxy).
- **Port already in use** (explicit `port` option): the child's own bind error surfaces via the piped stderr + the readiness timeout.
- **Transient proxy calls before ready:** eliminated by awaiting readiness before the dev server accepts connections.
- **Orphan prevention:** cleanup on close + signals, idempotent.

## Testing

- **Unit (fast lane):** with an injected fake spawner + a fake proxy-config sink — `config` produces the exact proxy map for a given port (`/api` has `ws:true`; `/_dashboard`/`/_admin` present; user proxy entries preserved); free-port resolution returns an open port; `command` resolution (local bin vs `npx`) and `args`/`convexDir` forwarding into the spawn argv; cleanup kills the child exactly once on close and on a signal.
- **E2E (serial lane, `*-e2e.test.ts`):** drive Vite's programmatic dev server (`createServer`) with the plugin against a small fixture app + a real `stackbase dev`; assert `GET http://localhost:<vitePort>/api/health` proxies through and returns 200 from the engine, and a raw WebSocket to `ws://localhost:<vitePort>/api/sync` connects (proving the `ws:true` proxy). No browser required. Tear down both Vite and the child.

## Package layout

- **New:** `packages/vite/` — `package.json` (peer `vite`, no `@stackbase/*` runtime deps), `tsconfig.json`, `tsup.config.ts`, `src/index.ts` (the `stackbase()` plugin + options), `src/free-port.ts` (port probe), `src/resolve-cli.ts` (command resolution), `src/child.ts` (spawn + readiness + cleanup). Tests under `test/`.
- **Docs:** `docs/enduser/local/vite-plugin.md` — the `plugins: [stackbase()]` setup, what it does, options, and the note that it complements (doesn't replace) `stackbase dev` for backend-only/non-Vite workflows.

## Non-goals

- **Phase 2 in-process embed** (documented follow-on).
- Framework-specific SSR composition (lunora's class-A/B/C framework handling) — out of scope; the plugin is frontend-framework-agnostic (it only proxies engine prefixes; the rest is the user's Vite app).
- Serving/bundling the frontend for production (that's `vite build` + the deploy target's static-serving — separate concern).
- Auto-injecting the client or any app code — the plugin only wires dev routing.
