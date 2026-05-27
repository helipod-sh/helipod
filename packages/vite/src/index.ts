export { freePort } from "./free-port";
export { resolveCli, buildDevArgs, type ResolvedCli } from "./resolve-cli";
export { probePort, startBackend, installSignalCleanup } from "./child";
export type { SpawnFn, ProbeFn, Backend, SpawnedChild, StartBackendOptions, CleanupProc } from "./child";

import { spawn as nodeChildSpawn } from "node:child_process";
import type { Plugin } from "vite";
import { freePort } from "./free-port";
import { resolveCli, buildDevArgs } from "./resolve-cli";
import { startBackend, probePort, installSignalCleanup, type SpawnFn, type Backend } from "./child";

export interface StackbaseVitePluginOptions {
  /** App functions dir → `--dir` (default "convex"). */
  convexDir?: string;
  /** Backend port to proxy to (default: an OS-assigned free port). */
  port?: number;
  /** How to invoke the CLI (default: local node_modules/.bin/stackbase, else `npx stackbase`). */
  command?: string;
  /** Extra flags forwarded to `stackbase dev` (e.g. ["--database-url", "postgres://…"]). */
  args?: string[];
}

/** Adapt node's `spawn` to the SpawnFn seam. */
const nodeSpawn: SpawnFn = (command, args, opts) =>
  nodeChildSpawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Single-origin dev: spawn `stackbase dev` and proxy the engine-owned prefixes to it, so `vite` alone
 * serves the frontend AND backend on one browser origin (no manual proxy, no CORS).
 */
export function stackbase(options: StackbaseVitePluginOptions = {}): Plugin {
  let port: number;
  let backend: Backend | undefined;
  return {
    name: "stackbase",
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
      const args = buildDevArgs(cli.baseArgs, port, options.convexDir ?? "convex", options.args ?? []);
      backend = await startBackend(
        { command: cli.command, args, cwd: root, port, onLog: (l) => server.config.logger.info(`[stackbase] ${l}`) },
        { spawn: nodeSpawn, probe: probePort },
      );
      const stop = () => backend?.stop();
      server.httpServer?.once("close", stop);
      installSignalCleanup(stop);
    },
  };
}
