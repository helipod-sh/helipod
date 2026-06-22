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
  /** Column-per-field stores (D1/`.global()`) render this as `CREATE UNIQUE INDEX`. Omitted (not
   *  `false`) for a plain index, so existing exported JSON is byte-for-byte unchanged. */
  unique?: boolean;
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
export interface RelationJSON {
  /** Relation name used in policies (e.g. "sharedWith"). */
  name: string;
  /** The child table holding the back-reference rows. */
  table: string;
  /** The child field that references THIS table's `_id`. */
  field: string;
}
export interface TableDefinitionJSON {
  documentType: ValidatorJSON;
  indexes: IndexDefinitionJSON[];
  searchIndexes: SearchIndexDefinitionJSON[];
  vectorIndexes: VectorIndexDefinitionJSON[];
  /** The document field used as the shard key (seam #1), or null. */
  shardKey: string | null;
  /** D1-resident global table (`.global()`). Omitted (not `false`) for a normal table, so existing
   *  exported JSON is byte-for-byte unchanged. Mutually exclusive with `shardKey`. */
  global?: boolean;
  /** Declared to-many relations (scale-seam #2 / row-policy relation predicates). */
  relations: RelationJSON[];
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
  private globalMode = false;
  private readonly relationsList: RelationJSON[] = [];

  constructor(readonly fields: F) {
    this.documentValidator = v.object(fields) as unknown as Validator<unknown>;
  }

  index(name: string, fields: Array<Extract<keyof F, string>>, opts?: { unique?: boolean }): this {
    this.indexes.push({ indexDescriptor: name, fields: fields as string[], ...(opts?.unique ? { unique: true } : {}) });
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
    if (this.globalMode) throw new Error("a table cannot be both .shardKey() and .global() (global data is not sharded)");
    this.shardKeyField = field;
    return this;
  }

  /** Mark this table as D1-resident global data (cross-shard, global-unique). Mutually exclusive
   *  with `.shardKey()`. */
  global(): this {
    if (this.shardKeyField !== null) throw new Error("a table cannot be both .global() and .shardKey() (global data is not sharded)");
    this.globalMode = true;
    return this;
  }

  /** Declare a to-many relation: rows in `table` whose `field` references this table's `_id`. */
  relation(name: string, spec: { table: string; field: string }): this {
    this.relationsList.push({ name, table: spec.table, field: spec.field });
    return this;
  }

  export(): TableDefinitionJSON {
    return {
      documentType: this.documentValidator.toJSON(),
      indexes: this.indexes,
      searchIndexes: this.searchIndexes,
      vectorIndexes: this.vectorIndexes,
      shardKey: this.shardKeyField,
      ...(this.globalMode ? { global: true } : {}),
      relations: this.relationsList,
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
