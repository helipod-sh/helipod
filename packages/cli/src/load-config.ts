import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { StackbaseConfig } from "@stackbase/component";

const CACHE_BUST = () => `?t=${Date.now()}`;

export async function loadConfig(projectDir: string): Promise<StackbaseConfig> {
  const path = (["stackbase.config.ts", "stackbase.config.js"] as const)
    .map((f) => join(projectDir, f))
    .find((p) => existsSync(p));

  if (!path) return { components: [] };

  const mod = (await import(pathToFileURL(path).href + CACHE_BUST())) as {
    default?: StackbaseConfig;
  } & StackbaseConfig;
  const cfg = (mod.default ?? mod) as StackbaseConfig;
  return { components: cfg.components ?? [], deploy: cfg.deploy, functionsDir: cfg.functionsDir };
}
