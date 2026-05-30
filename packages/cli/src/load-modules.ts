/**
 * Load a `convex/` directory: esbuild-BUNDLE each module (schema + function files) then import the
 * bundle. Bundling resolves relative imports (incl. the conventional extensionless `./_generated/*`
 * value imports every app uses) at bundle time, identically on Bun / Node / any ESM runtime — so
 * loading no longer depends on the runtime's own resolver (plain Node's ESM rejects extensionless
 * specifiers with ERR_MODULE_NOT_FOUND; Bun accepts them). Bare deps (`@stackbase/*`, user npm
 * packages) stay EXTERNAL (`packages: "external"`) and resolve at import time from `node_modules`,
 * so engine singletons keep their identity. Extension-agnostic: a hand-authored dev project is
 * `.ts`, a `stackbase deploy`-pushed tree is `.js` — both bundle+load the same way.
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
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

/** The nearest ancestor of `startDir` that contains a `node_modules` dir; the bundled output goes
 *  under `<that>/node_modules/.cache/stackbase` so the bundle's external bare imports (`@stackbase/*`)
 *  resolve via Node's ancestor walk. Falls back to `startDir` if no `node_modules` ancestor exists. */
function resolveCacheDir(startDir: string): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "node_modules"))) break;
    const parent = dirname(dir);
    if (parent === dir) {
      dir = resolve(startDir);
      break;
    }
    dir = parent;
  }
  const cacheDir = join(dir, "node_modules", ".cache", "stackbase");
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/** Bundle one module (relative graph inlined, bare deps external), write it under the node_modules
 *  cache, and import it. Resolution happens at bundle time — runtime-agnostic. */
async function bundleAndImport(file: string, key: string, cacheDir: string): Promise<Record<string, unknown>> {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    packages: "external",
    format: "esm",
    platform: "node",
    write: false,
    sourcemap: "inline",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  const outFile = join(cacheDir, `${key.replace(/[\\/]/g, "__")}.mjs`);
  writeFileSync(outFile, code);
  return (await import(pathToFileURL(outFile).href + CACHE_BUST())) as Record<string, unknown>;
}

export async function loadConvexDir(dir: string): Promise<LoadedProject> {
  const absDir = resolve(dir);
  const entries = listConvexModuleFiles(absDir);
  const cacheDir = resolveCacheDir(absDir);

  const schemaFile = existsSync(join(absDir, "schema.ts")) ? "schema.ts" : "schema.js";
  const schemaModule = (await bundleAndImport(join(absDir, schemaFile), "schema", cacheDir)) as {
    default: SchemaDefinition;
  };

  const modules: Record<string, Record<string, unknown>> = {};
  for (const file of entries) {
    const key = moduleKeyForFile(file);
    modules[key] = await bundleAndImport(join(absDir, file), key, cacheDir);
  }

  return { schema: schemaModule.default, modules };
}
