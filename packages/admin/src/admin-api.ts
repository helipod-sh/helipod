import { encodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { ExecutionLogEntry, LogFilter, LogSink } from "@stackbase/executor";

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
}

export interface TableInfo {
  name: string;
  indexes: string[];
  shardKey?: string;
  documentCount: number;
}

export interface TableDataPage {
  documents: JSONValue[];
  total: number;
  page: number;
  pageSize: number;
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
    for (const [name, def] of Object.entries(this.deps.schemaJson.tables)) {
      out.push({
        name,
        indexes: def.indexes.map((i) => i.indexDescriptor),
        shardKey: def.shardKey ?? undefined,
        documentCount: await this.deps.runtime.store.count(this.tableId(name)),
      });
    }
    return out;
  }

  async getTableData(
    table: string,
    opts: { page?: number; pageSize?: number; filter?: string } = {},
  ): Promise<TableDataPage> {
    const tableId = this.tableId(table);
    const page = opts.page ?? 0;
    const pageSize = opts.pageSize ?? 50;
    const docs = (await this.deps.runtime.store.scan(tableId)).map(
      (d) => d.value.value as Record<string, Value>,
    );

    let rows = docs;
    if (opts.filter && opts.filter.includes(":")) {
      const idx = opts.filter.indexOf(":");
      const field = opts.filter.slice(0, idx);
      const want = opts.filter.slice(idx + 1);
      rows = rows.filter((d) => String(d[field] ?? "") === want);
    }

    const total = rows.length;
    const start = page * pageSize;
    const documents = rows.slice(start, start + pageSize).map((d) => convexToJson(d));
    return { documents, total, page, pageSize };
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
