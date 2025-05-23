import { MemoryTableRegistry, getFullTableName, encodeStorageIndexId } from "@stackbase/id-codec";
import { SimpleIndexCatalog } from "@stackbase/executor";
import type { SchemaDefinitionJSON } from "@stackbase/values";
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
): void {
  for (const [tableName, tableDef] of Object.entries(schemaJson.tables)) {
    const fullName = getFullTableName(tableName, componentName); // "" → bare; else "component/name"
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
  addSchema(input.app.schemaJson, "", registry, catalog, tableNumbers); // app = component zero (bare names)
  for (const c of input.components) addSchema(c.schema.export(), c.name, registry, catalog, tableNumbers);
  return { tableNumbers, catalog };
}
