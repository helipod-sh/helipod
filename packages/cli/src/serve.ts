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
import { applyDeploy } from "./deploy-apply";
import type { DeploySchema } from "./schema-diff";
import type { SchemaJsonLike } from "@stackbase/admin";
import type { DocStore } from "@stackbase/docstore";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";

export interface ServeOptions {
  convexDir: string;
  dataPath: string;
  ip: string;
  port: number;
  dashboard: boolean;
  /** Enable `POST /_admin/deploy` (`stackbase deploy`'s hot-swap target). Off by default — a running
   * `serve` only accepts live code changes when explicitly opted in. */
  allowDeploy: boolean;
  /** Postgres connection string (flag wins over `STACKBASE_DATABASE_URL`); unset → SQLite. */
  databaseUrl?: string;
  /** File-storage backend flag overrides (`--storage-bucket`/`--storage-endpoint`; win over env). */
  storageBucket?: string;
  storageEndpoint?: string;
}

export function resolveServeOptions(args: string[]): ServeOptions {
  let convexDir = "convex";
  let dataPath = process.env.STACKBASE_DATA_DIR ? join(process.env.STACKBASE_DATA_DIR, "db.sqlite") : "./data/db.sqlite";
  let ip = "0.0.0.0";
  let port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let dashboard = process.env.STACKBASE_DASHBOARD?.trim().toLowerCase() !== "off";
  let allowDeploy = process.env.STACKBASE_ALLOW_DEPLOY === "1";
  let databaseUrl = process.env.STACKBASE_DATABASE_URL;
  let storageBucket: string | undefined;
  let storageEndpoint: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) convexDir = args[++i] as string;
    else if (a === "--data" && args[i + 1]) dataPath = args[++i] as string;
    else if (a === "--ip" && args[i + 1]) ip = args[++i] as string;
    else if (a === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (a === "--no-dashboard") dashboard = false;
    else if (a === "--allow-deploy") allowDeploy = true;
    else if (a === "--database-url" && args[i + 1]) databaseUrl = args[++i] as string;
    else if (a === "--storage-bucket" && args[i + 1]) storageBucket = args[++i] as string;
    else if (a === "--storage-endpoint" && args[i + 1]) storageEndpoint = args[++i] as string;
  }
  return { convexDir, dataPath, ip, port, dashboard, allowDeploy, databaseUrl, storageBucket, storageEndpoint };
}

/**
 * Adapt `AdminApi.getSchema()`'s `SchemaJsonLike` (the data-browser's schema shape) into
 * `DeploySchema["schemaJson"]` (the schema-diff's narrower, required-`documentType` shape) —
 * `AdminApi`'s live schema always carries a real `documentType` for app tables, this just narrows
 * the type safely instead of asserting it.
 */
function toDeploySchema(schemaJson: SchemaJsonLike): DeploySchema["schemaJson"] {
  const tables: DeploySchema["schemaJson"]["tables"] = {};
  for (const [name, t] of Object.entries(schemaJson.tables)) {
    const dt = t.documentType;
    tables[name] = { documentType: dt && dt.type === "object" ? dt : { type: "object", value: {} } };
  }
  return { tables };
}

/** Testable core: boot + start the server. No signals, no exit, does not block. */
export async function startServe(
  opts: ServeOptions & { adminKey: string },
): Promise<{ server: DevServer; store: DocStore; runtime: EmbeddedRuntime }> {
  const { runtime, adminApi, project, store, components, storageRoutes } = await bootProject({
    convexDir: opts.convexDir,
    dataPath: opts.dataPath,
    adminKey: opts.adminKey,
    databaseUrl: opts.databaseUrl,
    storage: { bucket: opts.storageBucket, endpoint: opts.storageEndpoint },
  });
  // No embedded key (0.0.0.0 bind): the dashboard SPA prompts the operator for the admin key.
  const dashboard = opts.dashboard ? loadDashboard(undefined) : undefined;

  // `server` is assigned below by `startDevServer`; `setRoutes` only runs on a LATER deploy
  // request, by which time it is set. `current` reads AdminApi's live schema — no serve-side
  // bookkeeping to keep in sync.
  let server: DevServer;
  const deploy = opts.allowDeploy
    ? {
        apply: (files: Array<{ path: string; code: string }>) =>
          applyDeploy(
            {
              runtime,
              adminApi,
              setRoutes: (r) => server.setRoutes(r),
              components,
              current: () => {
                const live = adminApi.getSchema();
                return { schemaJson: toDeploySchema(live.schemaJson), tableNumbers: live.tableNumbers };
              },
              deployRoot: join(process.cwd(), ".stackbase-deploy"),
            },
            files,
          ),
      }
    : undefined;
  server = await startDevServer(
    runtime,
    { port: opts.port, ip: opts.ip, admin: { api: adminApi, key: opts.adminKey }, dashboard, routes: project.routes, storageRoutes, deploy },
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
    JSON.stringify({
      level: "info",
      msg: "stackbase serve",
      url: server.url,
      dir: opts.convexDir,
      data: opts.dataPath,
      dashboard: opts.dashboard,
      allowDeploy: opts.allowDeploy,
    }) + "\n",
  );

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ level: "info", msg: "shutting down" }) + "\n");
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  return new Promise<number>(() => {
    // Run until a signal exits the process.
  });
}
