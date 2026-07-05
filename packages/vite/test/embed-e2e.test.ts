import { describe, it, expect, afterAll } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket } from "ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { helipod, freePort } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixture");

/** Resolve when a WebSocket opens; reject on error/timeout. `protocol` lets the caller impersonate a
 *  Vite HMR client (`vite-hmr`) to prove the two upgrade listeners coexist on the same httpServer. */
function connectWs(url: string, protocol?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = protocol ? new WebSocket(url, protocol) : new WebSocket(url);
    const t = setTimeout(() => { ws.close(); reject(new Error(`ws did not open: ${url} (${protocol ?? "no-proto"})`)); }, 10_000);
    ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
    ws.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

describe("@helipod/vite — embed mode (engine IN Vite's process, no child, no proxy)", () => {
  let vite: ViteDevServer | undefined;
  afterAll(async () => { await vite?.close(); });

  it("serves /api/health (200, in-process) and /api/sync ws, coexisting with Vite's HMR ws", async () => {
    const vitePort = await freePort();
    const dataDir = mkdtempSync(join(tmpdir(), "sb-vite-embed-"));
    vite = await createViteServer({
      root: fixtureRoot,
      logLevel: "warn",
      // Explicit IPv4 host (Vite's default `localhost` can bind IPv6-only, refusing the 127.0.0.1 below).
      server: { port: vitePort, strictPort: true, host: "127.0.0.1" },
      plugins: [helipod({ mode: "embed", functionsDir: "helipod", dataPath: join(dataDir, "dev.db") })],
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    expect(typeof address === "object" && address ? address.port : 0).toBe(vitePort);

    // Proof 1: /api/health is served BY THE IN-PROCESS ENGINE (no child, no proxy) → 200.
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/health`);
    expect(res.status).toBe(200);

    // Proof 2: the /api/sync reactive WebSocket connects (our upgrade listener).
    await connectWs(`ws://127.0.0.1:${vitePort}/api/sync`);

    // Proof 3 (coexistence — the sharp edge): Vite's OWN HMR WebSocket still connects on the same
    // origin/httpServer, using the `vite-hmr` subprotocol at the HMR base path. Our /api/sync listener
    // must have left that upgrade untouched for Vite's listener to handle.
    await connectWs(`ws://127.0.0.1:${vitePort}/`, "vite-hmr");
  }, 60_000);
});
