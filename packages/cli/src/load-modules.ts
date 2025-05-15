/**
 * Load a `convex/` directory: dynamically import `schema.ts` (default export) and each
 * function module. Relies on the runtime importing TypeScript directly — Bun does this
 * natively (the primary target); under Node use `--experimental-strip-types` or a loader.
 */
import { readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SchemaDefinition } from "@stackbase/values";
import type { LoadedProject } from "./project";

const CACHE_BUST = () => `?t=${Date.now()}`;

export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const entries = readdirSync(absDir).filter(
    (f) => f.endsWith(".ts") && !f.startsWith("_") && f !== "schema.ts",
  );

  const schemaModule = (await import(pathToFileURL(join(absDir, "schema.ts")).href + CACHE_BUST())) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const path = basename(file, ".ts");
    modules[path] = (await import(pathToFileURL(join(absDir, file)).href + CACHE_BUST())) as Record<string, unknown>;
  }

  return { schema: schemaModule.default, modules };
}
