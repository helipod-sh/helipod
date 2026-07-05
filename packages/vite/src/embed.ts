/**
 * Phase 2 — in-process embed. Boot the Helipod engine INSIDE Vite's own dev-server process (no
 * child `helipod dev`, no proxy hop) and serve it as connect-middleware + a `/api/sync` WebSocket
 * on Vite's own origin. Opt-in via `helipod({ mode: "embed" })`; the default proxy mode
 * (`index.ts`) is untouched.
 *
 * The engine boot, HTTP dispatch, codegen, and sync wiring are all REUSED from `@helipod/cli`
 * (reached via a dynamic import so proxy-mode users never pull it — see the design note,
 * `docs/superpowers/specs/2026-05-15-vite-phase2-embed-design.md`). What's Vite-shaped and lives here:
 * the connect `req`/`res` ↔ engine `HttpRequest`/`HttpResponse` translation, the storage/component
 * route prefix-match, and the `/api/sync`-only upgrade listener that COEXISTS with Vite's HMR ws.
 */
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Plugin } from "vite";
import type { HelipodVitePluginOptions } from "./index";

const SYNC_PATH = "/api/sync";
const STORAGE_PREFIX = "/api/storage/";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Engine-owned URL prefixes served in-process; everything else falls through to `next()` (Vite). */
const ENGINE_PREFIXES = ["/api", "/_admin", "/_dashboard"];

function isEnginePath(path: string): boolean {
  return ENGINE_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));
}

function methodHasBody(method: string | undefined): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

/** Read the raw request body as bytes, capped. Binary-safe (storage uploads may be arbitrary bytes). */
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

/** A minimal `{ method, pathPrefix, handler }` engine route (storage or component). */
interface EngineRoute {
  method: string;
  pathPrefix: string;
  handler: (request: Request) => Response | Promise<Response>;
}

function matchStorageRoute(routes: EngineRoute[], method: string, path: string): EngineRoute | undefined {
  if (!path.startsWith(STORAGE_PREFIX)) return undefined;
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}
function matchComponentRoute(routes: EngineRoute[], method: string, path: string): EngineRoute | undefined {
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}

/** Stream a native `Response` (storage/component route) back through the connect `res`. */
async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => { outHeaders[k] = v; });
  res.writeHead(response.status, outHeaders);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * The `embed` mode plugin. Only a `configureServer` hook — no `config` proxy (the engine is served
 * in-process, so there is no second origin to proxy to).
 */
