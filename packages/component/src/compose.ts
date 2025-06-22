import { MemoryTableRegistry, getFullTableName, encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog } from "@stackbase/executor";
import type { RegisteredFunction, ContextProvider, TablePolicy, PolicyContextProvider, RelationRegistry } from "@stackbase/executor";
import type { SchemaDefinitionJSON, TableDefinitionJSON } from "@stackbase/values";
import type { ComponentDefinition } from "./define-component";

const DEFAULT_INDEX = "by_creation";

export interface ComposeInput {
  app: { schemaJson: SchemaDefinitionJSON };
  components: ComponentDefinition[];
}
export interface ComposedTables {
  tableNumbers: Record<string, number>;
  catalog: SimpleIndexCatalog;
}

function addSchema(
  schemaJson: SchemaDefinitionJSON,
  componentName: string,
  registry: MemoryTableRegistry,
  catalog: SimpleIndexCatalog,
  tableNumbers: Record<string, number>,
  seen: Set<string>,
): void {
  for (const [tableName, tableDef] of Object.entries(schemaJson.tables)) {
    if (tableName.includes("/") || tableName.includes(":"))
      throw new Error(`table name "${tableName}" may not contain "/" or ":"`);
    const fullName = getFullTableName(tableName, componentName); // "" → bare; else "component/name"
    if (seen.has(fullName)) throw new Error(`duplicate table: ${fullName}`);
    seen.add(fullName);
    const info = registry.allocate(fullName, { shardKey: tableDef.shardKey });
    tableNumbers[fullName] = info.tableNumber;
    catalog.addTable(fullName, info.tableNumber);
    catalog.addIndex({
      table: fullName,
      tableNumber: info.tableNumber,
      index: DEFAULT_INDEX,
      fields: [],
      indexId: encodeStorageIndexId(info.tableNumber, DEFAULT_INDEX),
    });
    for (const idx of tableDef.indexes) {
      catalog.addIndex({
        table: fullName,
        tableNumber: info.tableNumber,
        index: idx.indexDescriptor,
        fields: idx.fields,
        indexId: encodeStorageIndexId(info.tableNumber, idx.indexDescriptor),
      });
    }
  }
}

export function composeTables(input: ComposeInput): ComposedTables {
  const registry = new MemoryTableRegistry();
  const catalog = new SimpleIndexCatalog();
  const tableNumbers: Record<string, number> = {};
  const seen = new Set<string>();
  addSchema(input.app.schemaJson, "", registry, catalog, tableNumbers, seen); // app = component zero (bare names)
  for (const c of input.components) addSchema(c.schema.export(), c.name, registry, catalog, tableNumbers, seen);
  return { tableNumbers, catalog };
}

/** The namespace a function path runs in: its component name, or "" for an app module. */
export function namespaceForPath(path: string, componentNames: ReadonlySet<string>): string {
  const i = path.indexOf(":");
  if (i === -1) return "";
  const prefix = path.slice(0, i);
  return componentNames.has(prefix) ? prefix : "";
}

export function composeModules(
  appModules: Record<string, RegisteredFunction>,
  components: ComponentDefinition[],
): Record<string, RegisteredFunction> {
  const out: Record<string, RegisteredFunction> = { ...appModules };
  const appPrefixes = new Set(
    Object.keys(appModules).map((k) => {
      const i = k.indexOf(":");
      return i === -1 ? k : k.slice(0, i);
    }),
  );
  const seen = new Set<string>();
  for (const c of components) {
    if (seen.has(c.name)) throw new Error(`duplicate component name: ${c.name}`);
    if (appPrefixes.has(c.name)) throw new Error(`component name "${c.name}" collides with an app module`);
    seen.add(c.name);
    for (const [fnName, fn] of Object.entries(c.modules)) out[`${c.name}:${fnName}`] = fn;
  }
  return out;
}

