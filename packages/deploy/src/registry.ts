import type { DeployTarget } from "./types";

/** Lazy dynamic-import dispatch — a provider's adapter module loads only when it is used. */
export async function loadTarget(provider: string): Promise<DeployTarget> {
  switch (provider) {
    case "serve": return (await import("./targets/serve")).serveTarget;
    case "cloudflare": return (await import("./targets/cloudflare")).cloudflareTarget;
    case "docker": return (await import("./targets/docker")).dockerTarget;
    default: throw new Error(`no deploy adapter for provider "${provider}" (v1 supports: serve, cloudflare, docker)`);
  }
}
