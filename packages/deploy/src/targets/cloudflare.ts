import type { DeployContext, DeployResult, DeployTarget } from "../types";

// STUB — replaced by the real implementation in Task 7. Exists now only so the lazy `loadTarget`
// registry's `import("./targets/cloudflare")` resolves and `bun run build` succeeds.
export const cloudflareTarget: DeployTarget = {
  name: "cloudflare",
  async preflight(_ctx: DeployContext): Promise<void> {
    throw new Error("cloudflare target not yet implemented (Task 7)");
  },
  async package(_ctx: DeployContext): Promise<void> {
    throw new Error("cloudflare target not yet implemented (Task 7)");
  },
  async push(_ctx: DeployContext): Promise<DeployResult> {
    throw new Error("cloudflare target not yet implemented (Task 7)");
  },
};
