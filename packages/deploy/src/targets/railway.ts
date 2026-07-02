import type { DeployTarget, DeployResult } from "../types";
import { DeployError } from "../types";

export const railwayTarget: DeployTarget = {
  name: "railway",
  async preflight(ctx) {
    const v = await ctx.spawn.run("railway", ["--version"], { cwd: ctx.cwd, stdio: "capture" }).catch(() => {
      throw new DeployError("railway CLI not found — install railway CLI (npm i -g @railway/cli, or see https://docs.railway.com/guides/cli) and retry");
    });
    if (v.code !== 0) throw new DeployError("railway CLI not found — install railway CLI and retry");
    // RAILWAY_TOKEN is Railway's documented CI/non-interactive project-token auth env var — required
    // in non-interactive mode since `railway up` otherwise falls back to an interactive login prompt.
    if (!ctx.interactive && !process.env.RAILWAY_TOKEN) {
      throw new DeployError("RAILWAY_TOKEN is required for non-interactive (CI) deploy");
    }
  },
  async package(ctx) {
    // Railway builds the deployed image itself (from the repo's Dockerfile if present, else Nixpacks
    // auto-detection) when `railway up` uploads the project — there is nothing to bundle here beyond
    // refreshing codegen so the baked functions directory's `_generated` matches the functions
    // being deployed.
    await ctx.codegen();
  },
  async push(ctx): Promise<DeployResult> {
    const args = ["up"];
    const service = ctx.target.settings.service == null ? undefined : String(ctx.target.settings.service);
    if (service) args.push("--service", service);
    const environment = ctx.target.settings.environment == null ? undefined : String(ctx.target.settings.environment);
    if (environment) args.push("--environment", environment);
    const r = await ctx.spawn.run("railway", args, { cwd: ctx.cwd, stdio: "capture" });
    if (r.code !== 0) return { ok: false, error: `railway up failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    return { ok: true, detail: (r.stdout || "deployed (railway up)").trim() };
  },
};
