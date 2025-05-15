/**
 * Schema builders — `defineTable` / `defineSchema`. Produces both a runtime document
 * validator and a serializable `SchemaDefinitionJSON` for codegen + the engine.
 *
 * Reserves **scale-seam #1** (shard key): a table may mark one document field as its
 * shard key via `.shardKey(field)`. At Tier 0 it is metadata only (one shard,
 * `"default"`); at Tier 2 the router hashes that field to place a conversation on one
 * single-writer shard — see docs/dev/architecture/scalability-spectrum.md.
 */
import { v, type PropertyValidators, type Validator, type ValidatorJSON } from "./validator";

export interface IndexDefinitionJSON {
  indexDescriptor: string;
  fields: string[];
}
export interface SearchIndexDefinitionJSON {
  indexDescriptor: string;
  searchField: string;
  filterFields: string[];
}
export interface VectorIndexDefinitionJSON {
  indexDescriptor: string;
  vectorField: string;
  dimensions: number;
  filterFields: string[];
}
export interface TableDefinitionJSON {
  documentType: ValidatorJSON;
  indexes: IndexDefinitionJSON[];
  searchIndexes: SearchIndexDefinitionJSON[];
  vectorIndexes: VectorIndexDefinitionJSON[];
  /** The document field used as the shard key (seam #1), or null. */
  shardKey: string | null;
}
export interface SchemaDefinitionJSON {
  tables: Record<string, TableDefinitionJSON>;
  schemaValidation: boolean;
}

export class TableDefinition<F extends PropertyValidators = PropertyValidators> {
  readonly documentValidator: Validator<unknown>;
  private readonly indexes: IndexDefinitionJSON[] = [];
  private readonly searchIndexes: SearchIndexDefinitionJSON[] = [];
  private readonly vectorIndexes: VectorIndexDefinitionJSON[] = [];
  private shardKeyField: string | null = null;

  constructor(readonly fields: F) {
    this.documentValidator = v.object(fields) as unknown as Validator<unknown>;
  }

  index(name: string, fields: Array<Extract<keyof F, string>>): this {
    this.indexes.push({ indexDescriptor: name, fields: fields as string[] });
    return this;
  }

  searchIndex(
    name: string,
    opts: { searchField: Extract<keyof F, string>; filterFields?: Array<Extract<keyof F, string>> },
  ): this {
    this.searchIndexes.push({
      indexDescriptor: name,
      searchField: opts.searchField,
      filterFields: (opts.filterFields ?? []) as string[],
    });
    return this;
  }

  vectorIndex(
    name: string,
    opts: {
      vectorField: Extract<keyof F, string>;
      dimensions: number;
      filterFields?: Array<Extract<keyof F, string>>;
    },
  ): this {
    this.vectorIndexes.push({
      indexDescriptor: name,
      vectorField: opts.vectorField,
      dimensions: opts.dimensions,
      filterFields: (opts.filterFields ?? []) as string[],
    });
    return this;
  }

  /** Mark a field as this table's shard key (scale-seam #1). */
  shardKey(field: Extract<keyof F, string>): this {
    this.shardKeyField = field;
    return this;
  }

  export(): TableDefinitionJSON {
    return {
      documentType: this.documentValidator.toJSON(),
      indexes: this.indexes,
      searchIndexes: this.searchIndexes,
      vectorIndexes: this.vectorIndexes,
      shardKey: this.shardKeyField,
    };
  }
}

export function defineTable<F extends PropertyValidators>(fields: F): TableDefinition<F> {
  return new TableDefinition(fields);
}

export class SchemaDefinition<Tables extends Record<string, TableDefinition> = Record<string, TableDefinition>> {
  constructor(
    readonly tables: Tables,
    private readonly options: { schemaValidation?: boolean } = {},
  ) {}

  export(): SchemaDefinitionJSON {
    const tables: Record<string, TableDefinitionJSON> = {};
    for (const [name, table] of Object.entries(this.tables)) tables[name] = table.export();
    return { tables, schemaValidation: this.options.schemaValidation ?? true };
  }
}

export function defineSchema<Tables extends Record<string, TableDefinition>>(
  tables: Tables,
  options?: { schemaValidation?: boolean },
): SchemaDefinition<Tables> {
  return new SchemaDefinition(tables, options);
}
