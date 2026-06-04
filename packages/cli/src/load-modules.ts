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
import { createHash } from "node:crypto";
import { readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
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

/** The nearest ancestor of `startDir` (walking up) that contains a `node_modules` dir. A real app's
 *  `convex/` sits under its project root, whose `node_modules` has `@stackbase/*`; that is what we
 *  find. Returns `undefined` if there is no `node_modules` ancestor at all (e.g. a throwaway temp-dir
 *  project) — the caller then falls back to the CLI's own root. */
function nearestNodeModulesRoot(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, "node_modules"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The bundled output goes under `<root>/node_modules/.cache/stackbase` so the bundle's external
 *  bare imports (`@stackbase/*`, user npm deps) resolve via Node's ancestor walk. Uses the app's own
 *  `node_modules` root when it has one; otherwise falls back to the CLI's own root (which always has
 *  `@stackbase/*`), so a `node_modules`-less project (e.g. a temp-dir test fixture) still loads. */
function resolveCacheDir(startDir: string): string {
  const dir =
    nearestNodeModulesRoot(startDir) ??
    // Fallback: the dir containing the CLI's own node_modules (found by walking up from this module).
    (nearestNodeModulesRoot(dirname(fileURLToPath(import.meta.url))) ?? resolve(startDir));
  // Namespace per convex-dir so two projects that resolve to the SAME node_modules ancestor never
  // collide on `<key>.mjs` (a shared path would let a parallel load of a different dir overwrite this
  // one's bundle between write and read — a silent wrong-module load).
  const ns = createHash("sha256").update(resolve(startDir)).digest("hex").slice(0, 16);
  const cacheDir = join(dir, "node_modules", ".cache", "stackbase", ns);
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/** Bundle one module and import it. The relative graph (`./_generated/*`, siblings) AND third-party
 *  npm deps are INLINED — esbuild does the CJS→ESM interop at bundle time (like the deploy bundler),
 *  so a convention like `import { parseExpression } from "cron-parser"` (a CJS package) works under
 *  native Node ESM too. Only `@stackbase/*` stays EXTERNAL: those are the engine's own packages, and
 *  they must resolve to the ONE instance the running engine loaded (inlining them would give each
 *  module its own copy and break singleton identity — `query`/`mutation`/the db registry). Node
 *  builtins are external automatically under `platform: "node"`. Resolution happens at bundle time —
 *  runtime-agnostic. */
async function bundleAndImport(file: string, key: string, cacheDir: string): Promise<Record<string, unknown>> {
  const result = await build({
    entryPoints: [file],
    bundle: true,
    external: ["@stackbase/*"],
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
