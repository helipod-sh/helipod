/**
 * `PostgresDocStore` — the MVCC document log over Postgres, mirroring `SqliteDocStore`'s three
 * physical tables (see `packages/docstore-sqlite/src/sqlite-docstore.ts`):
 *
 *   documents(table_id, internal_id, ts, prev_ts, value)   -- one row per revision; value NULL = tombstone
 *   indexes  (index_id, key, ts, table_id, internal_id, deleted)  -- MVCC index entries
 *   persistence_globals(key, value)                          -- engine metadata KV
 *
 * Only `setupSchema` is implemented in this task. Every other `DocStore` method is a transitional
 * `throw new Error("not implemented")` stub with the correct signature — later tasks (2-5) replace
 * each one with a real implementation over the async `PgClient` seam.
 */
import type {
  ConflictStrategy,
  DocStore,
  DocumentLogEntry,
  DocumentValue,
  IndexWrite,
  Interval,
  LatestDocument,
  Order,
  PrevRevQuery,
  ResolvedDocument,
  SchemaSetupOptions,
  ShardId,
  TimestampRange,
  InternalDocumentId,
} from "@stackbase/docstore";
import { getPrevRevQueryKey } from "@stackbase/docstore";
import { encodeStorageTableId, decodeStorageTableId } from "@stackbase/id-codec";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";
import { SCHEMA_STATEMENTS } from "./schema";

function asBigInt(v: PgValue | undefined): bigint {
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}
function asBigIntOrNull(v: PgValue | undefined): bigint | null {
  return v === null || v === undefined ? null : asBigInt(v);
}

export class PostgresDocStore implements DocStore {
  constructor(private readonly db: PgClient) {}

  private serializeValue(value: DocumentValue): string {
    return JSON.stringify(convexToJson(value as Value));
  }
  private parseValue(text: string): DocumentValue {
    return jsonToConvex(JSON.parse(text) as JSONValue) as DocumentValue;
  }

  async setupSchema(_options?: SchemaSetupOptions): Promise<void> {
    // One idempotent statement per query() — portable across single-statement (PGlite) and
    // multi-statement (pg) drivers. Engine-authored text, no interpolation.
    for (const stmt of SCHEMA_STATEMENTS) await this.db.query(stmt);
  }

  async write(
    _documents: readonly DocumentLogEntry[],
    _indexUpdates: readonly IndexWrite[],
    _conflictStrategy: ConflictStrategy,
    _shardId?: ShardId,
  ): Promise<void> {
    throw new Error("not implemented");
  }

  async get(_id: InternalDocumentId, _readTimestamp?: bigint): Promise<LatestDocument | null> {
    throw new Error("not implemented");
  }

  async *index_scan(
    _indexId: string,
    _tableId: string,
    _readTimestamp: bigint,
    _interval: Interval,
    _order: Order,
    _limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    throw new Error("not implemented");
  }

  async *load_documents(_range: TimestampRange, _order: Order): AsyncGenerator<DocumentLogEntry> {
    throw new Error("not implemented");
  }

  async previous_revisions(_queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>> {
    throw new Error("not implemented");
  }

  async scan(_tableId: string, _readTimestamp?: bigint): Promise<LatestDocument[]> {
    throw new Error("not implemented");
  }

  async count(_tableId: string): Promise<number> {
    throw new Error("not implemented");
  }

  async maxTimestamp(): Promise<bigint> {
    throw new Error("not implemented");
  }

  async getGlobal(_key: string): Promise<JSONValue | null> {
    throw new Error("not implemented");
  }

  async writeGlobal(_key: string, _value: JSONValue): Promise<void> {
    throw new Error("not implemented");
  }

  async writeGlobalIfAbsent(_key: string, _value: JSONValue): Promise<boolean> {
    throw new Error("not implemented");
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
