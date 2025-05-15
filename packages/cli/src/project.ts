/**
 * Turn a loaded project (a live schema + function modules) into the artifacts the engine and
 * codegen need: the schema JSON, an index catalog (with table numbers assigned + an implicit
 * `by_creation` index per table), the `path:name → function` map, and the analyzed manifest.
 */
import { MemoryTableRegistry, encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog, type RegisteredFunction } from "@stackbase/executor";
import type { SchemaDefinition, SchemaDefinitionJSON } from "@stackbase/values";
import type { AnalyzedFunction, AnalyzedFunctionManifest } from "@stackbase/codegen";

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
}

function isRegisteredFunction(x: unknown): x is RegisteredFunction {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string" &&
    typeof (x as { handler?: unknown }).handler === "function"
  );
}

export function loadProject(loaded: LoadedProject): ProjectArtifacts {
  const schemaJson = loaded.schema.export();
  const registry = new MemoryTableRegistry();
  const catalog = new SimpleIndexCatalog();
  const tableNumbers: Record<string, number> = {};

  for (const [tableName, tableDef] of Object.entries(schemaJson.tables)) {
    const info = registry.allocate(tableName, { shardKey: tableDef.shardKey });
    tableNumbers[tableName] = info.tableNumber;
    catalog.addTable(tableName, info.tableNumber);
    // Implicit creation-order index, so table scans / default queries work.
    catalog.addIndex({
      table: tableName,
      tableNumber: info.tableNumber,
      index: DEFAULT_INDEX,
      fields: [],
      indexId: encodeStorageIndexId(info.tableNumber, DEFAULT_INDEX),
    });
    for (const idx of tableDef.indexes) {
      catalog.addIndex({
        table: tableName,
        tableNumber: info.tableNumber,
        index: idx.indexDescriptor,
        fields: idx.fields,
        indexId: encodeStorageIndexId(info.tableNumber, idx.indexDescriptor),
      });
    }
  }

  const moduleMap: Record<string, RegisteredFunction> = {};
  const manifest: AnalyzedFunctionManifest = [];
  for (const [path, exports] of Object.entries(loaded.modules)) {
    const functions: AnalyzedFunction[] = [];
    for (const [name, value] of Object.entries(exports)) {
      if (!isRegisteredFunction(value)) continue;
      moduleMap[`${path}:${name}`] = value;
      if (value.type === "query" || value.type === "mutation" || value.type === "action") {
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

  return { schemaJson, catalog, moduleMap, manifest, tableNumbers };
}
