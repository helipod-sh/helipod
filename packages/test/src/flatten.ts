import type { RegisteredFunction } from "@stackbase/executor";

function isRegisteredFunction(v: unknown): v is RegisteredFunction {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string"
    && typeof (v as { handler?: unknown }).handler === "function";
}

// `import.meta.glob("./convex/**/*.ts")` keys come back prefixed with the glob's own leading
// path segments (`./convex/messages.ts`, `../convex/messages.ts`, etc.) — not just an extension to
// strip. Normalize to the same function-path root the codegen `api`/string refs use (relative to
// the `convex/` functions root), so a glob-sourced module registers under the exact same path an
// explicit `{ "messages.ts": messages }` map would.
function normalizeModulePath(key: string): string {
  return key
    .replace(/^(\.\.?\/)+/, "")                 // strip leading ./  ../  ../../
    .replace(/^convex\//, "")                   // strip the conventional convex/ functions root
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
): Promise<FlattenedModules> {
  const moduleMap: Record<string, RegisteredFunction> = {};
  let schemaModule: unknown | null = null;
  let httpModule: unknown | null = null;
  for (const [rawKey, rawVal] of Object.entries(modules)) {
    const modPath = normalizeModulePath(rawKey);
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
