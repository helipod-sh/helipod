import { encodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, type JSONValue, type Value, type ValidatorJSON } from "@stackbase/values";
import {
  applyDumpToStore,
  exportDumpFromStore,
  parseDump,
  type ImportableDocStore,
  type MigrationDump,
} from "@stackbase/docstore";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { ExecutionLogEntry, IndexCatalog, LogFilter, LogSink } from "@stackbase/executor";
import type { FilterCond } from "./browse";

export type SchemaJsonLike = {
  tables: Record<
    string,
    {
      indexes: { indexDescriptor: string }[];
      shardKey?: string | null;
      // The real schema always sets this (see SchemaDefinitionJSON in @stackbase/values); optional
      // here only because callers that build a SchemaJsonLike by hand (tests, component tables with
      // no app-level schema entry) don't always carry it. `stackbase deploy`'s schema diff reads it
      // off the live `AdminApi.getSchema()` snapshot — see DeployDeps["current"] in deploy-apply.ts.
      documentType?: ValidatorJSON;
    }
  >;
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

  /** Swap the schema/tableNumbers/manifest the data browser + validation read — after a live deploy. */
  setSchema(schemaJson: AdminDeps["schemaJson"], tableNumbers: Record<string, number>, manifest: AdminDeps["manifest"]): void {
    this.deps.schemaJson = schemaJson;
    this.deps.tableNumbers = tableNumbers;
    this.deps.manifest = manifest;
  }

  /** The live schema + tableNumbers — a deploy diffs its new schema against this. */
  getSchema(): { schemaJson: AdminDeps["schemaJson"]; tableNumbers: Record<string, number> } {
    return { schemaJson: this.deps.schemaJson, tableNumbers: this.deps.tableNumbers };
  }

  // ── Data migration (Slice 5 — portable ⇄ DO-native) ───────────────────────────────────────────

  /**
   * Export this deployment's full current materialized state to a portable {@link MigrationDump}
   * (every live document + every current index row + the table-number map). Reachable via
   * `GET /_admin/export` on BOTH the container `serve` path AND the Cloudflare DO host (both funnel
   * `/_admin/*` through the same handler). Uses the store's `dumpCurrentState()` primitive — the same
   * one the R2 snapshot mechanism uses — so ids and `_creationTime` round-trip verbatim.
   */
  async exportDump(): Promise<MigrationDump> {
    const deploymentId = (await this.deps.runtime.store.getGlobal("fleet:deploymentId")) as string | null;
    return exportDumpFromStore(this.deps.runtime.store, { tableNumbers: this.deps.tableNumbers, deploymentId });
  }

  /**
   * Import a {@link MigrationDump} into this deployment. Runs the table-number collision guard FIRST
   * (refuses a dump whose numbers would serve rows under the wrong table), applies the rows via the
   * store's `write(..., "Overwrite")` overlay, then advances the runtime's timestamp oracle to the
   * new high-water mark — without which a freshly-booted runtime keeps reading at `ts <= 0` and sees
   * nothing. Intended for a FRESH target deployment (see `applyDumpToStore`'s note on merge semantics).
   */
  async importDump(dumpJson: string | unknown): Promise<{ ok: true; imported: { documents: number; indexUpdates: number } }> {
    const dump = parseDump(dumpJson);
    const imported = await applyDumpToStore(
      this.deps.runtime.store as unknown as ImportableDocStore,
      dump,
      this.deps.tableNumbers,
    );
    // Re-floor the read/write snapshot at the imported high-water mark (the same seeding a boot does).
    this.deps.runtime.observeTimestamp(await this.deps.runtime.store.maxTimestamp());
    return { ok: true, imported };
  }
}
