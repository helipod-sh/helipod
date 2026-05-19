/**
 * `stackbase deploy` — package the local convex/ app and push it to a target via the
 * `@stackbase/deploy` seam. Targets: `serve` (slice-6b live hot-swap, back-compat default),
 * `cloudflare` (Workers via wrangler), `docker` (build + push an image). This module: resolve
 * flags → build a DeployContext (packageApp/codegen closures over the existing CLI machinery,
 * a real NodeSpawner) → lazy-load the target adapter → preflight → package → push (skipped on
 * --dry-run). `--check` gates on codegen drift (does the committed _generated/ match a fresh run).
 */
import { readdirSync, statSync, readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { transform } from "esbuild";
import { writeGenerated } from "@stackbase/codegen";
import { resolveDeploy, loadTarget, NodeSpawner, type Spawner, type DeployContext, DeployError } from "@stackbase/deploy";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";

/** @deprecated slice-6b's own flag parser, superseded by parseDeployFlags/resolveDeploy. Kept for its existing test coverage. */
export interface DeployOptions {
  url: string;
  convexDir: string;
  adminKey: string;
}

/** @deprecated see DeployOptions. */
export function resolveDeployOptions(args: string[], env: NodeJS.ProcessEnv): DeployOptions | { error: string } {
  let url = env.STACKBASE_DEPLOY_URL?.trim() ?? "";
  let convexDir = "convex";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && args[i + 1]) url = args[++i]!;
    else if (args[i] === "--dir" && args[i + 1]) convexDir = args[++i]!;
  }
  const adminKey = env.STACKBASE_ADMIN_KEY?.trim() ?? "";
  if (!url) return { error: "missing target URL — pass --url <url> or set STACKBASE_DEPLOY_URL" };
  if (!adminKey) return { error: "STACKBASE_ADMIN_KEY is required to deploy" };
  return { url, convexDir, adminKey };
}

function walkTs(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walkTs(root, abs, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(abs);
  }
}

export async function packageApp(convexDir: string): Promise<Array<{ path: string; code: string }>> {
  const absFiles: string[] = [];
  walkTs(convexDir, convexDir, absFiles);
  const out: Array<{ path: string; code: string }> = [];
  for (const abs of absFiles) {
    const source = readFileSync(abs, "utf8");
    // `transform` strips TS types and leaves import specifiers untouched — bare `@stackbase/*`
    // resolve from the remote's node_modules; relative imports resolve within the pushed tree.
    const { code } = await transform(source, { loader: "ts", format: "esm", target: "esnext" });
    const rel = relative(convexDir, abs).split(sep).join("/").replace(/\.ts$/, ".js");
    out.push({ path: rel, code });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export interface DeployDeps {
  spawn?: Spawner;
  cwd?: string;
  interactive?: boolean;
}

function parseDeployFlags(args: string[]): { target?: string; env?: string; url?: string; convexDir: string; dryRun: boolean; check: boolean } {
  let target: string | undefined;
  let env: string | undefined;
  let url: string | undefined = process.env.STACKBASE_DEPLOY_URL?.trim() || undefined;
  let convexDir = "convex";
  let dryRun = false;
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) target = args[++i];
    else if (args[i] === "--env" && args[i + 1]) env = args[++i];
    else if (args[i] === "--url" && args[i + 1]) url = args[++i];
    else if (args[i] === "--dir" && args[i + 1]) convexDir = args[++i]!;
    else if (args[i] === "--dry-run") dryRun = true;
    else if (args[i] === "--check") check = true;
  }
  return { target, env, url, convexDir, dryRun, check };
}

/** True if running codegen would change the committed convex/_generated (drift). */
async function checkDrift(convexDir: string, components: Awaited<ReturnType<typeof loadConfig>>["components"]): Promise<boolean> {
  const tmp = mkdtempSync(join(tmpdir(), "sb-codegen-"));
  try {
    const { generated } = push(await loadConvexDir(convexDir), components);
    writeGenerated(generated.files, tmp);
    const genDir = join(convexDir, "_generated");
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
  const convexDir = join(cwd, flags.convexDir);
  const config = await loadConfig(cwd);

  if (flags.check) {
    const drift = await checkDrift(convexDir, config.components);
    if (drift) {
      process.stderr.write("✗ convex/_generated is out of date — run `stackbase codegen` and commit the result\n");
      return 1;
    }
    process.stdout.write("✓ convex/_generated is up to date\n");
    if (!flags.dryRun && !flags.target && !config.deploy) return 0; // --check-only invocation
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
    convexDir,
    env: resolved.env,
    target: resolved,
    interactive,
    spawn: deps.spawn ?? new NodeSpawner(),
    log: (m) => process.stdout.write(`  ${m}\n`),
    packageApp: async () => ({ files: await packageApp(convexDir) }),
    codegen: async () => {
      const { generated } = push(await loadConvexDir(convexDir), config.components);
      writeGenerated(generated.files, join(convexDir, "_generated"));
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
