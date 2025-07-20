/**
 * Turn a loaded project (a live schema + function modules) into the artifacts the engine and
 * codegen need: the schema JSON, an index catalog (with table numbers assigned + an implicit
 * `by_creation` index per table), the `path:name → function` map, and the analyzed manifest.
 */
import type { RegisteredFunction, ContextProvider } from "@stackbase/executor";
import type { SchemaDefinition, SchemaDefinitionJSON } from "@stackbase/values";
import type { AnalyzedFunction, AnalyzedFunctionManifest } from "@stackbase/codegen";
import { composeComponents, type ComponentDefinition, type BootContext, type Driver } from "@stackbase/component";
import type { SimpleIndexCatalog } from "@stackbase/executor";

export const DEFAULT_INDEX = "by_creation";

export interface LoadedProject {
  schema: SchemaDefinition;
  /** module path (without extension) → its exports (name → value). */
  modules: Record<string, Record<string, unknown>>;
}

export interface ProjectArtifacts {
  schemaJson: SchemaDefinitionJSON;
  catalog: SimpleIndexCatalog;
  moduleMap: Record<string, RegisteredFunction>;
  manifest: AnalyzedFunctionManifest;
  tableNumbers: Record<string, number>;
  componentNames: ReadonlySet<string>;
  contextProviders: ContextProvider[];
  /** Component boot steps (e.g. the scheduler's cron reconciler) — must run once at engine create. */
  bootSteps: { name: string; run: (ctx: BootContext) => Promise<void> }[];
  /**
   * Component drivers (e.g. the scheduler's event loop) — must be started at engine create for a
   * composed component's background work to actually run. Omitting this from
   * `createEmbeddedRuntime(...)` silently leaves drivers never started (jobs enqueue but never
   * dispatch) — see `../test/scheduler-e2e.test.ts` for the proof this wiring matters.
   */
  drivers: Driver[];
  /** The app's `http.ts` router, resolved to `path:name` function paths for dispatch. */
  routes: ResolvedRoute[];
}

/** A single `http.ts` route, with its handler resolved from a `RegisteredFunction` value to the
 * `path:name` string that `runtime.runHttpAction` looks up in `composed.moduleMap`. */
export interface ResolvedRoute {
  method: string;
  path?: string;
  pathPrefix?: string;
  handlerPath: string;
}

function isRegisteredFunction(x: unknown): x is RegisteredFunction {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string" &&
    typeof (x as { handler?: unknown }).handler === "function"
  );
}

export function loadProject(loaded: LoadedProject, components: ComponentDefinition[] = []): ProjectArtifacts {
  const schemaJson = loaded.schema.export();

  // Build the app's moduleMap + manifest from loaded.modules (codegen needs the app manifest).
  const appModuleMap: Record<string, RegisteredFunction> = {};
  const manifest: AnalyzedFunctionManifest = [];
  for (const [path, exports] of Object.entries(loaded.modules)) {
    const functions: AnalyzedFunction[] = [];
    for (const [name, value] of Object.entries(exports)) {
      if (!isRegisteredFunction(value)) continue;
      appModuleMap[`${path}:${name}`] = value;
      if (value.type === "query" || value.type === "mutation" || value.type === "action" || value.type === "httpAction") {
        functions.push({ name, type: value.type, visibility: "public" });
      }
    }
    if (functions.length > 0) {
      // Sort so codegen output is deterministic regardless of module-namespace key order
      // (which differs between Bun and Node).
      functions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      manifest.push({ path, functions });
    }
  }
  manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Compose app + components: allocates table numbers, merges module maps, collects context providers.
  const composed = composeComponents({ schemaJson, moduleMap: appModuleMap }, components);

  // Extract + resolve the `http.ts` router (if any): its `default` export is an `HttpRouter` whose
  // route handlers are `RegisteredFunction` VALUES — resolve each to its `path:name` function path
  // by identity over `appModuleMap` (the same objects the router references), for
  // `runtime.runHttpAction` to look up in `composed.moduleMap`.
  const routes: ResolvedRoute[] = [];
  const router = loaded.modules["http"]?.default as
    | { routes?: Array<{ method: string; path?: string; pathPrefix?: string; handler: RegisteredFunction }> }
    | undefined;
  if (router?.routes) {
    const pathByFn = new Map<RegisteredFunction, string>();
    for (const [path, fn] of Object.entries(appModuleMap)) pathByFn.set(fn, path);
    for (const r of router.routes) {
      const handlerPath = pathByFn.get(r.handler);
      if (!handlerPath) {
        const where = r.path ?? r.pathPrefix ?? "?";
        throw new Error(
          `http.route handler for "${where}" must be an exported httpAction (declare it as a named export of an app module)`,
        );
      }
      routes.push({
        method: r.method,
        ...(r.path !== undefined ? { path: r.path } : { pathPrefix: r.pathPrefix }),
        handlerPath,
      });
    }
  }

  return {
    schemaJson,
    catalog: composed.catalog,
    moduleMap: composed.moduleMap,
    manifest,
    tableNumbers: composed.tableNumbers,
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
    bootSteps: composed.bootSteps,
    drivers: composed.drivers,
    routes,
  };
}
