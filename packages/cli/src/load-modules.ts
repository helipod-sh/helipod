/**
 * Load a `convex/` directory: dynamically import `schema.{ts,js}` (default export) and each
 * function module. Relies on the runtime importing TypeScript directly — Bun does this
 * natively (the primary target); under Node use `--experimental-strip-types` or a loader.
 * Extension-agnostic: a hand-authored dev project is `.ts`, but the tree `stackbase deploy`
 * pushes is transpiled `.js` — both load the same way.
 */
import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { SchemaDefinition } from "@stackbase/values";
import type { LoadedProject } from "./project";

const CACHE_BUST = () => `?t=${Date.now()}`;

/** The module key `stackbase` uses to address a convex/ function file — strips the extension. */
export function moduleKeyForFile(file: string): string {
  return file.replace(/\.(ts|js)$/, "");
}

/** List a convex/ dir's function module files (excludes schema.{ts,js}, `_`-prefixed, and .d.ts). */
export function listConvexModuleFiles(absDir: string): string[] {
  const isModule = (f: string) =>
    (f.endsWith(".ts") || f.endsWith(".js")) &&
    !f.endsWith(".d.ts") &&
    !f.startsWith("_") &&
    f !== "schema.ts" &&
    f !== "schema.js";
  return readdirSync(absDir).filter(isModule);
}

export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const entries = listConvexModuleFiles(absDir);

  const schemaFile = existsSync(join(absDir, "schema.ts")) ? "schema.ts" : "schema.js";
  const schemaModule = (await import(pathToFileURL(join(absDir, schemaFile)).href + CACHE_BUST())) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const path = moduleKeyForFile(file);
    modules[path] = (await import(pathToFileURL(join(absDir, file)).href + CACHE_BUST())) as Record<string, unknown>;
  }

  return { schema: schemaModule.default, modules };
}
