/**
 * `helipod build` — compile the app to a self-contained executable via `bun build --compile`.
 * Refresh codegen (so the app's `import "./_generated/server"` resolves at compile time), codegen a
 * static-import entrypoint, shell out to `bun build --compile`, then clean up.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { writeGenerated } from "@helipod/codegen";
import { loadFunctionsDir, listFunctionModuleFiles, moduleKeyForFile } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { generateEntrySource } from "./build-entry";
import { resolveFunctionsDir, ensureFunctionsDirExists } from "./functions-dir";

export interface BuildOptions { functionsDir: string; outfile: string; target: string | null; dashboard: boolean; verbose: boolean }

export async function resolveBuildOptions(args: string[]): Promise<BuildOptions> {
  let dirFlag: string | undefined, outfile = "./helipod-server", target: string | null = null, dashboard = true, verbose = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) dirFlag = args[++i] as string;
    else if (a === "--outfile" && args[i + 1]) outfile = args[++i] as string;
    else if (a === "--target" && args[i + 1]) target = args[++i] as string;
    else if (a === "--no-dashboard") dashboard = false;
    else if (a === "--verbose") verbose = true;
  }
  const { functionsDir } = await resolveFunctionsDir(dirFlag, process.cwd());
  return { functionsDir, outfile, target, dashboard, verbose };
}

const TARGETS: Record<string, string> = {
  "linux-x64": "bun-linux-x64", "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64", "darwin-arm64": "bun-darwin-arm64",
  "windows-x64": "bun-windows-x64",
};
export function bunTargetFor(friendly: string): string {
  const t = TARGETS[friendly];
  if (!t) throw new Error(`unknown target "${friendly}" (expected one of: ${Object.keys(TARGETS).join(", ")})`);
  return t;
}

/** Enumerate the built dashboard dist as {urlPath, absPath}. "/" maps to index.html. */
function dashboardFiles(): Array<{ urlPath: string; absPath: string }> | null {
  try {
    const indexPath = createRequire(import.meta.url).resolve("@helipod/dashboard/dist");
    const dist = dirname(indexPath);
    const out: Array<{ urlPath: string; absPath: string }> = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dist, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r);
        else out.push({ urlPath: r === "index.html" ? "/" : `/${r}`, absPath: join(dist, r) });
      }
    };
    walk("");
    return out;
  } catch { return null; }
}

export async function buildCommand(args: string[]): Promise<number> {
  const opts = await resolveBuildOptions(args);
  // `resolveFunctionsDir` already returns an absolute path, so no extra `resolve()` is needed here.
  const functionsDirAbs = opts.functionsDir;
  // Fail loudly — with the migrate hint — before `loadFunctionsDir` below can throw a raw ENOENT.
  if (!ensureFunctionsDirExists(functionsDirAbs)) return 1;
  // 1. Load + refresh codegen so `import "./_generated/server"` resolves when bun bundles the modules.
  const loaded = await loadFunctionsDir(functionsDirAbs);
  const config = await loadConfig(dirname(functionsDirAbs));
  const { generated } = push(loaded, config.components);
  writeGenerated(generated.files, join(functionsDirAbs, "_generated"));
  // 2. Codegen the entrypoint.
  const moduleImports = listFunctionModuleFiles(functionsDirAbs).map((f) => ({ key: moduleKeyForFile(f), absPath: join(functionsDirAbs, f) }));
  const schemaAbsPath = join(functionsDirAbs, existsSync(join(functionsDirAbs, "schema.ts")) ? "schema.ts" : "schema.js");
  const cfgTs = join(dirname(functionsDirAbs), "helipod.config.ts"), cfgJs = join(dirname(functionsDirAbs), "helipod.config.js");
  const configAbsPath = existsSync(cfgTs) ? cfgTs : existsSync(cfgJs) ? cfgJs : null;
  const entrySrc = generateEntrySource({ moduleImports, schemaAbsPath, configAbsPath, dashboardFiles: opts.dashboard ? dashboardFiles() : null });
  const buildDir = resolve(".helipod-build");
  mkdirSync(buildDir, { recursive: true });
  const entryPath = join(buildDir, "entry.ts");
  writeFileSync(entryPath, entrySrc);
  // 3. Compile.
  // NOTE: no --bytecode — `bun build --compile --bytecode` rejects the entry's top-level await. Cold-start
  // speed is negligible for a long-running self-hosted server binary; revisit if the entry drops TLA.
  const bunArgs = ["build", "--compile", "--minify"];
  if (opts.target) bunArgs.push(`--target=${bunTargetFor(opts.target)}`);
  const outfile = opts.target === "windows-x64" && !opts.outfile.endsWith(".exe") ? `${opts.outfile}.exe` : opts.outfile;
  bunArgs.push(`--outfile=${resolve(outfile)}`, entryPath);
  // Shell the external `bun` binary via node:child_process so this works whether the CLI itself is
  // invoked under Bun or Node (the compile step needs Bun, but the caller need not be Bun).
  const proc = spawnSync("bun", bunArgs, { stdio: opts.verbose ? "inherit" : ["ignore", "ignore", "inherit"] });
  rmSync(buildDir, { recursive: true, force: true });
  if (proc.error) {
    process.stderr.write(`✗ could not run 'bun build --compile' — is Bun installed and on PATH? (${(proc.error as Error).message})\n`);
    return 1;
  }
  if (proc.status !== 0) { process.stderr.write("✗ bun build --compile failed\n"); return 1; }
  const size = (statSync(resolve(outfile)).size / (1024 * 1024)).toFixed(0);
  process.stdout.write(`✓ built ${outfile} (${size}MB)\n`);
  return 0;
}
