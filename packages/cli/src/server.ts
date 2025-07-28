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
import { handleHttpRequest, type ServerInfo } from "./http-handler";
import type { ResolvedRoute } from "./project";
import type { DeployResult } from "./deploy-apply";
import { detectRuntime } from "./dev-options";

const SYNC_PATH = "/api/sync";
const MAX_BODY_BYTES = 5 * 1024 * 1024;

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
  /** The built dashboard SPA: the dist dir (hashed Vite assets) + key-injected index.html. */
  dashboard?: { distDir: string; html: string };
  /** The app's `http.ts` routes, resolved to `path:name` function paths for dispatch. */
  routes?: ResolvedRoute[];
  /** `POST /_admin/deploy` handler — present only when the server was started with deploy enabled. */
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> };
}

/** Serve the dashboard SPA for `/_dashboard*` (index.html key-injected, assets from dist), or null. */
function serveDashboard(path: string, d: { distDir: string; html: string }): { contentType: string; body: string | Buffer } | null {
  if (path === "/_dashboard" || path === "/_dashboard/" || path === "/_dashboard/index.html")
    return { contentType: "text/html; charset=utf-8", body: d.html };
  if (path.startsWith("/_dashboard/")) {
    return resolveStatic(d.distDir, path.slice("/_dashboard".length));
  }
  return null;
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

function readBody(req: IncomingMessage): Promise<string> {
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
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startNodeServer(runtime: EmbeddedRuntime, info: ServerInfo, options: DevServerOptions): Promise<DevServer> {
  const { WebSocketServer } = (await import("ws")) as typeof import("ws");
  let currentRoutes = options.routes ?? [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = hasBody(req.method) ? await readBody(req) : undefined;
        const rawUrl = req.url ?? "/";
        const url = new URL(rawUrl, "http://x");
        const path = url.pathname;
        const query: Record<string, string> = {};
        url.searchParams.forEach((val, key) => { query[key] = val; });
        const authorization = req.headers.authorization ?? undefined;
        const headers = Object.fromEntries(
          Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
        );
        if ((req.method ?? "GET") === "GET" && options.dashboard) {
          const dash = serveDashboard(path, options.dashboard);
          if (dash) {
            res.writeHead(200, { "content-type": dash.contentType });
            res.end(dash.body);
            return;
          }
        }
        const response = await handleHttpRequest(
          runtime,
          { method: req.method ?? "GET", path, body, query, authorization, headers },
          info,
          options.admin,
          currentRoutes,
          options.deploy,
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
    close: () =>
      new Promise<void>((res) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => res());
      }),
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

async function startBunServer(runtime: EmbeddedRuntime, info: ServerInfo, options: DevServerOptions): Promise<DevServer> {
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
        const dash = serveDashboard(path, options.dashboard);
        if (dash) {
          const body = typeof dash.body === "string" ? dash.body : new Uint8Array(dash.body);
          return new Response(body, { headers: { "content-type": dash.contentType } });
        }
      }
      const body = hasBody(req.method) ? await req.text() : undefined;
      const query: Record<string, string> = {};
      url.searchParams.forEach((val, key) => { query[key] = val; });
      const authorization = req.headers.get("authorization") ?? undefined;
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { headers[k] = v; });
      const response = await handleHttpRequest(
        runtime,
        { method: req.method, path, body, query, authorization, headers },
        info,
        options.admin,
        currentRoutes,
        options.deploy,
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
    close: () => {
      handle.stop(true);
      return Promise.resolve();
    },
  };
}

/** Start the dev server using the best backend for the current runtime. */
export function startDevServer(runtime: EmbeddedRuntime, info: ServerInfo, options: DevServerOptions): Promise<DevServer> {
  return detectRuntime() === "bun" ? startBunServer(runtime, info, options) : startNodeServer(runtime, info, options);
}
