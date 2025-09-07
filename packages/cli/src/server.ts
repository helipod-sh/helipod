/**
 * The dev HTTP + WebSocket server. Two backends behind one interface:
 *   - **Bun** (primary): `Bun.serve` with native (Zig/uWebSockets-class) WebSockets — far higher
 *     connection density; the production path. See docs/dev/architecture/scaling-reality.md.
 *   - **Node** (supported): `node:http` + the `ws` package.
 * The HTTP routing ({@link handleHttpRequest}) and static-file resolution are shared and pure.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { SyncWebSocket } from "@stackbase/sync";
import type { AdminApi } from "@stackbase/admin";
import type { StorageRoute } from "@stackbase/storage";
import { handleHttpRequest, type ServerInfo, type FleetHandles } from "./http-handler";
import type { ResolvedRoute } from "./project";
import type { DeployResult } from "./deploy-apply";
import { detectRuntime } from "./dev-options";

const SYNC_PATH = "/api/sync";
const STORAGE_PREFIX = "/api/storage/";
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Match an engine-owned `/api/storage/*` request (upload/confirm/serve). These are RESERVED paths
 * spliced into dispatch ahead of user `http.ts` routes and the 404 — the upload/confirm handlers
 * key off method (POST) so a GET `/api/storage/<id>` falls through to the serve handler.
 */
function matchStorageRoute(routes: StorageRoute[] | undefined, method: string, path: string): StorageRoute | undefined {
  if (!routes || !path.startsWith(STORAGE_PREFIX)) return undefined;
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}

/** Methods that carry a request body the server must read (PATCH is used by the admin API). */
export function hasBody(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export interface DevServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Replace the httpAction route table, e.g. after a hot reload re-resolves `http.ts`. */
  setRoutes(routes: ResolvedRoute[]): void;
}

export interface DevServerOptions {
  port: number;
  ip: string;
  webDir?: string;
  admin?: { api: AdminApi; key: string };
  /**
   * The dashboard SPA. Two variants:
   *  - `dev`/`serve`: `{ distDir, html }` — dist dir (hashed Vite assets) + key-injected index.html,
   *    served under `/_dashboard*` via `resolveStatic`.
   *  - a compiled `stackbase build` binary: `{ assets, html }` — a urlPath→embedded-`$bunfs`-path
   *    map (see `binary-main.ts`'s `EmbeddedDashboard`), served at the site root via `Bun.file`.
   */
  dashboard?: { distDir: string; html: string } | { assets: Record<string, string>; html: string };
  /** The app's `http.ts` routes, resolved to `path:name` function paths for dispatch. */
  routes?: ResolvedRoute[];
  /** Engine-owned `/api/storage/*` handlers (always-on file storage). Reserved — matched before
   *  user routes; stable across reload/deploy (their deps read the never-swapped systemModules). */
  storageRoutes?: StorageRoute[];
  /** `POST /_admin/deploy` handler — present only when the server was started with deploy enabled. */
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> };
  /** Fleet node handle — present only under `serve --fleet`. Enables `/_fleet/run` and the sync-role
   *  httpAction proxy. Absent → byte-for-byte the non-fleet behavior. */
  fleet?: FleetHandles;
}

/** Content-type for an embedded dashboard asset, derived from its extension. */
const EMBEDDED_CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
};

/** Minimal structural surface of `Bun.file(path)`, reached only inside a compiled binary. */
interface BunFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}
interface BunFileRuntime {
  file(path: string): BunFileLike;
}

/**
 * Serve the dashboard SPA, or null (falls through to a 404).
 *  - `distDir` variant (`dev`/`serve`): unchanged — served under `/_dashboard*`, assets from dist.
 *  - `assets` variant (compiled binary): served at the site root — `/` and `/index.html` return the
 *    embedded `html`; any other path is looked up in the urlPath→embedded-path map and read via
 *    `Bun.file` (only reachable here, inside a compiled Bun binary — dev/serve never pass this variant).
 */
