# `@stackbase/vite` Phase 2 — In-Process Embed — Design Note

**Date:** 2026-05-15
**Status:** Design + implemented (this slice).
**Slice:** Phase 2 of the single-origin Vite integration. Phase 1 (auto-proxy a spawned `stackbase dev`) shipped per [`2026-05-15-vite-plugin-design.md`](./2026-05-15-vite-plugin-design.md); that spec explicitly deferred this. Phase 1 stays the **default** and is unchanged.

## Goal

Run the Stackbase engine **inside Vite's own dev-server process** — no child `stackbase dev`, no proxy hop — as an **opt-in** alternative to Phase 1, behind the *same* `stackbase()` plugin surface. One process, one origin. Chosen for hosts that want a single process (fewer moving parts, no orphaned child, no port-probe/readiness race) and don't mind that the engine now shares Vite's Node runtime.

## The mode switch

`stackbase()` gains one option: `mode?: "proxy" | "embed"` (default `"proxy"`).

```ts
export function stackbase(options: StackbaseVitePluginOptions = {}): Plugin {
  return (options.mode ?? "proxy") === "embed" ? embedPlugin(options) : proxyPlugin(options);
}
```

- `proxyPlugin` is the **verbatim** Phase-1 implementation (the `config` proxy hook + `configureServer` child-spawn). Byte-for-byte unchanged, still the default — a caller who never passes `mode` gets exactly today's behavior.
- `embedPlugin` is the new path below. It has **no `config` hook** (no proxy — the engine is served in-process), only `configureServer`.

New embed-only options (ignored in proxy mode): `dataPath` (SQLite file, default `<root>/.stackbase/dev.db`), `databaseUrl` (Postgres opt-in), `adminKey` (default: a per-run ephemeral key). `convexDir` is shared with proxy mode.

## What `embedPlugin.configureServer(server)` does

1. **Boot the engine in Vite's process.** `await bootProject({ convexDir, dataPath, adminKey, databaseUrl, storage })` (the same shared boot core `stackbase dev`/`serve` use) → `{ runtime, adminApi, project, generated, store, storageRoutes, componentRoutes, ... }`. Then `writeGenerated(generated.files, <convexDir>/_generated)` so the app's `convex/_generated/*` imports resolve for Vite/TS — exactly what `dev` does.

