/**
 * `helipod deploy` — package the local functions directory and push it to a target via the
 * `@helipod/deploy` seam. Targets: `serve` (slice-6b live hot-swap, back-compat default),
 * `cloudflare` (Workers via wrangler), `docker` (build + push an image). This module: resolve
 * flags → build a DeployContext (packageApp/codegen closures over the existing CLI machinery,
 * a real NodeSpawner) → lazy-load the target adapter → preflight → package → push (skipped on
 * --dry-run). `--check` gates on codegen drift (does the committed _generated/ match a fresh run).
 */
import { readdirSync, statSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { transform } from "esbuild";
import { writeGenerated } from "@helipod/codegen";
import { resolveDeploy, loadTarget, NodeSpawner, type Spawner, type DeployContext, DeployError } from "@helipod/deploy";
import { loadFunctionsDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { resolveFunctionsDir, ensureFunctionsDirExists } from "./functions-dir";

/** @deprecated slice-6b's own flag parser, superseded by parseDeployFlags/resolveDeploy. Kept for its existing test coverage. */
export interface DeployOptions {
  url: string;
  functionsDir: string;
  adminKey: string;
}

/** @deprecated see DeployOptions. */
export async function resolveDeployOptions(args: string[], env: NodeJS.ProcessEnv): Promise<DeployOptions | { error: string }> {
  let url = env.HELIPOD_DEPLOY_URL?.trim() ?? "";
  let dirFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) url = args[++i]!;
    else if (args[i] === "--dir" && args[i + 1]) dirFlag = args[++i]!;
  }
  const adminKey = env.HELIPOD_ADMIN_KEY?.trim() ?? "";
  if (!url) return { error: "missing target URL — pass --url <url> or set HELIPOD_DEPLOY_URL" };
  if (!adminKey) return { error: "HELIPOD_ADMIN_KEY is required to deploy" };
  const { functionsDir } = await resolveFunctionsDir(dirFlag, process.cwd());
  return { url, functionsDir, adminKey };
}

function walkTs(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(root, abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(abs);
  }
}

export async function packageApp(functionsDir: string): Promise<Array<{ path: string; code: string }>> {
  const absFiles: string[] = [];
  walkTs(functionsDir, functionsDir, absFiles);
  const out: Array<{ path: string; code: string }> = [];
  for (const abs of absFiles) {
    const source = readFileSync(abs, "utf8");
    // `transform` strips TS types and leaves import specifiers untouched — bare `@helipod/*`
    // resolve from the remote's node_modules; relative imports resolve within the pushed tree.
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
    const rel = relative(functionsDir, abs).split(sep).join("/").replace(/\.ts$/, ".js");
    out.push({ path: rel, code });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DeployDeps {
  spawn?: Spawner;
  cwd?: string;
  interactive?: boolean;
}

function parseDeployFlags(args: string[]): { target?: string; env?: string; url?: string; dirFlag?: string; dryRun: boolean; check: boolean } {
  let target: string | undefined;
  let env: string | undefined;
  let url: string | undefined = process.env.HELIPOD_DEPLOY_URL?.trim() || undefined;
  let dirFlag: string | undefined;
  let dryRun = false;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) target = args[++i];
    else if (args[i] === "--env" && args[i + 1]) env = args[++i];
    else if (args[i] === "--url" && args[i + 1]) url = args[++i];
    else if (args[i] === "--dir" && args[i + 1]) dirFlag = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--check") check = true;
  }
  return { target, env, url, dirFlag, dryRun, check };
}

