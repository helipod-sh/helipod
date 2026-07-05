/**
 * The runtime entry a `helipod build` binary calls. It is compiled `serve`: boot an already-loaded
 * project (static imports, not a dir scan), start the shared server, print a machine-readable ready
 * line, and shut down gracefully. `startBinaryServer` is the testable core (no signals/exit).
 */
import { join } from "node:path";
import type { ComponentDefinition } from "@helipod/component";
import type { EmbeddedRuntime } from "@helipod/runtime-embedded";
import type { DocStore } from "@helipod/docstore";
import type { LoadedProject } from "./project";
import { bootLoaded } from "./boot";
import { ProcessRuntimeHost, type DevServer } from "./server";

export interface BinaryOptions {
  port: number;
  ip: string;
  dataDir: string;
  adminKey: string;
  /** Postgres connection string (flag wins over `HELIPOD_DATABASE_URL`); unset → SQLite. */
  databaseUrl?: string;
}

/** The materialized embedded dashboard: key-injected HTML plus the urlPath→embedded-path asset map. */
export interface EmbeddedDashboard { html: string; assets: Record<string, string> }

/** Minimal structural surface of `Bun.file(path)`, reached only inside a compiled binary. */
interface BunFileLike {
  text(): Promise<string>;
}
interface BunFileRuntime {
  file(path: string): BunFileLike;
}

export function resolveBinaryOptions(argv: string[], env: Record<string, string | undefined>): BinaryOptions {
  let port = env.PORT ? Number(env.PORT) : 3000;
  let ip = "0.0.0.0";
  let dataDir = "./data";
  let databaseUrl = env.HELIPOD_DATABASE_URL;
  const adminKey = (env.HELIPOD_ADMIN_KEY ?? "").trim();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" && argv[i + 1] !== undefined) port = Number(argv[++i]);
    else if (a === "--hostname" && argv[i + 1] !== undefined) ip = argv[++i] as string;
    else if (a === "--data-dir" && argv[i + 1] !== undefined) dataDir = argv[++i] as string;
    else if (a === "--database-url" && argv[i + 1] !== undefined) databaseUrl = argv[++i] as string;
  }
  return { port, ip, dataDir, adminKey, databaseUrl };
}

export async function startBinaryServer(
  loaded: LoadedProject,
  components: ComponentDefinition[],
  opts: BinaryOptions,
  dashboard?: Record<string, string>,
): Promise<{ server: DevServer; store: DocStore; runtime: EmbeddedRuntime }> {
  const boot = await bootLoaded({
    loaded,
    components,
    dataPath: join(opts.dataDir, "db.sqlite"),
    adminKey: opts.adminKey,
    databaseUrl: opts.databaseUrl,
  });
  let dash: EmbeddedDashboard | undefined;
  if (dashboard) {
    const bun = (globalThis as { Bun?: BunFileRuntime }).Bun;
    if (!bun) throw new Error("Bun runtime not available to read the embedded dashboard");
    const indexPath = dashboard["/"];
    if (!indexPath) throw new Error("embedded dashboard map is missing its \"/\" (index.html) entry");
    const html = await bun.file(indexPath).text();
    dash = { html, assets: dashboard };
  }
  const server = await new ProcessRuntimeHost().serve(boot.runtime, {
    port: opts.port,
    ip: opts.ip,
    admin: { api: boot.adminApi, key: opts.adminKey },
    routes: boot.project.routes,
    storageRoutes: boot.storageRoutes,
    componentRoutes: boot.componentRoutes,
    dashboard: dash,
  });
  return { server, store: boot.store, runtime: boot.runtime };
}

export async function runBinaryServer(
  loaded: LoadedProject,
  components: ComponentDefinition[],
  dashboard?: Record<string, string>,
): Promise<void> {
  const opts = resolveBinaryOptions(process.argv.slice(2), process.env);
  if (!opts.adminKey) {
    process.stderr.write("✗ HELIPOD_ADMIN_KEY is required — set it to a strong secret.\n");
    process.exit(1);
  }
  const { server, store } = await startBinaryServer(loaded, components, opts, dashboard);
  process.stdout.write(JSON.stringify({ ready: true, port: opts.port, url: `http://${opts.ip}:${opts.port}` }) + "\n");
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
