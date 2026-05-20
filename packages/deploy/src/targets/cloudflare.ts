import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";
import { stripJsonc, reconcileWrangler } from "../wrangler-reconcile";

const WRANGLER = "wrangler.jsonc";

/** First https URL wrangler prints on deploy — the deployed Worker URL. */
function extractDeployedUrl(stdout: string): string | undefined {
  return stdout.match(/https:\/\/[^\s]+/)?.[0];
}

export const cloudflareTarget: DeployTarget = {
  name: "cloudflare",
  async preflight(ctx) {
    const v = await ctx.spawn.run("wrangler", ["--version"], { cwd: ctx.cwd, stdio: "capture" }).catch(() => {
      throw new DeployError("wrangler not found — install it (npm i -D wrangler) and retry");
    });
    if (v.code !== 0) throw new DeployError("wrangler not found — install it (npm i -D wrangler) and retry");
    if (!existsSync(join(ctx.cwd, WRANGLER))) {
      throw new DeployError(`${WRANGLER} not found in ${ctx.cwd} — create one (see docs/enduser/deploy/cloudflare.md)`);
    }
    if (!ctx.interactive && !process.env.CLOUDFLARE_API_TOKEN) {
      throw new DeployError("CLOUDFLARE_API_TOKEN is required for non-interactive (CI) deploy");
    }
  },
  async package(ctx) {
    await ctx.codegen();
    const path = join(ctx.cwd, WRANGLER);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
    const r = reconcileWrangler(parsed, {
      needsR2: Boolean(ctx.target.settings.r2),
      r2BucketName: ctx.target.settings.r2BucketName == null ? undefined : String(ctx.target.settings.r2BucketName),
    });
    if (r.changed) {
      // NOTE: reconcile rewrites as plain JSON (comments not preserved) — only happens when a binding
      // is actually added; a project that already has the bindings keeps its commented wrangler.jsonc.
      writeFileSync(path, JSON.stringify(r.config, null, 2) + "\n");
      ctx.log(`reconciled ${WRANGLER}: added ${r.added.join(", ")}`);
    }
  },
  async push(ctx): Promise<DeployResult> {
    const args = ["deploy"];
    const wranglerEnv = ctx.target.settings.wranglerEnv == null ? undefined : String(ctx.target.settings.wranglerEnv);
    if (wranglerEnv) args.push("--env", wranglerEnv);
    const r = await ctx.spawn.run("wrangler", args, { cwd: ctx.cwd, stdio: "capture" });
    if (r.code !== 0) return { ok: false, error: `wrangler deploy failed: ${(r.stderr || r.stdout).trim()}` };
    const url = extractDeployedUrl(r.stdout);
    return { ok: true, url, detail: url ? `deployed to ${url}` : "deployed" };
  },
};
