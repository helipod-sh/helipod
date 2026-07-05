export { freePort } from "./free-port";
export { resolveCli, buildDevArgs, type ResolvedCli } from "./resolve-cli";
export { probePort, startBackend, installSignalCleanup } from "./child";
export type { SpawnFn, ProbeFn, Backend, SpawnedChild, StartBackendOptions, CleanupProc } from "./child";
export { embedPlugin } from "./embed";

import { spawn as nodeChildSpawn } from "node:child_process";
import type { Plugin } from "vite";
import { freePort } from "./free-port";
import { resolveCli, buildDevArgs } from "./resolve-cli";
import { startBackend, probePort, installSignalCleanup, type SpawnFn, type Backend } from "./child";
import { embedPlugin } from "./embed";

// Mirrors `DEFAULT_FUNCTIONS_DIR` from `@helipod/cli` (`packages/cli/src/functions-dir.ts`).
// NOT imported: `@helipod/cli` is an optional peer dependency (see package.json) so that
// proxy-mode-only consumers — who spawn `helipod dev` as a child process and never touch the
// package's own JS — aren't forced to have it installed. embed.ts reaches the real constant
// through its own dynamic import instead, for the same reason. Exported (not just module-local) so
// a test can assert this literal hasn't drifted from `@helipod/cli`'s own constant — see
// `test/plugin.test.ts`'s "DEFAULT_FUNCTIONS_DIR guard" — without a static top-level import of
// `@helipod/cli` here in the shipped proxy path itself.
export const DEFAULT_FUNCTIONS_DIR = "helipod";

export interface HelipodVitePluginOptions {
  /**
   * How the backend is run alongside Vite:
   *   - `"proxy"` (default): spawn `helipod dev` as a child and proxy the engine-owned prefixes to
   *     it (Phase 1 — unchanged). Node builtins only; no `@helipod/*` runtime dependency.
   *   - `"embed"`: boot the engine INSIDE Vite's own process as connect-middleware + a `/api/sync`
   *     WebSocket — no child, no proxy hop (Phase 2). Reaches `@helipod/cli` via a dynamic import,
   *     so proxy-mode users never pull it. See `docs/superpowers/specs/2026-05-15-vite-phase2-embed-design.md`.
   */
  mode?: "proxy" | "embed";
  /** App functions dir → `--dir` (default "helipod"). Shared by both modes. */
  functionsDir?: string;

  // ── proxy mode ──────────────────────────────────────────────────────────────────────────────
  /** Backend port to proxy to (default: an OS-assigned free port). */
  port?: number;
  /** How to invoke the CLI (default: local node_modules/.bin/helipod, else `npx helipod`). */
  command?: string;
  /** Extra flags forwarded to `helipod dev` (e.g. ["--database-url", "postgres://…"]). */
  args?: string[];

  // ── embed mode ──────────────────────────────────────────────────────────────────────────────
  /** SQLite file for the in-process engine (default `<root>/.helipod/dev.db`). Ignored in proxy mode. */
  dataPath?: string;
  /** Postgres connection string for the in-process engine (opt-in; SQLite otherwise). Ignored in proxy mode. */
  databaseUrl?: string;
  /** Admin key for the in-process engine's `/_admin` API (default: a per-run ephemeral key). Ignored in proxy mode. */
  adminKey?: string;
}

/** Adapt node's `spawn` to the SpawnFn seam. */
const nodeSpawn: SpawnFn = (command, args, opts) =>
  nodeChildSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Single-origin dev: `vite` alone serves the frontend AND the Helipod backend on one browser origin
 * (no manual proxy, no CORS). Two modes behind one surface (default `"proxy"` — Phase 1, unchanged):
 *   - `"proxy"`: spawn `helipod dev` and proxy the engine-owned prefixes to it.
 *   - `"embed"`: boot the engine in Vite's own process (no child, no proxy hop).
 */
export function helipod(options: HelipodVitePluginOptions = {}): Plugin {
  if ((options.mode ?? "proxy") === "embed") return embedPlugin(options);
  return proxyPlugin(options);
}

/** Phase 1 (default): spawn `helipod dev` as a child and inject Vite's proxy. Byte-for-byte the
 *  behavior that shipped in Phase 1 — the only change is that it's now reached via the mode switch. */
function proxyPlugin(options: HelipodVitePluginOptions): Plugin {
  let port: number;
  let backend: Backend | undefined;
  return {
    name: "helipod",
    async config() {
      port = options.port ?? (await freePort());
      const target = `http://127.0.0.1:${port}`;
      return {
        server: {
          proxy: {
            "/api": { target, ws: true, changeOrigin: true },
            "/_dashboard": { target, changeOrigin: true },
            "/_admin": { target, changeOrigin: true },
          },
        },
      };
    },
    async configureServer(server) {
      const root = server.config.root;
      const cli = resolveCli(root, options.command);
      const args = buildDevArgs(cli.baseArgs, port, options.functionsDir ?? DEFAULT_FUNCTIONS_DIR, options.args ?? []);
      backend = await startBackend(
        { command: cli.command, args, cwd: root, port, onLog: (l) => server.config.logger.info(`[helipod] ${l}`) },
        { spawn: nodeSpawn, probe: probePort },
      );
      const stop = () => backend?.stop();
      server.httpServer?.once("close", stop);
      installSignalCleanup(stop);
    },
  };
}
