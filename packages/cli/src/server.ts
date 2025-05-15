/**
 * The dev HTTP server — a thin `node:http` shell around the pure {@link handleHttpRequest}.
 * Works on Node and Bun (both implement `node:http`).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { SyncWebSocket } from "@stackbase/sync";
import { handleHttpRequest, type ServerInfo } from "./http-handler";

const SYNC_PATH = "/api/sync";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Serve a static file from `webDir` (with `/` → index.html), guarding against traversal. */
function tryServeStatic(webDir: string, urlPath: string, res: ServerResponse): boolean {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const resolved = resolve(join(webDir, rel));
  const root = resolve(webDir);
  if (!resolved.startsWith(root) || !existsSync(resolved) || !statSync(resolved).isFile()) return false;
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(resolved)] ?? "application/octet-stream" });
  res.end(readFileSync(resolved));
  return true;
}

export interface DevServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startDevServer(
  runtime: EmbeddedRuntime,
  info: ServerInfo,
  options: { port: number; ip: string; webDir?: string },
): Promise<DevServer> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
        const url = req.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        const response = await handleHttpRequest(runtime, { method: req.method ?? "GET", path, body }, info);
        // Fall back to the static web UI (if configured) for unmatched GETs.
        if (response.status === 404 && (req.method ?? "GET") === "GET" && options.webDir) {
          if (tryServeStatic(options.webDir, path, res)) return;
        }
        res.writeHead(response.status, response.headers);
        res.end(response.body);
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    })();
  });

  // Reactive sync over WebSocket: each connection is a session bound to the engine's handler.
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
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port, options.ip, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;

  return {
    url: `http://${options.ip}:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
}
