/**
 * `stackbase` CLI. `dev` loads the project, generates `_generated/`, boots the embedded
 * engine, serves HTTP, and hot-reloads on change. `codegen` just regenerates types.
 */
import { watch as fsWatch, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodeSqliteAdapter, BunSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { writeGenerated } from "@stackbase/codegen";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { resolveDevOptions, detectRuntime, type DevOptions } from "./dev-options";
import { loadConvexDir } from "./load-modules";
import { push } from "./push-pipeline";
import { startDevServer } from "./server";
import { createWatchLoop } from "./watch";

function parseFlags(args: string[]): DevOptions {
  const out: DevOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) out.port = Number(args[++i]);
    else if (a === "--ip" && args[i + 1]) out.ip = args[++i];
    else if (a === "--dir" && args[i + 1]) out.convexDir = args[++i];
    else if (a === "--data" && args[i + 1]) out.dataPath = args[++i];
    else if (a === "--web" && args[i + 1]) out.webDir = args[++i];
  }
  return out;
}

function makeStore(dataPath: string): SqliteDocStore {
  mkdirSync(dirname(resolve(dataPath)), { recursive: true });
  const adapter = detectRuntime() === "bun" ? new BunSqliteAdapter({ path: dataPath }) : new NodeSqliteAdapter({ path: dataPath });
  return new SqliteDocStore(adapter);
}

export async function devCommand(args: string[]): Promise<number> {
  const opts = resolveDevOptions(parseFlags(args));
  const generatedDir = join(opts.convexDir, "_generated");

  const loaded = await loadConvexDir(opts.convexDir);
  const { project, generated } = push(loaded);
  writeGenerated(generated.files, generatedDir);

  const runtime = await createEmbeddedRuntime({ store: makeStore(opts.dataPath), catalog: project.catalog, modules: project.moduleMap });
  const server = await startDevServer(
    runtime,
    { functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) },
    { port: opts.port, ip: opts.ip, webDir: opts.webDir },
  );
  process.stdout.write(`stackbase dev → ${server.url}  (dashboard: ${server.url}/_dashboard)\n`);
  if (opts.webDir) process.stdout.write(`web UI → ${server.url}/\n`);

  const watcher = createWatchLoop({
    subscribe: (onChange) => {
      const w = fsWatch(resolve(opts.convexDir), { recursive: true }, (_e, file) => {
        if (file && !String(file).includes("_generated")) onChange();
      });
      return () => w.close();
    },
    onTrigger: async (reason) => {
      if (reason === "initial") return; // already pushed above
      try {
        const next = push(await loadConvexDir(opts.convexDir));
        writeGenerated(next.generated.files, generatedDir);
        runtime.setModules(next.project.moduleMap);
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
  const opts = resolveDevOptions(parseFlags(args));
  const { generated } = push(await loadConvexDir(opts.convexDir));
  writeGenerated(generated.files, join(opts.convexDir, "_generated"));
  process.stdout.write(`generated ${opts.convexDir}/_generated\n`);
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
      "  codegen    Regenerate convex/_generated types",
      "  help       Show this help",
      "",
      "Options: --port <n>  --ip <addr>  --dir <convexDir>  --data <dbPath>",
      "",
    ].join("\n"),
  );
}

export async function runCli(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "dev":
      return devCommand(rest);
    case "codegen":
      return codegenCommand(rest);
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
