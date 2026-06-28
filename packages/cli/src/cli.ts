/**
 * `stackbase` CLI. `dev` loads the project, generates `_generated/`, boots the embedded
 * engine, serves HTTP, and hot-reloads on change. `codegen` just regenerates types.
 */
import { existsSync, watch as fsWatch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeGenerated } from "@stackbase/codegen";
import { generateAdminKey } from "@stackbase/admin";
import { resolveDevOptions, type DevOptions } from "./dev-options";
import { loadFunctionsDir } from "./load-modules";
import { resolveFunctionsDir, functionsDirNotFoundMessage } from "./functions-dir";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { bootProject, loadDashboard, withStorageModules } from "./boot";
import { ProcessRuntimeHost } from "./server";
import { createWatchLoop } from "./watch";
import { serveCommand } from "./serve";
import { deployCommand } from "./deploy";
import { buildCommand } from "./build";
import { migrateCommand } from "./migrate";
import { fleetCommand } from "./fleet";
import { objectstoreCommand } from "./objectstore";

function parseFlags(args: string[]): DevOptions {
  const out: DevOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) out.port = Number(args[++i]);
    else if (a === "--ip" && args[i + 1]) out.ip = args[++i];
    else if (a === "--dir" && args[i + 1]) out.functionsDir = args[++i];
    else if (a === "--data" && args[i + 1]) out.dataPath = args[++i];
    else if (a === "--web" && args[i + 1]) out.webDir = args[++i];
    else if (a === "--database-url" && args[i + 1]) out.databaseUrl = args[++i];
    else if (a === "--storage-bucket" && args[i + 1]) out.storageBucket = args[++i];
    else if (a === "--storage-endpoint" && args[i + 1]) out.storageEndpoint = args[++i];
  }
  return out;
}

