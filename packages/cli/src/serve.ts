/**
 * `stackbase serve` — the production server. Unlike `dev`: requires a persistent admin key,
 * binds 0.0.0.0, never writes codegen (the mounted convex/ must already contain _generated/),
 * and shuts down gracefully on SIGTERM/SIGINT. Shares the boot core with dev via bootProject().
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DevServer } from "./server";
import { startDevServer } from "./server";
import { bootProject, loadDashboard } from "./boot";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";

export interface ServeOptions {
  convexDir: string;
  dataPath: string;
  ip: string;
  port: number;
  dashboard: boolean;
}

export function resolveServeOptions(args: string[]): ServeOptions {
  let convexDir = "convex";
  let dataPath = process.env.STACKBASE_DATA_DIR ? join(process.env.STACKBASE_DATA_DIR, "db.sqlite") : "./data/db.sqlite";
  let ip = "0.0.0.0";
  let port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let dashboard = process.env.STACKBASE_DASHBOARD?.trim().toLowerCase() !== "off";
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) convexDir = args[++i] as string;
    else if (a === "--data" && args[i + 1]) dataPath = args[++i] as string;
    else if (a === "--ip" && args[i + 1]) ip = args[++i] as string;
    else if (a === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (a === "--no-dashboard") dashboard = false;
  }
  return { convexDir, dataPath, ip, port, dashboard };
}

/** Testable core: boot + start the server. No signals, no exit, does not block. */
export async function startServe(
  opts: ServeOptions & { adminKey: string },
): Promise<{ server: DevServer; store: SqliteDocStore; runtime: EmbeddedRuntime }> {
  const { runtime, adminApi, project, store } = await bootProject({
    convexDir: opts.convexDir,
    dataPath: opts.dataPath,
    adminKey: opts.adminKey,
  });
  // No embedded key (0.0.0.0 bind): the dashboard SPA prompts the operator for the admin key.
  const dashboard = opts.dashboard ? loadDashboard(undefined) : undefined;
  const server = await startDevServer(
    runtime,
    { functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) },
    { port: opts.port, ip: opts.ip, admin: { api: adminApi, key: opts.adminKey }, dashboard, routes: project.routes },
  );
  return { server, store, runtime };
}

/** CLI wrapper: flags → fail-fast → startServe → signal handlers → run forever. */
export async function serveCommand(args: string[]): Promise<number> {
  const opts = resolveServeOptions(args);
  const adminKey = process.env.STACKBASE_ADMIN_KEY?.trim();
  if (!adminKey) {
    process.stderr.write("✗ STACKBASE_ADMIN_KEY is required for `serve` — set it to a strong secret.\n");
    return 1;
  }
  if (!existsSync(join(opts.convexDir, "_generated", "server.ts"))) {
    process.stderr.write(
      `✗ ${opts.convexDir}/_generated not found — run \`stackbase codegen --dir ${opts.convexDir}\` and commit _generated/ before deploying.\n`,
    );
    return 1;
  }
  const { server, store } = await startServe({ ...opts, adminKey });
  process.stdout.write(
    JSON.stringify({ level: "info", msg: "stackbase serve", url: server.url, dir: opts.convexDir, data: opts.dataPath, dashboard: opts.dashboard }) +
      "\n",
  );

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ level: "info", msg: "shutting down" }) + "\n");
    await server.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  return new Promise<number>(() => {
    // Run until a signal exits the process.
  });
}
