import { describe, it, expect, afterAll } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { WebSocket } from "ws";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stackbase, freePort } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "fixture");
// Spawn the built CLI directly (deterministic in-repo) rather than relying on a resolved bin.
const cliBin = join(here, "..", "..", "cli", "dist", "bin.js");
// Run the child through `bun`, not `process.execPath` — under `bun run --filter @stackbase/vite
// test:e2e`, vitest itself runs under plain Node (see "Tests run under Node" project convention),
// but `stackbase dev`'s codegen emits extensionless relative imports (`./_generated/server`,
// matching Convex's own convention) that only Bun's/bundler-style module resolution can follow;
// plain Node's ESM resolver has no automatic extension search for relative specifiers and 404s.
// Bun is this project's documented primary runtime for `stackbase dev` (see CLAUDE.md), so this
// spawns the CLI the way a real Bun+Vite project actually would.
const cliRunner = "bun";

describe("@stackbase/vite — single-origin dev (real Vite + real stackbase dev)", () => {
  let vite: ViteDevServer | undefined;
  afterAll(async () => { await vite?.close(); });

  it("proxies /api/health (200) and /api/sync (ws upgrade) through Vite to the engine", async () => {
    // `server.port: 0` is NOT an OS-assigned-port request to Vite (it falls back to the 5173
    // default, same as leaving `port` unset) — resolve our own free port up front instead, the
    // same free-port seam the plugin itself uses to pick the backend's port.
    const vitePort = await freePort();
    vite = await createViteServer({
      root: fixtureRoot,
      logLevel: "warn",
      // Explicit IPv4 host: Vite's default `localhost` binding can resolve to the IPv6 loopback
      // (`::1`) only, which would refuse the IPv4 `127.0.0.1` connections below.
      server: { port: vitePort, strictPort: true, host: "127.0.0.1" },
      plugins: [stackbase({ functionsDir: "stackbase", command: `${cliRunner} ${cliBin}` })],
    });
    await vite.listen();
    const address = vite.httpServer!.address();
    expect(typeof address === "object" && address ? address.port : 0).toBe(vitePort);

    // Proof 1: HTTP /api/health proxies to the engine and returns 200.
    const res = await fetch(`http://127.0.0.1:${vitePort}/api/health`);
    expect(res.status).toBe(200);

    // Proof 2: the /api/sync WebSocket upgrade proxies (ws:true) and connects.
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${vitePort}/api/sync`);
      const t = setTimeout(() => { ws.close(); reject(new Error("ws did not open")); }, 10_000);
      ws.on("open", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
  }, 60_000);
});
