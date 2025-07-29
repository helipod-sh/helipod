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

export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const isModule = (f: string) =>
    (f.endsWith(".ts") || f.endsWith(".js")) &&
    !f.endsWith(".d.ts") &&
    !f.startsWith("_") &&
    f !== "schema.ts" &&
    f !== "schema.js";
  const entries = readdirSync(absDir).filter(isModule);

  const schemaFile = existsSync(join(absDir, "schema.ts")) ? "schema.ts" : "schema.js";
  const schemaModule = (await import(pathToFileURL(join(absDir, schemaFile)).href + CACHE_BUST())) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const path = file.replace(/\.(ts|js)$/, "");
    modules[path] = (await import(pathToFileURL(join(absDir, file)).href + CACHE_BUST())) as Record<string, unknown>;
  }

  return { schema: schemaModule.default, modules };
}
