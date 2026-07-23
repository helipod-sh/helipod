/**
 * `helipod` CLI. `dev` loads the project, generates `_generated/`, boots the embedded
 * engine, serves HTTP, and hot-reloads on change. `codegen` just regenerates types.
 */
import { watch as fsWatch } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { writeGenerated } from "@helipod/codegen";
import { generateAdminKey } from "@helipod/admin";
import { resolveDevOptions, type DevOptions } from "./dev-options";
import * as ui from "./ui";
import { CLI_VERSION } from "./version";
import { loadFunctionsDir } from "./load-modules";
import { resolveFunctionsDir, ensureFunctionsDirExists } from "./functions-dir";
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
    else if (a === "--no-ui") out.noUi = true;
  }
  return out;
}

export async function devCommand(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const { functionsDir, projectRoot } = await resolveFunctionsDir(flags.functionsDir, process.cwd());
  if (!ensureFunctionsDirExists(functionsDir)) {
    return 1;
  }
  const opts = resolveDevOptions({ ...flags, functionsDir });
  const generatedDir = join(opts.functionsDir, "_generated");

  const config = await loadConfig(projectRoot);

  // Treat an empty/whitespace HELIPOD_ADMIN_KEY as unset (a blank key would 401 everything).
  const envKey = process.env.HELIPOD_ADMIN_KEY?.trim();
  if (process.env.HELIPOD_ADMIN_KEY !== undefined && !envKey) {
    process.stderr.write("⚠ HELIPOD_ADMIN_KEY is set but empty — generating an ephemeral key instead.\n");
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
  // loopback bind — never embed a persistent HELIPOD_ADMIN_KEY where any network client can read
  // it. Otherwise serve the SPA without a key so it prompts the operator (stored client-side).
  const dashboard = loadDashboard(ephemeralKey && loopback ? adminKey : undefined);
  // Reach serving through the RuntimeHost seam (Slice 1) — the CLI never touches Bun.serve/node:http.
  const host = new ProcessRuntimeHost();
  const server = await host.serve(
    runtime,
    { port: opts.port, ip: opts.ip, webDir: opts.webDir, admin: { api: adminApi, key: adminKey }, dashboard, routes: project.routes, storageRoutes },
  );
  if (ui.styled) {
    const fnCount = Object.keys(project.moduleMap).length;
    const tableCount = Object.keys(project.tableNumbers).length;
    const componentCount = config.components.length;
    const rows: Array<[string, string]> = [
      ["API", ui.cyan(server.url)],
      ["Dashboard", ui.cyan(`${server.url}/_dashboard`)],
      ["Admin key", `${adminKey.slice(0, 7)}…${adminKey.slice(-4)} ${ui.dim("(full key: HELIPOD_ADMIN_KEY or plain output)")}`],
    ];
    if (opts.webDir) rows.push(["Web UI", ui.cyan(`${server.url}/`)]);
    process.stdout.write(`\n${ui.banner("dev", CLI_VERSION)}\n\n${ui.keyValues(rows)}\n\n`);
    process.stdout.write(
      ui.status("ok", `${fnCount} functions · ${tableCount} tables · ${componentCount} components`) + "\n",
    );
    if (!dashboard) process.stdout.write(ui.status("warn", "dashboard SPA not built", "bun run --filter @helipod/dashboard build") + "\n");
    process.stdout.write(`  ${ui.dim(`watching ${opts.functionsDir} for changes…`)}\n\n`);
  } else {
    // Plain mode is a byte-stable contract: scripts and our own e2e tests scrape these lines.
    process.stdout.write(`helipod dev → ${server.url}  (dashboard: ${server.url}/_dashboard)\n`);
    if (!dashboard) process.stdout.write(`  (dashboard SPA not built — run \`bun run --filter @helipod/dashboard build\`)\n`);
    process.stdout.write(`admin key → ${adminKey}\n`);
    if (opts.webDir) process.stdout.write(`web UI → ${server.url}/\n`);
  }

  // The live module map, refreshed on every hot reload — the runner reads each
  // function's args validator from here.
  let currentModules: Record<string, unknown> = project.moduleMap as Record<string, unknown>;
  let currentTableNumbers: Record<string, number> = project.tableNumbers;

  // The interactive terminal dashboard (@helipod/tui, OpenTUI): Bun + TTY only, dynamic
  // import so @helipod/cli carries no static dependency on it (the @helipod/fleet seam
  // pattern). Any failure — package absent, Node without FFI — falls back silently to
  // the styled plain output above.
  type TuiEmit = (e: import("./tui-bridge").AnyTuiEvent) => void;
  let tuiEmit: TuiEmit | null = null;
  const wantTui =
    process.env.HELIPOD_TUI === "1" ||
    (ui.styled && !flags.noUi && process.env.HELIPOD_TUI !== "0" && typeof (globalThis as { Bun?: unknown }).Bun !== "undefined");
  if (wantTui) {
    try {
      const { attachTui } = await import("./tui-bridge");
      tuiEmit = await attachTui({
        url: server.url,
        dashboardUrl: dashboard ? `${server.url}/_dashboard` : null,
        adminKeyPreview: `${adminKey.slice(0, 7)}…${adminKey.slice(-4)}`,
        functionsDir: relative(process.cwd(), opts.functionsDir) || opts.functionsDir,
        storage: opts.databaseUrl ? "postgres" : "sqlite",
        version: CLI_VERSION,
        admin: {
          listTables: () => adminApi.listTables(),
          getTableData: (t, o) => adminApi.getTableData(t, o as never),
          // Enrich the manifest listing with each function's own args validator
          // (the module map holds the real `argsJson`; the manifest carries only
          // name+type), so the runner's form is generated from the same metadata
          // codegen types against and can never drift from the code.
          listFunctions: () =>
            adminApi.listFunctions().map((f) => {
              const mod = currentModules[f.path] as { argsJson?: unknown } | undefined;
              return mod?.argsJson ? { ...f, argsType: mod.argsJson } : f;
            }),
          runFunction: (p, a) => adminApi.runFunction(p, a as never),
          queryLogs: (f) => adminApi.queryLogs(f),
          stats: () => adminApi.stats(),
          // The engine's reactive fan-out — every committed write announces the
          // tables it touched, which is exactly what the dashboard needs to stay
          // live without polling.
          // The fan-out identifies tables by NUMBER (verified against the real
          // engine); the dashboard speaks names, so translate here using the
          // live table-number map, which the hot-reload swap keeps current.
          onCommit: (cb) =>
            runtime.writeFanoutAdapter.subscribe((p) => {
              const byNumber = new Map(
                Object.entries(currentTableNumbers).map(([name, n]) => [String(n), name]),
              );
              const names = (p.tables ?? []).map((t) => byNumber.get(String(t)) ?? String(t));
              cb(names, Number(p.commitTs ?? 0));
            }),
          getSchema: () => adminApi.getSchema(),
        },
        counts: () => ({
          functions: Object.keys(project.moduleMap).length,
          tables: Object.keys(project.tableNumbers).length,
          components: config.components.length,
        }),
      });
    } catch (e) {
      // Never fatal: the styled plain output above stays active. Set
      // HELIPOD_TUI_DEBUG=1 to see why the dashboard did not attach.
      tuiEmit = null;
      if (process.env.HELIPOD_TUI_DEBUG) {
        process.stderr.write(`  ${ui.dim("tui unavailable:")} ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      }
    }
  }

  const watcher = createWatchLoop({
    subscribe: (onChange) => {
      const w = fsWatch(resolve(opts.functionsDir), { recursive: true }, (_e, file) => {
        if (file && !String(file).includes("_generated")) onChange();
      });
      return () => w.close();
    },
    onTrigger: async (reason) => {
      if (reason === "initial") return; // already pushed above
      const reloadStart = Date.now();
      try {
        const next = push(await loadFunctionsDir(opts.functionsDir), config.components);
        writeGenerated(next.generated.files, generatedDir);
        // Re-apply the always-on `_storage:*` built-ins: `setModules` replaces `modules` wholesale.
        runtime.setModules(withStorageModules(next.project.moduleMap));
        currentModules = next.project.moduleMap as Record<string, unknown>;
        currentTableNumbers = next.project.tableNumbers;
        server.setRoutes(next.project.routes);
        // The admin API is the third consumer of the reloaded project (issue #1): without this,
        // `/_admin/functions` and the dashboard keep serving the boot-time manifest/schema.
        // Mirrors the live-deploy path (deploy-apply.ts).
        adminApi.setSchema(next.project.schemaJson, next.project.tableNumbers, next.project.manifest);
        const fnTotal = Object.keys(next.project.moduleMap).length;
        if (tuiEmit) {
          tuiEmit({ kind: "reload", ok: true, durationMs: Date.now() - reloadStart, functions: fnTotal, at: Date.now() });
        } else {
          process.stdout.write(
            ui.styled
              ? `  ${ui.sym.reload} ${ui.green("reloaded")} ${ui.dim(`(${fnTotal} functions)`)}\n`
              : `↻ pushed (${fnTotal} functions)\n`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (tuiEmit) {
          tuiEmit({ kind: "reload", ok: false, message: msg, at: Date.now() });
        } else {
          process.stderr.write(
            ui.styled
              ? ui.errorBlock("reload failed", msg, "serving the last good version — fix the file to reload") + "\n"
              : `✗ reload failed: ${msg}\n`,
          );
        }
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
  // Same two-step resolve as `devCommand`: consult `functionsDir` in helipod.config.ts when
  // `--dir` isn't given, instead of `resolveDevOptions`'s own bare `?? DEFAULT_FUNCTIONS_DIR`
  // fallback (which never reads the config file) — otherwise `codegen` and `dev` could disagree
  // about where the functions live on a project that sets the config key.
  const { functionsDir } = await resolveFunctionsDir(flags.functionsDir, process.cwd());
  if (!ensureFunctionsDirExists(functionsDir)) return 1;
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
      "helipod - the reactive backend you self-host",
      "",
      "Usage: helipod <command> [options]",
      "",
      "Commands:",
      "  dev        Run the engine with hot reload + dashboard",
      "  serve      Run the production server (requires HELIPOD_ADMIN_KEY)",
      "  deploy     Deploy the app: --target <serve|cloudflare|docker|railway|fly|aws> --env <name> [--dry-run] [--check]",
      "  build      Compile the app to a self-contained executable (bun build --compile)",
      "  migrate    Migrate a Convex project into Helipod (imports + report)",
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
