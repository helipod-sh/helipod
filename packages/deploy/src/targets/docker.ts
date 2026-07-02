import type { DeployTarget, DeployContext, DeployResult } from "../types";
import { DeployError } from "../types";

export const dockerTarget: DeployTarget = {
  name: "docker",
  async preflight(ctx) {
    const v = await ctx.spawn.run("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "capture" }).catch(() => {
      throw new DeployError("docker not found — install Docker to use the docker target");
    });
    if (v.code !== 0) {
      throw new DeployError("Docker is installed but the daemon is not reachable — start Docker and retry");
    }
  },
  async package(ctx) {
    // The image builds from the repo's Dockerfile/compose at push time (`--build`); refresh codegen
    // so the baked functions directory's `_generated` matches the functions being deployed.
    await ctx.codegen();
  },
  async push(ctx): Promise<DeployResult> {
    const r = await ctx.spawn.run("docker", ["compose", "up", "-d", "--build"], { cwd: ctx.cwd, stdio: "inherit" });
    if (r.code !== 0) return { ok: false, error: `docker compose up failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}` };
    return { ok: true, detail: "container up (docker compose)" };
  },
};
