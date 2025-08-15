import type { RegisteredFunction } from "@stackbase/executor";

function isRegisteredFunction(v: unknown): v is RegisteredFunction {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string"
    && "handler" in (v as object);
}

function stripExt(key: string): string {
  return key.replace(/\.(ts|tsx|js|jsx|mts|cts)$/, "");
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
    const modPath = stripExt(rawKey);
    const mod = (await resolveModule(rawVal)) as Record<string, unknown>;
    const def = mod && typeof mod === "object" ? (mod as { default?: unknown }).default : undefined;
    if (modPath === "schema") { schemaModule = def ?? mod; continue; }
    if (modPath === "http") { httpModule = def ?? mod; continue; }
    for (const [exportName, exportVal] of Object.entries(mod ?? {})) {
      if (isRegisteredFunction(exportVal)) moduleMap[`${modPath}:${exportName}`] = exportVal;
    }
  }
  return { moduleMap, schemaModule, httpModule };
}
