import type { DeployContext, DeployResult, DeployTarget } from "../types";

// STUB — replaced by the real implementation in Task 8. Exists now only so the lazy `loadTarget`
// registry's `import("./targets/docker")` resolves and `bun run build` succeeds.
export const dockerTarget: DeployTarget = {
  name: "docker",
  async preflight(_ctx: DeployContext): Promise<void> {
    throw new Error("docker target not yet implemented (Task 8)");
  },
  async package(_ctx: DeployContext): Promise<void> {
    throw new Error("docker target not yet implemented (Task 8)");
  },
  async push(_ctx: DeployContext): Promise<DeployResult> {
    throw new Error("docker target not yet implemented (Task 8)");
  },
};