export function embedPlugin(options: HelipodVitePluginOptions): Plugin {
  return {
    name: "helipod:embed",
    async configureServer(server) {
      const log = server.config.logger;
      const root = server.config.root;

      // Reach the CLI's shared boot core ONLY here, via a dynamic import — proxy mode never pulls it
      // (also where DEFAULT_FUNCTIONS_DIR comes from: a static top-level import of `@helipod/cli`
      // would defeat the point, forcing it to resolve even for proxy-mode-only consumers who never
      // installed it — it's an optional peer, see package.json).
      let cli: typeof import("@helipod/cli");
      try {
        cli = await import("@helipod/cli");
      } catch (e) {
        throw new Error(
          `@helipod/vite embed mode requires @helipod/cli to be installed — ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const {
        bootProject,
        writeGenerated,
        handleHttpRequest,
        push,
        loadFunctionsDir,
        loadConfig,
        withStorageModules,
        DEFAULT_FUNCTIONS_DIR,
      } = cli;

      const functionsDir = resolve(root, options.functionsDir ?? DEFAULT_FUNCTIONS_DIR);
      const generatedDir = join(functionsDir, "_generated");
      const dataPath = options.dataPath ? resolve(root, options.dataPath) : join(root, ".helipod", "dev.db");
      const adminKey = options.adminKey ?? randomBytes(24).toString("hex");

      const boot = await bootProject({
        functionsDir,
        dataPath,
        ...(options.databaseUrl !== undefined ? { databaseUrl: options.databaseUrl } : {}),
        adminKey,
      });
      const { runtime, adminApi, project, generated, store, storageRoutes, componentRoutes } = boot;
      writeGenerated(generated.files, generatedDir);
      const config = await loadConfig(dirname(functionsDir));

      // Mutable across hot-reloads: only the user `http.ts` routes swap (the component set — and thus
      // storage/component routes — is fixed at boot, exactly as `helipod dev`/`serve` behave).
      let currentRoutes = project.routes;

      // ── HTTP: engine paths in-process, everything else to Vite ────────────────────────────────
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const rawUrl = req.url ?? "/";
        const path = rawUrl.split("?")[0] ?? "/";
        if (!isEnginePath(path)) return next();
        void (async () => {
          try {
            const method = req.method ?? "GET";
            const url = new URL(rawUrl, "http://x");
            const query: Record<string, string> = {};
            url.searchParams.forEach((val, key) => { query[key] = val; });
            const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
            const headers = Object.fromEntries(
              Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === "string"),
            );
            const isStorage = path.startsWith(STORAGE_PREFIX);
            const needsBody = methodHasBody(method);
            const bodyBytes = needsBody ? await readBodyBytes(req) : undefined;

            // Storage routes (binary-safe body) → native Request/Response.
            const storageRoute = matchStorageRoute(storageRoutes, method, path);
            if (storageRoute) {
              const h = new Headers(headers);
              if (authorization && !h.has("authorization")) h.set("authorization", authorization);
              const request = new Request(`http://${h.get("host") ?? "localhost"}${rawUrl}`, {
                method,
                headers: h,
                ...(bodyBytes !== undefined ? { body: new Uint8Array(bodyBytes) } : {}),
              });
              await writeResponse(res, await storageRoute.handler(request));
              return;
            }
            // Component-contributed routes (e.g. auth's OAuth callbacks) → native Request/Response.
            const componentRoute = matchComponentRoute(componentRoutes, method, path);
            if (componentRoute) {
              const h = new Headers(headers);
              if (authorization && !h.has("authorization")) h.set("authorization", authorization);
              const request = new Request(`http://${h.get("host") ?? "localhost"}${rawUrl}`, {
                method,
                headers: h,
                ...(!isStorage && bodyBytes !== undefined ? { body: bodyBytes.toString("utf8") } : {}),
              });
              await writeResponse(res, await componentRoute.handler(request));
              return;
            }
            // The pure dispatcher (health, /api/run, /_admin/*, /_dashboard status page).
            const body = !isStorage && bodyBytes !== undefined ? bodyBytes.toString("utf8") : undefined;
            const info = { functions: runtime.functionPaths(), tables: runtime.tableNames() };
            const response = await handleHttpRequest(
              runtime,
              { method, path, body, query, authorization, headers },
              info,
              { api: adminApi, key: adminKey },
              currentRoutes,
            );
            res.writeHead(response.status, response.headers);
            res.end(response.body);
          } catch (e) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
          }
        })();
      });

      // ── WebSocket: /api/sync only, COEXISTING with Vite's HMR ws on the same httpServer ───────
      // Node emits 'upgrade' to EVERY listener. Vite's HMR listener handles only `vite-hmr`/`vite-ping`
      // upgrades at the HMR base and never touches foreign sockets; ours handles ONLY `/api/sync` and
      // likewise never destroys a socket it doesn't own — so the two listeners coexist. (This is the
      // one deliberate divergence from `server.ts`'s Node backend, which owns the whole server and so
      // destroys non-sync upgrades. See the design note's coexistence section.)
      const { WebSocketServer } = await import("ws");
      const wss = new WebSocketServer({ noServer: true });
      let sessionCounter = 0;
      const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if ((req.url ?? "").split("?")[0] !== SYNC_PATH) return; // NOT ours — leave it for Vite's HMR listener.
        wss.handleUpgrade(req, socket, head, (ws) => {
          const sessionId = `vite-embed-ws-${++sessionCounter}`;
          const syncSocket = {
            send: (data: string) => ws.send(data),
            get bufferedAmount() { return ws.bufferedAmount; },
            close: () => ws.close(),
            ping: (onPong: () => void) => { ws.once("pong", onPong); ws.ping(); },
          };
          runtime.handler.connect(sessionId, syncSocket);
          ws.on("message", (data: Buffer) => void runtime.handler.handleMessage(sessionId, data.toString("utf8")));
          ws.on("close", () => runtime.handler.disconnect(sessionId));
          ws.on("error", () => runtime.handler.disconnect(sessionId));
        });
      };
      // Under `server.middlewareMode` (SSR hosts) Vite exposes no `httpServer`, so the sync WS can't
      // attach and `stop()` (below) would never run — the engine + store would leak silently. Fail
      // LOUD instead: warn so the operator knows the reactive socket is inert in this configuration.
      if (!server.httpServer) {
        server.config.logger.warn(
          "[helipod] embed mode needs Vite's own HTTP server — under `server.middlewareMode` the reactive /api/sync WebSocket and engine cleanup do NOT wire up. Use proxy mode, or run Vite without middlewareMode.",
        );
      }
      server.httpServer?.on("upgrade", onUpgrade);

      // ── Hot-reload the functions dir — an INDEPENDENT loop from Vite HMR ─────────────────────────
      let reloadTimer: ReturnType<typeof setTimeout> | undefined;
      const scheduleReload = (file: string) => {
        if (!file.startsWith(functionsDir + sep)) return;
        if (file.includes(sep + "_generated" + sep)) return;
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { void reload(); }, 50);
      };
      const reload = async () => {
        try {
          const next = push(await loadFunctionsDir(functionsDir), config.components);
          writeGenerated(next.generated.files, generatedDir);
          runtime.setModules(withStorageModules(next.project.moduleMap));
          currentRoutes = next.project.routes;
          log.info(`[helipod] ↻ pushed (${Object.keys(next.project.moduleMap).length} functions)`);
        } catch (e) {
          log.error(`[helipod] ✗ reload failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      };
      server.watcher.on("add", scheduleReload);
      server.watcher.on("change", scheduleReload);
      server.watcher.on("unlink", scheduleReload);

      // ── Cleanup on Vite shutdown (idempotent) ──────────────────────────────────────────────────
      let stopped = false;
      const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (reloadTimer) clearTimeout(reloadTimer);
        server.httpServer?.off("upgrade", onUpgrade);
        for (const client of wss.clients) client.terminate();
        wss.close();
        // Stop drivers BEFORE the store closes (a driver timer must never fire against a closed store —
        // the same ordering `server.ts`'s close() enforces), then release any object-store lease.
        await runtime.stopDrivers();
        if (boot.objectStoreRelease) await boot.objectStoreRelease();
        await store.close();
      };
      server.httpServer?.once("close", () => void stop());

      log.info(`[helipod] embed → engine in-process on Vite's origin (admin key: ${adminKey})`);
    },
  };
}

// Re-exported for tests: the pure engine-path predicate.
export { isEnginePath };
