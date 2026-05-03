/**
 * `RuntimeHost` — the neutral seam between the engine and whatever binds it to a transport
 * (HTTP + WebSocket). It exists so the SAME `EmbeddedRuntime` can run on a long-lived process
 * (`Bun.serve` / `node:http` + `ws`) AND on a Cloudflare Durable Object (Worker `fetch` +
 * `WebSocketPair`/hibernation), with each backend implementing this one method.
 *
 * NEUTRALITY RULE (a Slice-1 gate — asserted mechanically in
 * `packages/runtime-embedded/test/host-neutral.test.ts`): this file imports ONLY `@stackbase/*`
 * symbols and TS type-only imports. It contains NO host I/O primitive — no `bun`, `node:*`, `ws`,
 * no cloudflare type, no `DurableObjectNamespace`. Where a concept cannot be expressed neutrally it
 * is documented, not papered over (see `ServerHandle.close` and `ServeOptions` below).
 *
 * WHY GENERIC: `ServeOptions`/`ServerHandle` are lifted verbatim (no field changes) from the
 * process host's `DevServerOptions`/`DevServer`. Several of those fields reference types that live
 * in `@stackbase/cli`, `@stackbase/admin`, and `@stackbase/storage` — all of which depend ON
 * `@stackbase/runtime-embedded`, so importing them here would be a dependency cycle AND would drag
 * a host I/O concern into the neutral seam. The route/admin/storage/deploy/fleet shapes are
 * therefore carried as type parameters (defaulting to `unknown`): the neutral seam stays parametric
 * and each concrete host pins the parameters (`@stackbase/cli` re-aliases them as `DevServer`/
 * `DevServerOptions`). The FIELDS are unchanged; only their concrete types are supplied by the host.
 */
import type { EmbeddedRuntime } from "./runtime";

/**
 * The handle a host returns from {@link RuntimeHost.serve}. Its `close()`/`setRoutes()` are the ONLY
 * lifecycle a caller drives post-serve. Lifted verbatim from the process host's `DevServer`.
 */
export interface ServerHandle<Route = unknown> {
  url: string;
  /**
   * The bound TCP port. A portless host (a Durable Object — the Worker owns ingress, there is no
   * socket to bind) returns `0` as a sentinel. Do not treat `0` as "unbound/failed".
   */
  port: number;
  /**
   * Stop serving and release resources. **MAY never be called.** A host with no shutdown moment —
   * a Durable Object hibernates and is evicted silently, with no `SIGTERM` — is a valid host, and
   * such a host's `close()` may legitimately be a no-op. Do NOT rely on `close()` (and therefore
   * on `runtime.stopDrivers()` / `store.close()`) running: durable work must survive without it.
   * The process host DOES call `close()` on `SIGTERM`/`SIGINT`, exactly as before this seam existed.
   */
  close(): Promise<void>;
  /** Replace the httpAction route table, e.g. after a hot reload re-resolves `http.ts`. */
  setRoutes(routes: Route[]): void;
}

/**
 * The options a caller passes to {@link RuntimeHost.serve}. Lifted verbatim from the process host's
 * `DevServerOptions` — no field changes.
 *
 * IMPEDANCE CONTRACT (do not design against it): the sync handler's per-session state (each
 * session's read-set, held behind `runtime.handler.connect`/`handleMessage`) is NOT guaranteed to
 * survive a single `serve()` lifetime. On a Durable Object, WebSocket hibernation discards
 * in-memory state; a host may reconstruct a session from its durable attachment and call
 * `handler.connect` again on revival. A host must therefore treat
 * `handler.connect(sessionId, socket)` / `handler.disconnect(sessionId)` as the transport boundary
 * and never assume the handler's in-memory session map persists for the server's lifetime.
 */
export interface ServeOptions<
  Route = unknown,
  Admin = unknown,
  StorageRt = unknown,
  Deploy = unknown,
  Fleet = unknown,
> {
  port: number;
  ip: string;
  webDir?: string;
  admin?: { api: Admin; key: string };
  /**
   * The dashboard SPA. Two variants:
   *  - `dev`/`serve`: `{ distDir, html }` — dist dir (hashed Vite assets) + key-injected index.html.
   *  - a compiled `stackbase build` binary: `{ assets, html }` — a urlPath→embedded-path map.
   */
  dashboard?: { distDir: string; html: string } | { assets: Record<string, string>; html: string };
  /** The app's `http.ts` routes, resolved to `path:name` function paths for dispatch. */
  routes?: Route[];
  /** Engine-owned `/api/storage/*` handlers (always-on file storage). Reserved — matched before
   *  user routes; stable across reload/deploy. */
  storageRoutes?: StorageRt[];
  /** Reserved routes contributed by composed components (e.g. auth's OAuth callbacks). Matched
   *  after storage routes, before user routes. Engine-owned `{method,pathPrefix,handler}` closures.
   *  Shares the `StorageRt` shape (`{method,pathPrefix,handler}`) — the CLI pins both to `StorageRoute`. */
  componentRoutes?: StorageRt[];
  /** `POST /_admin/deploy` handler — present only when the server was started with deploy enabled. */
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<Deploy> };
  /** Fleet node handle — present only under `serve --fleet`. Absent → byte-for-byte non-fleet. */
  fleet?: Fleet;
  /** Present only when THIS node is a `--replica` configured with `--writer-url` — arms `/api/run`'s
   *  single-hop defensive guard. Absent → byte-for-byte unchanged behavior. */
  replicaWriterUrl?: string;
}

/**
 * The seam. A host binds an `EmbeddedRuntime` to a transport and starts serving; the returned
 * {@link ServerHandle} is the whole post-serve lifecycle surface. Slice 1 ships one implementation
 * (`@stackbase/cli`'s `ProcessRuntimeHost`); a Durable Object host (Slice 3) implements the same
 * method, wiring Worker `fetch` → the engine's HTTP dispatch and `WebSocketPair`/hibernation →
 * `runtime.handler.connect`. `serve()` is called once per host instance (one call per process, or
 * one per DO incarnation) — it must not assume it is the only call in a process's lifetime.
 */
export interface RuntimeHost<
  Route = unknown,
  Admin = unknown,
  StorageRt = unknown,
  Deploy = unknown,
  Fleet = unknown,
> {
  serve(
    runtime: EmbeddedRuntime,
    options: ServeOptions<Route, Admin, StorageRt, Deploy, Fleet>,
  ): Promise<ServerHandle<Route>>;
}