async function serveDashboard(
  path: string,
  d: { distDir: string; html: string } | { assets: Record<string, string>; html: string },
): Promise<{ contentType: string; body: string | Buffer | Uint8Array } | null> {
  if ("distDir" in d) {
    if (path === "/_dashboard" || path === "/_dashboard/" || path === "/_dashboard/index.html")
      return { contentType: "text/html; charset=utf-8", body: d.html };
    if (path.startsWith("/_dashboard/")) {
      return resolveStatic(d.distDir, path.slice("/_dashboard".length));
    }
    return null;
  }
  if (path === "/" || path === "/index.html") return { contentType: "text/html", body: d.html };
  // The dashboard's `index.html` is built with vite `base: "/_dashboard/"` (the dev/serve mount
  // point), so its <script>/<link> tags reference `/_dashboard/assets/...` even though the embedded
  // asset map's keys are root-relative (`/assets/...`). Fall back to the un-prefixed key so those
  // requests still resolve when the dashboard is served at the site root.
  const embeddedPath = d.assets[path] ?? (path.startsWith("/_dashboard/") ? d.assets[path.slice("/_dashboard".length)] : undefined);
  if (!embeddedPath) return null;
  const bun = (globalThis as { Bun?: BunFileRuntime }).Bun;
  if (!bun) return null; // unreachable outside a compiled Bun binary
  const body = new Uint8Array(await bun.file(embeddedPath).arrayBuffer());
  return { contentType: EMBEDDED_CONTENT_TYPES[extname(embeddedPath)] ?? "application/octet-stream", body };
}

