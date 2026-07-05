import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HelipodConfig } from "@helipod/component";

const CACHE_BUST = () => `?t=${Date.now()}`;

export async function loadConfig(projectDir: string): Promise<HelipodConfig> {
  const path = (["helipod.config.ts", "helipod.config.js"] as const)
    .map((f) => join(projectDir, f))
    .find((p) => existsSync(p));

  if (!path) return { components: [] };

  const mod = (await import(pathToFileURL(path).href + CACHE_BUST())) as {
    default?: HelipodConfig;
  } & HelipodConfig;
  const cfg = (mod.default ?? mod) as HelipodConfig;
  return { components: cfg.components ?? [], deploy: cfg.deploy, functionsDir: cfg.functionsDir };
}