/** True if running codegen would change the committed `_generated/` (drift). */
async function checkDrift(functionsDir: string, components: Awaited<ReturnType<typeof loadConfig>>["components"]): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), "sb-codegen-"));
  try {
    const { generated } = push(await loadFunctionsDir(functionsDir), components);
    writeGenerated(generated.files, tmp);
    const genDir = join(functionsDir, "_generated");
    return !dirsEqual(tmp, genDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function dirsEqual(a: string, b: string): boolean {
  const walk = (root: string): Map<string, string> => {
    const out = new Map<string, string>();
    const rec = (dir: string, rel: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir)) {
        const abs = join(dir, e);
        const r = rel ? `${rel}/${e}` : e;
        if (statSync(abs).isDirectory()) rec(abs, r);
        else out.set(r, readFileSync(abs, "utf8"));
      }
    };
    rec(root, "");
    return out;
  };
  const ma = walk(a);
  const mb = walk(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

/** CLI wrapper: resolve flags → build a DeployContext → dispatch through the DeployTarget seam. */
export async function deployCommand(args: string[], deps: DeployDeps = {}): Promise<number> {
  const flags = parseDeployFlags(args);
  const cwd = deps.cwd ?? process.cwd();
  // `resolveFunctionsDir` handles the precedence (--dir > `functionsDir` in helipod.config.ts >
  // DEFAULT_FUNCTIONS_DIR) and always returns an absolute path, so no separate `resolve()` of
  // `flags.dirFlag` is needed here the way a bare flag default would have required.
  const { functionsDir } = await resolveFunctionsDir(flags.dirFlag, cwd);
  // Fail loudly — with the migrate hint — before anything below (the `--check` drift scan or the
  // main package/push flow) can hit `loadFunctionsDir` and throw a raw ENOENT.
  if (!ensureFunctionsDirExists(functionsDir)) return 1;
  const config = await loadConfig(cwd);

  if (flags.check) {
    const drift = await checkDrift(functionsDir, config.components);
    if (drift) {
      process.stderr.write(`✗ ${functionsDir}/_generated is out of date — run \`helipod codegen\` and commit the result\n`);
      return 1;
    }
    process.stdout.write(`✓ ${functionsDir}/_generated is up to date\n`);
    // `--check` never pushes: it's a verification gate. Return after the drift verdict unless the
    // caller ALSO passed --dry-run (the dry-run flow below runs but always skips push), so --check
    // can never reach `push`.
    if (!flags.dryRun) return 0;
  }

  const resolved = resolveDeploy({ deploy: config.deploy, target: flags.target, env: flags.env, inlineUrl: flags.url });
  if ("error" in resolved) {
    process.stderr.write(`✗ ${resolved.error}\n`);
    return 1;
  }

  let target;
  try {
    target = await loadTarget(resolved.provider);
  } catch (e) {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const interactive = deps.interactive ?? (Boolean(process.stdin.isTTY) && !process.env.CI);
  const ctx: DeployContext = {
    cwd,
    functionsDir,
    env: resolved.env,
    target: resolved,
    interactive,
    spawn: deps.spawn ?? new NodeSpawner(),
    log: (m) => process.stdout.write(`  ${m}\n`),
    packageApp: async () => ({ files: await packageApp(functionsDir) }),
    codegen: async () => {
      const { generated } = push(await loadFunctionsDir(functionsDir), config.components);
      writeGenerated(generated.files, join(functionsDir, "_generated"));
    },
  };

  try {
    await target.preflight(ctx);
    await target.package(ctx);
    if (flags.dryRun) {
      process.stdout.write(`✓ dry-run OK (${resolved.provider} / ${resolved.env}) — push skipped\n`);
      return 0;
    }
    const result = await target.push(ctx);
    if (!result.ok) {
      process.stderr.write(`✗ deploy failed: ${result.error}\n`);
      return 1;
    }
    process.stdout.write(`✓ deployed via ${resolved.provider} (${resolved.env})${result.detail ? ` — ${result.detail}` : ""}\n`);
    if (result.url) process.stdout.write(`  ${result.url}\n`);
    return 0;
  } catch (e) {
    if (e instanceof DeployError) { process.stderr.write(`✗ ${e.message}\n`); return 1; }
    throw e;
  }
}
