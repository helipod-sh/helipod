import type { DeployConfig } from "@stackbase/component";
import type { ResolvedTarget } from "./types";

export interface ResolveInput {
  deploy: DeployConfig | undefined;
  target?: string;
  env?: string;
  inlineUrl?: string;
}

export function resolveDeploy(input: ResolveInput): ResolvedTarget | { error: string } {
  const env = input.env ?? "production";
  const targetName = input.target ?? input.deploy?.defaultTarget ?? "serve";
  const targets = input.deploy?.targets ?? {};
  let cfg = targets[targetName];

  if (!cfg) {
    if (targetName === "serve") {
      cfg = { provider: "serve" }; // synthesized default serve target (back-compat)
    } else {
      return { error: `unknown deploy target "${targetName}" — add it to stackbase.config.ts deploy.targets` };
    }
  }

  const { provider, environments, ...shared } = cfg;
  const envOverride = environments?.[env] ?? {};
  const settings: Record<string, unknown> = { ...shared, ...envOverride };
  if (input.inlineUrl) settings.url = input.inlineUrl;

  return { targetName, provider: String(provider), env, settings };
}