2. **Mount the engine as connect-middleware** on `server.middlewares` (a *pre* middleware — registered in the `configureServer` body, so it runs before Vite's transform/SPA-fallback). For an **engine path** (`/api`, `/_admin`, `/_dashboard` prefixes) it translates the Node `req`/`res` into the engine's `HttpRequest`, dispatches through **storage routes → component routes → `handleHttpRequest`** (the same precedence `server.ts`'s Node backend uses), and writes the `HttpResponse` back. For **everything else it calls `next()`** — Vite serves the frontend, HMR, modules, and static assets untouched. `/_dashboard` returns `handleHttpRequest`'s lightweight status page (the full dashboard SPA is a proxy-mode / standalone-`dev` feature; documented, not a regression of the required surface).

3. **Wire the reactive WebSocket** by attaching an `upgrade` listener to `server.httpServer` that handles **only** `/api/sync` (a `ws` `WebSocketServer({ noServer: true })` → `runtime.handler.connect/handleMessage/disconnect`, mirroring `server.ts`'s Node backend). See the coexistence section — this is the sharp edge.

4. **Hot-reload `convex/`** on `server.watcher` `add`/`change`/`unlink` events for files under `convexDir` (excluding `_generated`): re-`push` → `writeGenerated` → `runtime.setModules(withStorageModules(...))` → update the middleware's mutable `currentRoutes`. This is an **independent** reload loop from Vite HMR (which reloads the frontend) — a backend function edit re-pushes the engine; a frontend edit HMRs the browser. Debounced, and errors are logged without crashing the dev server (same tolerance as `dev`'s watch loop).

5. **Cleanup** on `server.httpServer` `close` (idempotent): stop the WS server, `runtime.stopDrivers()` (before the store, so a driver timer can't fire against a closed store — the same ordering `server.ts`'s `close()` enforces), await any `objectStoreRelease`, then `store.close()`.

## WS-upgrade vs Vite HMR coexistence (the sharp edge)

Both Vite's HMR WebSocket and our sync WebSocket live on the **same** `server.httpServer` (Vite's default `wsServer = server` when no separate `hmr.port` is set), and Node emits `'upgrade'` to **every** registered listener. Verified against the installed Vite 6 (`dist/node` `hmrServerWsListener`): Vite's upgrade listener calls `handleUpgrade` **only** when `sec-websocket-protocol` is `vite-hmr`/`vite-ping` **and** the path equals the HMR base — and it **does not touch** (does not `destroy`) sockets it doesn't own; it just returns.

That gives a clean, symmetric contract:

- **Our listener handles only `/api/sync`** and returns without touching the socket for any other path. Because we never `destroy` a foreign upgrade, Vite's co-registered listener still gets to process its own HMR upgrade.
- A `/api/sync` upgrade carries no `vite-hmr` subprotocol and isn't the HMR base path, so **Vite's listener ignores it** — ours handles it.

This is the one place the embed path deliberately **diverges** from `server.ts`'s Node backend: `server.ts` `socket.destroy()`s any non-`/api/sync` upgrade because it *owns* the whole HTTP server. In Vite we are a guest — destroying a foreign upgrade would kill Vite HMR. The rule "handle only your path, never destroy what isn't yours" is what makes two upgrade listeners coexist on one server. A stray upgrade to an unknown path is left un-answered (socket idles to timeout) — identical to Vite's own behavior for unrecognized upgrades.

## The `@stackbase/cli` dependency decision: **dynamic import**

Embed mode needs `bootProject`, `handleHttpRequest`, `writeGenerated`, `push`, `loadConvexDir`, `loadConfig`, and `withStorageModules` — all from `@stackbase/cli`. Making that a **direct runtime dependency** would pull the entire CLI (and its `node:http`/`ws`/adapter graph) into **every** consumer of `@stackbase/vite`, including proxy-mode users who never touch it.

**Decision: reach the CLI via a dynamic `import("@stackbase/cli")`, only inside `embedPlugin.configureServer`.** Proxy mode stays dependency-light (node builtins only, exactly as Phase 1 shipped). `@stackbase/cli` is listed as an **optional peer** (`peerDependenciesMeta.optional`) — a proxy-mode user needs it installed anyway (the plugin spawns its `stackbase` bin), and an embed-mode user demonstrably has it; the dynamic import fails fast with an actionable message if it's somehow absent. This mirrors the project's established "the enterprise/heavy dependency is reached only via an indirect `import()`" discipline (`boot.ts`'s `@stackbase/objectstore-substrate` gate, `serve.ts`'s `@stackbase/fleet` gate).

To support this, `@stackbase/cli`'s index gains re-exports of `bootProject`, `withStorageModules`, `loadDashboard` (+ `BootResult`/`BootProjectOptions` types) and `writeGenerated` — all already-existing internals, now part of the package's public surface so the plugin depends on the package boundary, not deep paths.

**`ws`** is reached the same way (`await import("ws")`, as `server.ts` already does) — it's a guaranteed transitive of Vite (Vite's own HMR uses it), so it always resolves in a Vite project without `@stackbase/vite` declaring it and without burdening proxy-mode users.

## What's reused (vs. reimplemented)

- **Reused wholesale:** `bootProject` (the entire engine boot — store, runtime, admin API, storage/component routes, drivers), `handleHttpRequest` (the pure HTTP dispatcher), `writeGenerated`/`push`/`loadConvexDir`/`loadConfig` (codegen + reload), `withStorageModules` (the `_storage:*` re-apply on hot-swap), the `runtime.handler.connect/handleMessage/disconnect` sync wiring, and the `runtime.stopDrivers()`-before-`store.close()` shutdown ordering.
- **Reimplemented (small, Vite-shaped):** the connect-`req`/`res` ↔ `HttpRequest`/`HttpResponse` translation and the storage/component route `{method,pathPrefix}` prefix-match (trivial, ~40 lines) — because `server.ts`'s versions are bound to owning a whole `node:http` server, not living as a guest middleware. The upgrade listener is the same wiring as `server.ts` minus the `destroy`-foreign-upgrades line (see coexistence).

## Testing

- **Unit:** `stackbase({ mode: "embed" })` returns a plugin with a `configureServer` and **no `config` hook** (no proxy); `stackbase()` / `{ mode: "proxy" }` is unchanged (still has the proxy `config` hook). The engine-path predicate (`/api`, `/_admin`, `/_dashboard` → engine; everything else → `next()`).
- **E2E (serial lane, `*-e2e.test.ts`):** boot a real Vite dev server programmatically with `stackbase({ mode: "embed" })` against the existing fixture, assert `GET /api/health` returns 200 **served in-process** (no child process, no proxy), and a raw `/api/sync` WebSocket connects — **while Vite's HMR WebSocket also connects on the same origin** (the coexistence proof: both a `vite-hmr` upgrade and an `/api/sync` upgrade succeed against the same `httpServer`).

## Non-goals (unchanged from Phase 1, plus embed-specific)

- Full dashboard SPA in embed mode (lightweight status page only; use proxy mode or standalone `stackbase dev` for the live browser).
- Production serving/bundling (that's `vite build` + a deploy target).
- Framework-specific SSR composition.
