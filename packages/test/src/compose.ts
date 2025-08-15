import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type ComponentDefinition } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, type SchemaDefinition, type SchemaDefinitionJSON } from "@stackbase/values";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import { flattenModules } from "./flatten";

export interface CreateTestOptions {
  modules: Record<string, unknown>;
  components?: ComponentDefinition[];
  schema?: SchemaDefinition | "auto" | false;
  now?: () => number;
}

export interface BuiltRuntime {
  runtime: EmbeddedRuntime;
  tableNumbers: Record<string, number>;
  schemaJson: SchemaDefinitionJSON;
  cleanup: () => Promise<void>;
  /** Sets the callback `_test:_run`'s handler invokes with a full db-writer `ctx`. */
  setRunFn: (fn: ((ctx: unknown) => Promise<unknown>) | null) => void;
  /** Reads back (and clears) the value the last `setRunFn` callback returned. */
  takeRunResult: () => unknown;
}

export async function buildRuntime(opts: CreateTestOptions): Promise<BuiltRuntime> {
  const flat = await flattenModules(opts.modules);
  // Resolve the schema: explicit option wins; else the schema.ts module; else empty.
  const schemaDef: SchemaDefinition =
    // `opts.schema &&` already excludes `false` (falsy) as well as `undefined`, so an explicit
    // `!== false` check afterward is both redundant and a TS error (no overlap once narrowed).
    opts.schema && opts.schema !== "auto"
      ? opts.schema
      : (flat.schemaModule as SchemaDefinition | null) ?? defineSchema({});
  const schemaJson = schemaDef.export();

  const composed = composeComponents({ schemaJson, moduleMap: flat.moduleMap }, opts.components ?? []);

  // `_test:_run` — the mechanism behind `t.run(fn)`: a system mutation whose handler invokes
  // whatever callback `t.run` most recently parked in `currentRunFn`, giving test code a full
  // db-writer `ctx` inside a real transaction without having to define an app function for it.
  let currentRunFn: ((ctx: unknown) => Promise<unknown>) | null = null;
  let runResult: unknown = undefined;
  const systemModules = {
    "_test:_run": mutation(async (ctx: unknown) => {
      if (!currentRunFn) throw new Error("_test:_run invoked with no callback set");
      runResult = await currentRunFn(ctx);
      return null;
    }),
  };

  const runtime = await EmbeddedRuntime.create({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: composed.catalog,
    modules: composed.moduleMap,
    systemModules,
    componentNames: composed.componentNames,
    contextProviders: composed.contextProviders,
    policyRegistry: composed.policyRegistry,
    policyProviders: composed.policyProviders,
    relationRegistry: composed.relationRegistry,
    bootSteps: composed.bootSteps,
    drivers: composed.drivers,
    tableNumbers: composed.tableNumbers,
    now: opts.now,
  });

  const cleanup = async () => { await runtime.stopDrivers(); };
  return {
    runtime,
    tableNumbers: composed.tableNumbers,
    schemaJson,
    cleanup,
    setRunFn: (fn) => { currentRunFn = fn; },
    takeRunResult: () => { const r = runResult; runResult = undefined; return r; },
  };
}
