import type { ComponentDefinition } from "./define-component";

export interface TargetConfig {
  /** "serve" | "cloudflare" | "docker" | ... — selects the deploy adapter. */
  provider: string;
  /** Per-environment overrides, merged over the shared settings; --env selects one. */
  environments?: Record<string, Record<string, unknown>>;
  /** Provider-shared settings (provider-specific fields). */
  [k: string]: unknown;
}

export interface DeployConfig {
  /** Used when --target is omitted. Effective default is "serve" (resolved in @stackbase/deploy). */
  defaultTarget?: string;
  /** Keyed by target name (the --target value). */
  targets?: Record<string, TargetConfig>;
}

export interface StackbaseConfig {
  components: ComponentDefinition[];
  deploy?: DeployConfig;
}

export function defineConfig(config: StackbaseConfig): StackbaseConfig {
  return config;
}

/**
 * Deferred env-var read for deploy config authoring (Supabase-style). Reads at config-load time.
 * Treats an empty string as unset. Never throws — returns "" when unset and no fallback given, so a
 * config still RESOLVES with no `.env` present (the target's preflight is what fail-fasts on a
 * genuinely-required missing credential).
 */
export function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  return fallback ?? "";
}
