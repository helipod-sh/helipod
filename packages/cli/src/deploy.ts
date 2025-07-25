/**
 * `stackbase deploy` — push the local convex/ to a running remote `serve` and apply it live.
 * This module: resolve options, transpile the app to a transferable JS file tree. The POST that
 * ships it (`deployCommand`) is added once the endpoint exists.
 */
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { transform } from "esbuild";

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
