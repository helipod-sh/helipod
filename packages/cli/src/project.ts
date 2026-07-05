/**
 * Turn a loaded project (a live schema + function modules) into the artifacts the engine and
 * codegen need: the schema JSON, an index catalog (with table numbers assigned + an implicit
 * `by_creation` index per table), the `path:name → function` map, and the analyzed manifest.
 */
import type { RegisteredFunction, ContextProvider } from "@helipod/executor";
import type { SchemaDefinition, SchemaDefinitionJSON } from "@helipod/values";
import type { AnalyzedFunction, AnalyzedFunctionManifest, ShardByDeclaration } from "@helipod/codegen";
import { validatorToTsType, assertShardByDeclarations } from "@helipod/codegen";
import { composeComponents, type ComponentDefinition, type BootContext, type Driver, type ResolvedComponentRoute } from "@helipod/component";
import type { SimpleIndexCatalog } from "@helipod/executor";
import { STORAGE_TABLE, STORAGE_TABLE_NUMBER, storageTableDefinition } from "@helipod/storage";

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
  /** Reserved engine routes contributed by composed components (e.g. auth's `/api/auth/oauth/*`). */
  componentRoutes: ResolvedComponentRoute[];
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

export function loadProject(
  loaded: LoadedProject,
  components: ComponentDefinition[] = [],
  existingTableNumbers?: Record<string, number>,
): ProjectArtifacts {
  const schemaJson = loaded.schema.export();

  // File storage is an ALWAYS-ON core feature (not read from `helipod.config.ts`): inject its
  // reserved app-root `_storage` system table into the composed schema so it flows through the same
  // path every other table does — a catalog entry + `by_creation` index (so the `_storage:*`
  // built-ins' `ctx.db` ops resolve) and a stable tableNumber. Seeding the registry with
  // `{ _storage: STORAGE_TABLE_NUMBER }` (below) `preassign`s that number so `_storage` decodes back
  // to the same table forever and never collides with an app/component table. Doing this in the
  // SHARED load path (not just boot) keeps `helipod deploy`'s additive-schema diff consistent:
  // the live schema and every re-pushed schema both carry `_storage`, so a deploy never sees it as
  // a "dropped table". Codegen already emits `_storage` from `@helipod/values`' canonical system
  // defs and filters it out of the app schema, so this injection does not double it there.
  schemaJson.tables[STORAGE_TABLE] = storageTableDefinition.export();

  // Build the app's moduleMap + manifest from loaded.modules (codegen needs the app manifest).
  const appModuleMap: Record<string, RegisteredFunction> = {};
  const manifest: AnalyzedFunctionManifest = [];
  // Shards B2a (D7): collected alongside the manifest loop below — every mutation whose `shardBy`
  // is a plain arg-name STRING (a resolver function is opaque to codegen; it falls through to the
  // kernel guards at runtime, same as always). Cross-checked against `schemaJson` once the loop
  // finishes (see `assertShardByDeclarations` below).
  const shardByDeclarations: ShardByDeclaration[] = [];
  for (const [path, exports] of Object.entries(loaded.modules)) {
    const functions: AnalyzedFunction[] = [];
    for (const [name, value] of Object.entries(exports)) {
      if (!isRegisteredFunction(value)) continue;
      appModuleMap[`${path}:${name}`] = value;
      if (value.type === "query" || value.type === "mutation" || value.type === "action" || value.type === "httpAction") {
        functions.push({
          name,
          type: value.type,
          visibility: "public",
          argsType: value.argsJson ? validatorToTsType(value.argsJson) : undefined,
          // D10: mirrors argsType exactly. A function without `returns` stays `undefined` here,
          // which `generateApi`/`generateInternalApi` (generate.ts:133) fall back to `any` for —
          // the documented gap until the inference follow-on (see functions.ts's returnsJson doc).
          returnsType: value.returnsJson ? validatorToTsType(value.returnsJson) : undefined,
        });
      }
      if (value.type === "mutation" && typeof value.shardBy === "string") {
        shardByDeclarations.push({ functionPath: `${path}:${name}`, argName: value.shardBy, argsJson: value.argsJson });
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
  assertShardByDeclarations(schemaJson, shardByDeclarations);

  // Compose app + components: allocates table numbers, merges module maps, collects context providers.
  // Seed `_storage` at its reserved number BEFORE allocation so `registry.preassign` pins it (an
  // existing deploy's numbers, if any, still win — they carry the same `_storage: 20`).
  const composed = composeComponents({ schemaJson, moduleMap: appModuleMap }, components, {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
    ...existingTableNumbers,
  });

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
    componentRoutes: composed.componentRoutes,
  };
}
