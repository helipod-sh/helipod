import type { DeployTarget, DeployResult } from "../types";
import { DeployError } from "../types";

export const flyTarget: DeployTarget = {
  name: "fly",
  async preflight(ctx) {
    const v = await ctx.spawn.run("fly", ["version"], { cwd: ctx.cwd, stdio: "capture" }).catch(() => {
      throw new DeployError("fly CLI not found — install flyctl (see https://fly.io/docs/flyctl/install/) and retry");
    });
    if (v.code !== 0) throw new DeployError("fly CLI not found — install flyctl and retry");
    // FLY_API_TOKEN is Fly's documented CI/non-interactive token auth env var — required in
    // non-interactive mode since `fly deploy` otherwise falls back to an interactive login prompt.
    if (!ctx.interactive && !process.env.FLY_API_TOKEN) {
      throw new DeployError("FLY_API_TOKEN is required for non-interactive (CI) deploy");
    }
  },
  async package(ctx) {
    // Fly builds the deployed image itself (from the repo's Dockerfile, per fly.toml's `build`
    // config, or a buildpack fallback) when `fly deploy` uploads the project — there is nothing to
    // bundle here beyond refreshing codegen so the baked convex/_generated matches the functions
    // being deployed.
    await ctx.codegen();
  },
  async push(ctx): Promise<DeployResult> {
    const args = ["deploy"];
    const app = ctx.target.settings.app == null ? undefined : String(ctx.target.settings.app);
    if (app) args.push("--app", app);
    const region = ctx.target.settings.region == null ? undefined : String(ctx.target.settings.region);
    if (region) args.push("--region", region);
    const r = await ctx.spawn.run("fly", args, { cwd: ctx.cwd, stdio: "capture" });
    if (r.code !== 0) return { ok: false, error: `fly deploy failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    return { ok: true, detail: (r.stdout || "deployed (fly deploy)").trim() };
  },
};