/** Resolve a static file from `webDir` (with `/` → index.html), guarding against traversal. Pure. */
function resolveStatic(webDir: string, urlPath: string): { contentType: string; body: Buffer } | null {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  let root: string;
  let resolved: string;
  try {
    // realpath resolves symlinks too, so neither `..` nor a symlink can escape the web root.
    root = realpathSync(resolve(webDir));
    resolved = realpathSync(resolve(join(webDir, rel)));
  } catch {
    return null;
  }
  // Require the resolved path to be the root itself or strictly underneath it (`root + sep`).
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  if (!statSync(resolved).isFile()) return null;
  return { contentType: CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream", body: readFileSync(resolved) };
}

/* -------------------------------------------------------------------------- */
/* Node backend (node:http + ws)                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read the raw request body as bytes (a `Buffer`), with no text decoding. This is the ONLY
 * body-reading path that is safe for the engine-owned `/api/storage/*` uploads: an upload body may
 * be arbitrary binary (PNG, PDF, ...), and `handleUpload` reconstructs the exact bytes via
 * `new Uint8Array(await request.arrayBuffer())`. Round-tripping through a decoded/re-encoded utf8
 * string (as {@link readBody} does) would mangle any non-UTF8 byte sequence — see the Task 10
 * fixes report.
 */
function readBodyBytes(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Text variant of {@link readBodyBytes} for routes that treat the body as utf8 text/JSON (`/api/run`,
 * the admin doc-edit `PATCH`, `httpAction`s, ...). Do NOT use this for the storage upload routes —
 * decoding-then-re-encoding a binary body as utf8 is lossy for non-UTF8 byte sequences.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return readBodyBytes(req).then((b) => b.toString("utf8"));
}

async function startNodeServer(runtime: EmbeddedRuntime, options: DevServerOptions): Promise<DevServer> {
  const { WebSocketServer } = (await import("ws")) as typeof import("ws");
  let currentRoutes = options.routes ?? [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const rawUrl = req.url ?? "/";
        const url = new URL(rawUrl, "http://x");
        const path = url.pathname;
        const needsBody = hasBody(req.method);
        // Storage routes get the raw bytes (binary-safe); every other route keeps the existing
        // utf8-decoded string body. The two are mutually exclusive reads of the same stream.
        const isStorageRequest = path.startsWith(STORAGE_PREFIX);
        const bodyBytes = needsBody && isStorageRequest ? await readBodyBytes(req) : undefined;
        const body = needsBody && !isStorageRequest ? await readBody(req) : undefined;
        const query: Record<string, string> = {};
        url.searchParams.forEach((val, key) => { query[key] = val; });
        const authorization = req.headers.authorization ?? undefined;
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
        );
        if ((req.method ?? "GET") === "GET" && options.dashboard) {
          const dash = await serveDashboard(path, options.dashboard);
          if (dash) {
            res.writeHead(200, { "content-type": dash.contentType });
            res.end(dash.body);
            return;
          }
        }
        // Engine-owned `/api/storage/*` — dispatch to the native Web handler and stream its Response
        // (bytes, 302 redirects, 206 partials) back through node:http verbatim.
        const storageRoute = matchStorageRoute(options.storageRoutes, req.method ?? "GET", path);
        if (storageRoute) {
          const storageHeaders = new Headers(headers);
          if (authorization && !storageHeaders.has("authorization")) storageHeaders.set("authorization", authorization);
          const request = new Request(`http://${storageHeaders.get("host") ?? "localhost"}${rawUrl}`, {
            method: req.method ?? "GET",
            headers: storageHeaders,
            // Raw bytes, NOT the utf8-decoded `body` string — see `readBodyBytes`'s doc comment.
            // (Copied into a plain `Uint8Array<ArrayBuffer>` — `Buffer`'s `.buffer` is typed
            // `ArrayBufferLike`, which doesn't structurally satisfy DOM lib's `BodyInit`.)
            ...(needsBody && bodyBytes !== undefined ? { body: new Uint8Array(bodyBytes) } : {}),
          });
          const response = await storageRoute.handler(request);
          const outHeaders: Record<string, string> = {};
          response.headers.forEach((v, k) => { outHeaders[k] = v; });
          res.writeHead(response.status, outHeaders);
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        // Derive server info live per request from the runtime — a boot-time snapshot goes stale
        // after the first setModules hot-swap (dev reload / deploy).
        const info: ServerInfo = { functions: runtime.functionPaths(), tables: runtime.tableNames() };
        const response = await handleHttpRequest(
          runtime,
          { method: req.method ?? "GET", path, body, query, authorization, headers },
          info,
          options.admin,
          currentRoutes,
          options.deploy,
          options.fleet,
        );
        if (response.status === 404 && (req.method ?? "GET") === "GET" && options.webDir) {
          const file = resolveStatic(options.webDir, path);
          if (file) {
            res.writeHead(200, { "content-type": file.contentType });
            res.end(file.body);
            return;
          }
        }
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });
  let sessionCounter = 0;
  server.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").split("?")[0] !== SYNC_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const sessionId = `ws-${++sessionCounter}`;
      const syncSocket: SyncWebSocket = {
        send: (data) => ws.send(data),
        get bufferedAmount() {
          return ws.bufferedAmount;
        },
        close: () => ws.close(),
      };
      runtime.handler.connect(sessionId, syncSocket);
      ws.on("message", (data: Buffer) => void runtime.handler.handleMessage(sessionId, data.toString("utf8")));
      ws.on("close", () => runtime.handler.disconnect(sessionId));
      ws.on("error", () => runtime.handler.disconnect(sessionId));
    });
  });

  await new Promise<void>((res) => server.listen(options.port, options.ip, res));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  return {
    url: `http://${options.ip}:${port}`,
    port,
    setRoutes: (r) => { currentRoutes = r; },
    close: async () => {
      // Stop component drivers (scheduler event loop, storage orphan-reaper, …) BEFORE tearing the
      // store down, so a driver's wall-clock timer can't fire a sweep against an already-closed
      // store (which surfaces as a "statement has been finalized" error out of the reaper). Reload
      // (dev watch / `deploy`) never calls close() — it uses setModules/setRoutes — so this only
      // runs on a genuine shutdown.
      await runtime.stopDrivers();
      await new Promise<void>((res) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => res());
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Bun backend (Bun.serve native WebSockets) — primary                        */
/* -------------------------------------------------------------------------- */

interface BunWebSocket {
  send(data: string): number;
  close(): void;
  getBufferedAmount(): number;
  readonly data: { sessionId: string };
}
interface BunUpgradeServer {
  upgrade(req: Request, options?: { data?: { sessionId: string } }): boolean;
}
interface BunServeHandle {
  port: number;
  stop(closeActiveConnections?: boolean): void;
}
interface BunServeOptions {
  port: number;
  hostname: string;
  maxRequestBodySize: number;
  fetch(req: Request, server: BunUpgradeServer): Response | undefined | Promise<Response | undefined>;
  websocket: {
    open(ws: BunWebSocket): void;
    message(ws: BunWebSocket, message: string | Uint8Array): void;
    close(ws: BunWebSocket): void;
  };
}
interface BunRuntime {
  serve(options: BunServeOptions): BunServeHandle;
}

async function startBunServer(runtime: EmbeddedRuntime, options: DevServerOptions): Promise<DevServer> {
  const bun = (globalThis as { Bun?: BunRuntime }).Bun;
  if (!bun) throw new Error("Bun runtime not available");
  let sessionCounter = 0;
  let currentRoutes = options.routes ?? [];

  const handle = bun.serve({
    port: options.port,
    hostname: options.ip,
    maxRequestBodySize: MAX_BODY_BYTES,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === SYNC_PATH) {
        const sessionId = `ws-${++sessionCounter}`;
        return server.upgrade(req, { data: { sessionId } }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (req.method === "GET" && options.dashboard) {
        const dash = await serveDashboard(path, options.dashboard);
        if (dash) {
          const body = typeof dash.body === "string" ? dash.body : new Uint8Array(dash.body);
          return new Response(body, { headers: { "content-type": dash.contentType } });
        }
      }
      // Engine-owned `/api/storage/*` — the native `Request` passes straight to the handler, whose
      // `Response` (streamed bytes / 302 / 206) is returned unchanged by Bun.serve.
      const storageRoute = matchStorageRoute(options.storageRoutes, req.method, path);
      if (storageRoute) return await storageRoute.handler(req);
      const body = hasBody(req.method) ? await req.text() : undefined;
      const query: Record<string, string> = {};
      url.searchParams.forEach((val, key) => { query[key] = val; });
      const authorization = req.headers.get("authorization") ?? undefined;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      // Derive server info live per request from the runtime — a boot-time snapshot goes stale
      // after the first setModules hot-swap (dev reload / deploy).
      const info: ServerInfo = { functions: runtime.functionPaths(), tables: runtime.tableNames() };
      const response = await handleHttpRequest(
        runtime,
        { method: req.method, path, body, query, authorization, headers },
        info,
        options.admin,
        currentRoutes,
        options.deploy,
        options.fleet,
      );
      if (response.status === 404 && req.method === "GET" && options.webDir) {
        const file = resolveStatic(options.webDir, path);
        if (file) return new Response(new Uint8Array(file.body), { headers: { "content-type": file.contentType } });
      }
      return new Response(response.body, { status: response.status, headers: response.headers });
    },
    websocket: {
      open(ws) {
        const syncSocket: SyncWebSocket = {
          send: (data) => void ws.send(data),
          get bufferedAmount() {
            return ws.getBufferedAmount();
          },
          close: () => ws.close(),
        };
        runtime.handler.connect(ws.data.sessionId, syncSocket);
      },
      message(ws, message) {
        void runtime.handler.handleMessage(ws.data.sessionId, typeof message === "string" ? message : new TextDecoder().decode(message));
      },
      close(ws) {
        runtime.handler.disconnect(ws.data.sessionId);
      },
    },
  });

  return {
    url: `http://${options.ip}:${handle.port}`,
    port: handle.port,
    setRoutes: (r) => { currentRoutes = r; },
    close: async () => {
      // See the Node backend's close(): stop drivers before the store goes away.
      await runtime.stopDrivers();
      handle.stop(true);
    },
  };
}

/** Start the dev server using the best backend for the current runtime. */
export function startDevServer(runtime: EmbeddedRuntime, options: DevServerOptions): Promise<DevServer> {
  return detectRuntime() === "bun" ? startBunServer(runtime, options) : startNodeServer(runtime, options);
}
