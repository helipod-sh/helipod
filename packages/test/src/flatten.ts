import type { RegisteredFunction } from "@helipod/executor";

// Mirrors `DEFAULT_FUNCTIONS_DIR` from `@helipod/cli` (`packages/cli/src/functions-dir.ts`).
// `packages/test` doesn't depend on `@helipod/cli`, so the value is duplicated rather than
// imported — same pattern as `packages/vite/src/index.ts`'s own `DEFAULT_FUNCTIONS_DIR` mirror.
const DEFAULT_FUNCTIONS_ROOT = "helipod";

function isRegisteredFunction(v: unknown): v is RegisteredFunction {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string"
    && typeof (v as { handler?: unknown }).handler === "function";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `import.meta.glob("./helipod/**/*.ts")` keys come back prefixed with the glob's own leading
// path segments (`./helipod/messages.ts`, `../helipod/messages.ts`, etc.) — not just an
// extension to strip. Normalize to the same function-path root the codegen `api`/string refs use
// (relative to the app's functions root), so a glob-sourced module registers under the exact same
// path an explicit `{ "messages.ts": messages }` map would. `functionsRoot` is the ONE leading path
// segment to strip after the `./`/`../` prefix — it defaults to `DEFAULT_FUNCTIONS_ROOT` but a
// caller on a non-default `functionsDir` (via `helipod.config.ts`) must pass its actual value;
// there is no implicit fallback to any other name (including the legacy `convex/`), by design.
function normalizeModulePath(key: string, functionsRoot: string): string {
  const rootPattern = new RegExp(`^${escapeRegExp(functionsRoot)}/`);
  return key
    .replace(/^(\.\.?\/)+/, "")                 // strip leading ./  ../  ../../
    .replace(rootPattern, "")                   // strip the configured functions root, if present
    .replace(/\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/, ""); // strip extension
}

async function resolveModule(v: unknown): Promise<unknown> {
  return typeof v === "function" ? await (v as () => Promise<unknown>)() : v;
}

export interface FlattenedModules {
  moduleMap: Record<string, RegisteredFunction>;
  schemaModule: unknown | null;
  httpModule: unknown | null;
}

export async function flattenModules(
  modules: Record<string, unknown>,
  functionsRoot: string = DEFAULT_FUNCTIONS_ROOT,
): Promise<FlattenedModules> {
  const moduleMap: Record<string, RegisteredFunction> = {};
  let schemaModule: unknown | null = null;
  let httpModule: unknown | null = null;
  for (const [rawKey, rawVal] of Object.entries(modules)) {
    const modPath = normalizeModulePath(rawKey, functionsRoot);
    const mod = (await resolveModule(rawVal)) as Record<string, unknown>;
    const def = mod && typeof mod === "object" ? (mod as { default?: unknown }).default : undefined;
    if (modPath === "schema") { schemaModule = def ?? mod; continue; }
    // http.ts's default export is the `HttpRouter` itself (captured as `httpModule` for route
    // resolution), but its NAMED exports are the httpAction `RegisteredFunction`s the router's
    // routes point to — those still need to land in `moduleMap` as `http:<name>` so `dispatchHttp`
    // can resolve a route's handler VALUE back to a dispatchable path (no `continue` here, unlike
    // `schema` above: the loop below must still run for http.ts).
    if (modPath === "http") { httpModule = def ?? mod; }
    for (const [exportName, exportVal] of Object.entries(mod ?? {})) {
      if (isRegisteredFunction(exportVal)) moduleMap[`${modPath}:${exportName}`] = exportVal;
    }
  }
  return { moduleMap, schemaModule, httpModule };
}
