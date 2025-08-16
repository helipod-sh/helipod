import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, type ComponentDefinition } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema, type SchemaDefinition, type SchemaDefinitionJSON } from "@stackbase/values";
import { mutation, type RegisteredFunction } from "@stackbase/executor";
import {
  STORAGE_TABLE,
  STORAGE_TABLE_NUMBER,
  storageTableDefinition,
  storageModules,
  storageContextProvider,
  storageReaper,
} from "@stackbase/storage";
import { FsBlobStore } from "@stackbase/blobstore-fs";
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

  // File storage is an ALWAYS-ON core feature (not opt-in) — inject its reserved `_storage` system
  // table into the schema BEFORE composing, mirroring `packages/cli`'s `loadProject` (see
  // `packages/cli/src/project.ts`), so the catalog/tableNumbers include it and `v.id("_storage")`
  // validates. Its table number is pinned via `existingTableNumbers` below so ids encode/decode
  // consistently.
  schemaJson.tables[STORAGE_TABLE] = storageTableDefinition.export();

  const composed = composeComponents({ schemaJson, moduleMap: flat.moduleMap }, opts.components ?? [], {
    [STORAGE_TABLE]: STORAGE_TABLE_NUMBER,
  });

  // Per-instance temp dir for the FS blob backend — removed in `cleanup`.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
  const blobStore = new FsBlobStore({ root: tempDir });

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

  // `create` can throw before `cleanup` is returned (a driver's `start()`, a boot step, or schema
  // setup failing) — in that case nothing would ever remove the temp dir. Remove it on failure so a
  // failed `createTestStackbase` never orphans a `sb-test-*` dir in the OS temp dir, then rethrow.
  let runtime: EmbeddedRuntime;
  try {
    runtime = await EmbeddedRuntime.create({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: composed.catalog,
      // `_storage:*` built-ins go in `modules` — the action-mode `ctx.storage` reaches them through
      // the trusted `invoke`, and the reaper driver through `runFunction`, both of which resolve
      // `modules` (not `systemModules`).
      modules: { ...composed.moduleMap, ...storageModules },
      systemModules,
      componentNames: composed.componentNames,
      contextProviders: [
        storageContextProvider(blobStore, { signingKey: "stackbase-test-signing-key" }),
        ...composed.contextProviders,
      ],
      policyRegistry: composed.policyRegistry,
      policyProviders: composed.policyProviders,
      relationRegistry: composed.relationRegistry,
      bootSteps: composed.bootSteps,
      drivers: [storageReaper(blobStore), ...composed.drivers],
      tableNumbers: composed.tableNumbers,
      now: opts.now,
    });
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  const cleanup = async () => {
    await runtime.stopDrivers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  };
  return {
    runtime,
    tableNumbers: composed.tableNumbers,
    schemaJson,
    cleanup,
    setRunFn: (fn) => { currentRunFn = fn; },
    takeRunResult: () => { const r = runResult; runResult = undefined; return r; },
  };
}