export interface ComposedProject {
  catalog: SimpleIndexCatalog;
  moduleMap: Record<string, RegisteredFunction>;
  componentNames: ReadonlySet<string>;
  tableNumbers: Record<string, number>;
  contextProviders: ContextProvider[];
  policyRegistry: ReadonlyMap<string, TablePolicy>;
  policyProviders: PolicyContextProvider[];
  relationRegistry: RelationRegistry;
}

function buildRelationRegistry(
  appSchema: SchemaDefinitionJSON,
  components: ComponentDefinition[],
): RelationRegistry {
  // Resolve every table's JSON keyed by its full name (app tables are bare; components prefixed).
  const tableJson: Record<string, TableDefinitionJSON> = {};
  for (const [name, tdef] of Object.entries(appSchema.tables)) tableJson[getFullTableName(name, "")] = tdef;
  for (const c of components)
    for (const [name, tdef] of Object.entries(c.schema.export().tables)) tableJson[getFullTableName(name, c.name)] = tdef;

  const toMany = new Map<string, Map<string, { table: string; field: string }>>();
  const toOne = new Map<string, Map<string, string>>();

  for (const [full, tdef] of Object.entries(tableJson)) {
    // to-one: v.id fields on this table
    if (tdef.documentType.type === "object") {
      const m = new Map<string, string>();
      for (const [fieldName, f] of Object.entries(tdef.documentType.value))
        if (f.fieldType.type === "id") m.set(fieldName, f.fieldType.tableName);
      if (m.size > 0) toOne.set(full, m);
    }
    // to-many: declared relations (child tables are app/root tables in v1)
    for (const rel of tdef.relations ?? []) {
      const childFull = getFullTableName(rel.table, "");
      const child = tableJson[childFull];
      if (!child) throw new Error(`relation "${rel.name}" on "${full}" references unknown table "${rel.table}"`);
      if (child.documentType.type === "object" && !(rel.field in child.documentType.value))
        throw new Error(`relation "${rel.name}" on "${full}" references unknown field "${rel.field}" on "${rel.table}"`);
      if (!toMany.has(full)) toMany.set(full, new Map());
      toMany.get(full)!.set(rel.name, { table: childFull, field: rel.field });
    }
  }
  return { toMany, toOne };
}

export function composeComponents(
  app: { schemaJson: SchemaDefinitionJSON; moduleMap: Record<string, RegisteredFunction> },
  components: ComponentDefinition[],
): ComposedProject {
  const names = new Set(components.map((c) => c.name));
  for (const c of components) for (const req of c.requires ?? []) {
    if (!names.has(req)) throw new Error(`component "${c.name}" requires "${req}", which is not enabled`);
  }
  const { tableNumbers, catalog } = composeTables({ app: { schemaJson: app.schemaJson }, components });
  const moduleMap = composeModules(app.moduleMap, components);
  const contextProviders: ContextProvider[] = components
    .filter((c) => c.context)
    .map((c) => ({ name: c.name, namespace: c.name, build: c.context! }));
  const policyRegistry = new Map<string, TablePolicy>();
  const policyProviders: PolicyContextProvider[] = [];
  for (const c of components) {
    for (const [table, policy] of Object.entries(c.policies ?? {})) {
      const key = getFullTableName(table, ""); // policies gate app (root) tables in v1
      if (tableNumbers[key] === undefined) throw new Error(`component "${c.name}" declares a policy for unknown table "${table}"`);
      if (policyRegistry.has(key)) throw new Error(`duplicate policy for table "${table}"`);
      policyRegistry.set(key, policy);
    }
    if (c.policyContext) policyProviders.push({ namespace: c.name, build: c.policyContext });
  }
  const relationRegistry = buildRelationRegistry(app.schemaJson, components);
  return { catalog, moduleMap, componentNames: new Set(components.map((c) => c.name)), tableNumbers, contextProviders, policyRegistry, policyProviders, relationRegistry };
}
