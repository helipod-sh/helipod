import type { DeployTarget } from "./types";

/** Lazy dynamic-import dispatch — a provider's adapter module loads only when it is used. */
export async function loadTarget(provider: string): Promise<DeployTarget> {
  switch (provider) {
    case "serve": return (await import("./targets/serve")).serveTarget;
    // @ts-expect-error — cloudflareTarget exists in Task 7
    case "cloudflare": return (await import("./targets/cloudflare")).cloudflareTarget;
    // @ts-expect-error — dockerTarget exists in Task 8
    case "docker": return (await import("./targets/docker")).dockerTarget;
    default: throw new Error(`no deploy adapter for provider "${provider}" (v1 supports: serve, cloudflare, docker)`);
  }
}
