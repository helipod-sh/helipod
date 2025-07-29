/**
 * `stackbase deploy` — push the local convex/ to a running remote `serve` and apply it live.
 * This module: resolve options, transpile the app to a transferable JS file tree, refresh the
 * local `_generated/` so client types stay current, then POST the tree to `/_admin/deploy`.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { transform } from "esbuild";
import { writeGenerated } from "@stackbase/codegen";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";

export interface DeployOptions {
  url: string;
  convexDir: string;
  adminKey: string;
}

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

/** CLI wrapper: resolve options → refresh local codegen → package → POST → report. */
export async function deployCommand(args: string[]): Promise<number> {
  const opts = resolveDeployOptions(args, process.env);
  if ("error" in opts) {
    process.stderr.write(`✗ ${opts.error}\n`);
    return 1;
  }

  // Refresh local _generated so the client's typed API matches what we're about to deploy —
  // mirrors codegenCommand in cli.ts (load → push → writeGenerated).
  const loaded = await loadConvexDir(opts.convexDir);
  const config = await loadConfig(dirname(opts.convexDir));
  const { generated } = push(loaded, config.components);
  writeGenerated(generated.files, join(opts.convexDir, "_generated"));

  const files = await packageApp(opts.convexDir);

  let res: Response;
  try {
    res = await fetch(`${opts.url.replace(/\/$/, "")}/_admin/deploy`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.adminKey}` },
      body: JSON.stringify({ files }),
    });
  } catch (e) {
    process.stderr.write(`✗ could not reach ${opts.url}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; rev?: string; functions?: number; error?: string };
  if (res.status === 404) {
    process.stderr.write("✗ deploy not enabled on target (start serve with --allow-deploy)\n");
    return 1;
  }
  if (!res.ok || !body.ok) {
    process.stderr.write(`✗ deploy failed: ${body.error ?? res.statusText}\n`);
    return 1;
  }
  process.stdout.write(`✓ deployed rev ${body.rev} (${body.functions} functions)\n`);
  return 0;
}
