import { encodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { ExecutionLogEntry, IndexCatalog, LogFilter, LogSink } from "@stackbase/executor";
import type { FilterCond } from "./browse";

export type SchemaJsonLike = {
  tables: Record<string, { indexes: { indexDescriptor: string }[]; shardKey?: string | null }>;
};
export type ManifestLike = { path: string; functions: { name: string; type: string }[] }[];

export interface AdminDeps {
  runtime: EmbeddedRuntime;
  schemaJson: SchemaJsonLike;
  tableNumbers: Record<string, number>;
  manifest: ManifestLike;
  logSink: LogSink;
  /** Optional — when provided, component tables (not in schemaJson) are enumerated. */
  catalog?: IndexCatalog;
}

export interface TableInfo {
  name: string;
  indexes: string[];
  shardKey?: string;
  documentCount: number;
}

export interface TableDataPage {
  documents: JSONValue[];
  nextCursor: string | null;
  hasMore: boolean;
  scanCapped: boolean;
}

export class AdminApi {
  constructor(private readonly deps: AdminDeps) {}

  private tableId(table: string): string {
    const n = this.deps.tableNumbers[table];
    if (n === undefined) throw new Error(`unknown table: ${table}`);
    return encodeStorageTableId(n);
  }

  async listTables(): Promise<TableInfo[]> {
    const out: TableInfo[] = [];
    for (const name of Object.keys(this.deps.tableNumbers).sort()) {
      const schemaDef = this.deps.schemaJson.tables[name];
      let indexes: string[];
      let shardKey: string | undefined;
      if (schemaDef) {
        // App table — use the schema definition.
        indexes = schemaDef.indexes.map((i) => i.indexDescriptor);
        shardKey = schemaDef.shardKey ?? undefined;
      } else {
        // Component table — derive index info from the catalog.
        indexes = this.deps.catalog
          ? this.deps.catalog.indexesForTable(name).map((spec) => spec.index)
          : [];
        shardKey = undefined;
      }
      out.push({
        name,
        indexes,
        shardKey,
        documentCount: await this.deps.runtime.store.count(this.tableId(name)),
      });
    }
    return out;
  }

  async getTableData(
    table: string,
    opts: { cursor?: string | null; pageSize?: number; filter?: FilterCond[] } = {},
  ): Promise<TableDataPage> {
    const args: Record<string, unknown> = { table, cursor: opts.cursor ?? null };
    if (opts.pageSize !== undefined) args.pageSize = opts.pageSize;
    if (opts.filter !== undefined) args.filter = opts.filter;
    const r = await this.deps.runtime.runAdmin("_admin:browseTable", args as JSONValue);
    return r.value as TableDataPage;
  }

  listFunctions(): { path: string; kind: string }[] {
    return this.deps.manifest.flatMap((m) =>
      m.functions.map((f) => ({ path: `${m.path}:${f.name}`, kind: f.type })),
    );
  }

  queryLogs(filter?: LogFilter): ExecutionLogEntry[] {
    return this.deps.logSink.query(filter);
  }

  async runFunction(path: string, args: JSONValue): Promise<{ value: JSONValue; committed: boolean }> {
    const r = await this.deps.runtime.run(path, args);
    return { value: convexToJson(r.value as Value), committed: r.committed };
  }

  async patchDocument(id: string, fields: Record<string, JSONValue>): Promise<JSONValue> {
    const r = await this.deps.runtime.runSystem("_system:patchDocument", { id, fields });
    return convexToJson(r.value as Value);
  }

  async deleteDocument(id: string): Promise<void> {
    await this.deps.runtime.runSystem("_system:deleteDocument", { id });
  }

  async createDocument(table: string, fields: Record<string, JSONValue>): Promise<JSONValue> {
    const r = await this.deps.runtime.runSystem("_system:insertDocument", { table, fields });
    return convexToJson(r.value as Value);
  }
}