export async function devCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const { functionsDir, projectRoot } = await resolveFunctionsDir(flags.functionsDir, process.cwd());
  if (!existsSync(functionsDir)) {
    process.stderr.write(functionsDirNotFoundMessage(functionsDir));
    return 1;
  }
  const opts = resolveDevOptions({ ...flags, functionsDir });
  const generatedDir = join(opts.functionsDir, "_generated");

  const config = await loadConfig(projectRoot);

  // Treat an empty/whitespace STACKBASE_ADMIN_KEY as unset (a blank key would 401 everything).
  const envKey = process.env.STACKBASE_ADMIN_KEY?.trim();
  if (process.env.STACKBASE_ADMIN_KEY !== undefined && !envKey) {
    process.stderr.write("⚠ STACKBASE_ADMIN_KEY is set but empty — generating an ephemeral key instead.\n");
  }
  const adminKey = envKey || generateAdminKey();
  const ephemeralKey = !envKey; // a generated per-run key, not the operator's persistent secret
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(opts.ip);

  const { runtime, adminApi, project, generated, store, logSink, storageRoutes } = await bootProject({
    functionsDir: opts.functionsDir,
    dataPath: opts.dataPath,
    adminKey,
    databaseUrl: opts.databaseUrl,
    storage: { bucket: opts.storageBucket, endpoint: opts.storageEndpoint },
  });
  writeGenerated(generated.files, generatedDir);

  // Only inject the key into the (unauthenticated) dashboard HTML when it's an ephemeral key on a
  // loopback bind — never embed a persistent STACKBASE_ADMIN_KEY where any network client can read
  // it. Otherwise serve the SPA without a key so it prompts the operator (stored client-side).
  const dashboard = loadDashboard(ephemeralKey && loopback ? adminKey : undefined);
  // Reach serving through the RuntimeHost seam (Slice 1) — the CLI never touches Bun.serve/node:http.
  const host = new ProcessRuntimeHost();
  const server = await host.serve(
    runtime,
    { port: opts.port, ip: opts.ip, webDir: opts.webDir, admin: { api: adminApi, key: adminKey }, dashboard, routes: project.routes, storageRoutes },
  );
  process.stdout.write(`stackbase dev → ${server.url}  (dashboard: ${server.url}/_dashboard)\n`);
  if (!dashboard) process.stdout.write(`  (dashboard SPA not built — run \`bun run --filter @stackbase/dashboard build\`)\n`);
  process.stdout.write(`admin key → ${adminKey}\n`);
  if (opts.webDir) process.stdout.write(`web UI → ${server.url}/\n`);

  const watcher = createWatchLoop({
    subscribe: (onChange) => {
      const w = fsWatch(resolve(opts.functionsDir), { recursive: true }, (_e, file) => {
        if (file && !String(file).includes("_generated")) onChange();
      });
      return () => w.close();
    },
    onTrigger: async (reason) => {
      if (reason === "initial") return; // already pushed above
      try {
        const next = push(await loadFunctionsDir(opts.functionsDir), config.components);
        writeGenerated(next.generated.files, generatedDir);
        // Re-apply the always-on `_storage:*` built-ins: `setModules` replaces `modules` wholesale.
        runtime.setModules(withStorageModules(next.project.moduleMap));
        server.setRoutes(next.project.routes);
        process.stdout.write(`↻ pushed (${Object.keys(next.project.moduleMap).length} functions)\n`);
      } catch (e) {
        process.stderr.write(`✗ reload failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    },
  });
  watcher.start();

  return new Promise<number>(() => {
    // Run until the process is killed.
  });
}

export async function codegenCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  // Same two-step resolve as `devCommand`: consult `functionsDir` in stackbase.config.ts when
  // `--dir` isn't given, instead of `resolveDevOptions`'s own bare `?? DEFAULT_FUNCTIONS_DIR`
  // fallback (which never reads the config file) — otherwise `codegen` and `dev` could disagree
  // about where the functions live on a project that sets the config key.
  const { functionsDir } = await resolveFunctionsDir(flags.functionsDir, process.cwd());
  if (!existsSync(functionsDir)) {
    process.stderr.write(functionsDirNotFoundMessage(functionsDir));
    return 1;
  }
  const opts = resolveDevOptions({ ...flags, functionsDir });
  const loaded = await loadFunctionsDir(opts.functionsDir);
  const config = await loadConfig(dirname(opts.functionsDir));
  const { generated } = push(loaded, config.components);
  writeGenerated(generated.files, join(opts.functionsDir, "_generated"));
  process.stdout.write(`generated ${opts.functionsDir}/_generated\n`);
  return 0;
}

function printHelp(): void {
  process.stdout.write(
    [
      "stackbase — Convex-compatible reactive backend",
      "",
      "Usage: stackbase <command> [options]",
      "",
      "Commands:",
      "  dev        Run the engine with hot reload + dashboard",
      "  serve      Run the production server (requires STACKBASE_ADMIN_KEY)",
      "  deploy     Deploy the app: --target <serve|cloudflare|docker|railway|fly|aws> --env <name> [--dry-run] [--check]",
      "  build      Compile the app to a self-contained executable (bun build --compile)",
      "  migrate    Migrate a Convex project into Stackbase (imports + report)",
      "  migrate export --url <src> --out dump.json   Export app data to a portable dump",
      "  migrate import --url <dst> --in  dump.json   Import a dump into a deployment",
      "  codegen    Regenerate <functionsDir>/_generated types",
      "  fleet reshard --shards M --database-url <url>   Change a STOPPED fleet's shard count",
      "  objectstore reshard --shards M --object-store <url> --dir <functionsDir>   Change a STOPPED object-storage deployment's shard count",
      "  help       Show this help",
      "",
      "Options: --port <n>  --ip <addr>  --dir <functionsDir>  --data <dbPath>  --database-url <url>",
      "Deploy:  --target <name>  --env <name>  --dry-run  --check   (default target: serve; default env: production)",
      "",
    ].join("\n"),
  );
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "dev":
      return devCommand(rest);
    case "serve":
      return serveCommand(rest);
    case "deploy":
      return deployCommand(rest);
    case "build":
      return buildCommand(rest);
    case "migrate":
      return migrateCommand(rest);
    case "codegen":
      return codegenCommand(rest);
    case "fleet":
      return fleetCommand(rest);
    case "objectstore":
      return objectstoreCommand(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      printHelp();
      return 0;
    default:
      process.stderr.write(`unknown command: ${cmd}\n`);
      printHelp();
      return 1;
  }
}
