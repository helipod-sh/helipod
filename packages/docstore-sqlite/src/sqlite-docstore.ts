/**
 * `SqliteDocStore` — the MVCC document log over three physical tables:
 *
 *   documents(table_id, internal_id, ts, prev_ts, value)   -- one row per revision; value NULL = tombstone
 *   indexes  (index_id, key, ts, table_id, internal_id, deleted)  -- MVCC index entries
 *   persistence_globals(key, value)                          -- engine metadata KV
 *
 * Snapshot reads pick the newest revision with `ts <= readTimestamp`. Index scans pick,
 * per key in the byte interval, the newest index entry `<= readTimestamp`, skip deletions,
 * and resolve the pointed document at the same timestamp.
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
import { encodeStorageTableId, decodeStorageTableId, DEFAULT_SHARD } from "@stackbase/id-codec";
import { convexToJson, jsonToConvex, type JSONValue, type Value } from "@stackbase/values";
import type { DatabaseAdapter, PreparedStatement, SqlRow, SqlValue } from "./adapter";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS documents (
  table_id    TEXT NOT NULL,
  internal_id BLOB NOT NULL,
  ts          INTEGER NOT NULL,
  prev_ts     INTEGER,
  value       TEXT,
  PRIMARY KEY (table_id, internal_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS documents_by_ts ON documents (ts);

CREATE TABLE IF NOT EXISTS indexes (
  index_id    TEXT NOT NULL,
  key         BLOB NOT NULL,
  ts          INTEGER NOT NULL,
  table_id    TEXT,
  internal_id BLOB,
  deleted     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (index_id, key, ts)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS persistence_globals (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`;

function asBigInt(v: SqlValue | undefined): bigint {
  return typeof v === "bigint" ? v : BigInt(v as number);
}
function asBigIntOrNull(v: SqlValue | undefined): bigint | null {
  return v === null || v === undefined ? null : asBigInt(v);
}

export class SqliteDocStore implements DocStore {
  private readonly stmtCache = new Map<string, PreparedStatement>();

  constructor(private readonly db: DatabaseAdapter) {}

  private prep(sql: string): PreparedStatement {
    let stmt = this.stmtCache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmtCache.set(sql, stmt);
    }
    return stmt;
  }

  private serializeValue(value: DocumentValue): string {
    return JSON.stringify(convexToJson(value as Value));
  }
  private parseValue(text: string): DocumentValue {
    return jsonToConvex(JSON.parse(text) as JSONValue) as DocumentValue;
  }

  async setupSchema(_options?: SchemaSetupOptions): Promise<void> {
    this.db.exec(SCHEMA_SQL);
    // Additive `shard_id` column (Fenced Frontier B1, D6). `node:sqlite` has no
    // `ADD COLUMN IF NOT EXISTS`, so guard with a `pragma table_info` existence check — a
    // pre-B1 database upgrades in place and its old rows read as 'default' via the DEFAULT.
    for (const table of ["documents", "indexes"] as const) {
      // `table` is a fixed literal from this list — never user input, so interpolation is safe
      // (PRAGMA does not accept bound parameters for its argument).
      const cols = this.prep(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === "shard_id")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN shard_id TEXT NOT NULL DEFAULT 'default'`);
      }
    }
  }

  /** Insert already-stamped document + index rows in the current transaction. Shared by `write()`
   * (caller-supplied timestamps) and `commitWrite()` (store-allocated), so the row-building /
   * column list lives in exactly one place. Must be called inside `this.db.transaction`. */
  private insertRows(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId: ShardId,
  ): void {
    const docVerb = conflictStrategy === "Overwrite" ? "INSERT OR REPLACE" : "INSERT";
    const docStmt = this.prep(
      `${docVerb} INTO documents (table_id, internal_id, ts, prev_ts, value, shard_id) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const idxStmt = this.prep(
      `INSERT OR REPLACE INTO indexes (index_id, key, ts, table_id, internal_id, deleted, shard_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of documents) {
      docStmt.run(
        encodeStorageTableId(entry.id.tableNumber),
        entry.id.internalId,
        entry.ts,
        entry.prev_ts,
        entry.value === null ? null : this.serializeValue(entry.value.value),
        shardId,
      );
    }
    for (const { ts, update } of indexUpdates) {
      const v = update.value;
      idxStmt.run(
        update.indexId,
        update.key,
        ts,
        v.type === "NonClustered" ? encodeStorageTableId(v.docId.tableNumber) : null,
        v.type === "NonClustered" ? v.docId.internalId : null,
        v.type === "NonClustered" ? 0 : 1,
        shardId,
      );
    }
  }

  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void> {
    this.db.transaction(() => {
      this.insertRows(documents, indexUpdates, conflictStrategy, shardId ?? DEFAULT_SHARD);
    });
  }

  async commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
  ): Promise<bigint> {
    // Allocate + stamp + write in ONE synchronous transaction. Under the single-writer invariant,
    // `MAX(ts) + 1` computed inside the transaction is race-free: no other writer can interleave a
    // higher ts between the read and the insert.
    return this.db.transaction(() => {
      const row = this.prep(`SELECT MAX(ts) AS m FROM documents`).get();
      const m = row?.m;
      const commitTs = (m === null || m === undefined ? 0n : asBigInt(m)) + 1n;
      const stampedDocs = documents.map((e) => ({ ...e, ts: commitTs }));
      const stampedIdx = indexUpdates.map((w) => ({ ...w, ts: commitTs }));
      this.insertRows(stampedDocs, stampedIdx, "Error", shardId ?? DEFAULT_SHARD);
      return commitTs;
    });
  }

  async get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    const tableId = encodeStorageTableId(id.tableNumber);
    const row =
      readTimestamp === undefined
        ? this.prep(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = ? AND internal_id = ? ORDER BY ts DESC LIMIT 1`,
          ).get(tableId, id.internalId)
        : this.prep(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = ? AND internal_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
          ).get(tableId, id.internalId, readTimestamp);

    if (!row || row.value === null) return null; // missing or tombstone
    return {
      ts: asBigInt(row.ts),
      prev_ts: asBigIntOrNull(row.prev_ts),
      value: { id, value: this.parseValue(row.value as string) },
    };
  }

  async *index_scan(
    indexId: string,
    _tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    const dir = order === "desc" ? "DESC" : "ASC";
    const params: SqlValue[] = [indexId, interval.start];
    let sql =
      `SELECT i.key AS key, i.table_id AS table_id, i.internal_id AS internal_id, i.deleted AS deleted ` +
      `FROM indexes i WHERE i.index_id = ? AND i.key >= ?`;
    if (interval.end !== null) {
      sql += ` AND i.key < ?`;
      params.push(interval.end);
    }
    sql += ` AND i.ts <= ? AND i.ts = (SELECT MAX(i2.ts) FROM indexes i2 WHERE i2.index_id = i.index_id AND i2.key = i.key AND i2.ts <= ?)`;
    params.push(readTimestamp, readTimestamp);
    sql += ` ORDER BY i.key ${dir}`;
    // NOTE: `limit` is applied AFTER skipping deletions/tombstones below — a SQL LIMIT would
    // count deleted index entries and return short pages.

    const rows = this.prep(sql).all(...params);
    let yielded = 0;
    for (const row of rows) {
      if (Number(row.deleted) === 1 || row.internal_id === null || row.table_id === null) continue;
      const docId: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const doc = await this.get(docId, readTimestamp);
      if (doc === null) continue; // resolved to a tombstone at this snapshot
      yield [row.key as Uint8Array, doc] as const;
      if (limit !== undefined && ++yielded >= limit) return;
    }
  }

  async *load_documents(range: TimestampRange, order: Order): AsyncGenerator<DocumentLogEntry> {
    const dir = order === "desc" ? "DESC" : "ASC";
    const rows = this.prep(
      `SELECT table_id, internal_id, ts, prev_ts, value FROM documents WHERE ts >= ? AND ts < ? ` +
        `ORDER BY ts ${dir}, table_id ${dir}, internal_id ${dir}`,
    ).all(range.minInclusive, range.maxExclusive);

    for (const row of rows) {
      const id: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const value: ResolvedDocument | null =
        row.value === null ? null : { id, value: this.parseValue(row.value as string) };
      yield { ts: asBigInt(row.ts), id, value, prev_ts: asBigIntOrNull(row.prev_ts) };
    }
  }

  async previous_revisions(queries: readonly PrevRevQuery[]): Promise<Map<string, DocumentLogEntry>> {
    const out = new Map<string, DocumentLogEntry>();
    const stmt = this.prep(
      `SELECT ts, prev_ts, value FROM documents WHERE table_id = ? AND internal_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
    );
    for (const q of queries) {
      const row = stmt.get(encodeStorageTableId(q.id.tableNumber), q.id.internalId, q.ts);
      if (!row) continue;
      const value: ResolvedDocument | null =
        row.value === null ? null : { id: q.id, value: this.parseValue(row.value as string) };
      out.set(getPrevRevQueryKey(q.id, q.ts), {
        ts: asBigInt(row.ts),
        id: q.id,
        value,
        prev_ts: asBigIntOrNull(row.prev_ts),
      });
    }
    return out;
  }

  async scan(tableId: string, readTimestamp?: bigint): Promise<LatestDocument[]> {
    const tableNumber = decodeStorageTableId(tableId);
    const rows: SqlRow[] =
      readTimestamp === undefined
        ? this.prep(
            `SELECT d.internal_id AS internal_id, d.ts AS ts, d.prev_ts AS prev_ts, d.value AS value FROM documents d ` +
              `WHERE d.table_id = ? AND d.ts = (SELECT MAX(d2.ts) FROM documents d2 WHERE d2.table_id = d.table_id AND d2.internal_id = d.internal_id) ` +
              `ORDER BY d.internal_id ASC`,
          ).all(tableId)
        : this.prep(
            `SELECT d.internal_id AS internal_id, d.ts AS ts, d.prev_ts AS prev_ts, d.value AS value FROM documents d ` +
              `WHERE d.table_id = ? AND d.ts <= ? AND d.ts = (SELECT MAX(d2.ts) FROM documents d2 WHERE d2.table_id = d.table_id AND d2.internal_id = d.internal_id AND d2.ts <= ?) ` +
              `ORDER BY d.internal_id ASC`,
          ).all(tableId, readTimestamp, readTimestamp);

    const out: LatestDocument[] = [];
    for (const row of rows) {
      if (row.value === null) continue; // tombstone
      const id: InternalDocumentId = { tableNumber, internalId: row.internal_id as Uint8Array };
      out.push({
        ts: asBigInt(row.ts),
        prev_ts: asBigIntOrNull(row.prev_ts),
        value: { id, value: this.parseValue(row.value as string) },
      });
    }
    return out;
  }

  async count(tableId: string): Promise<number> {
    const row = this.prep(
      `SELECT COUNT(*) AS n FROM ( ` +
        `SELECT d.value AS value FROM documents d WHERE d.table_id = ? AND d.ts = ` +
        `(SELECT MAX(d2.ts) FROM documents d2 WHERE d2.table_id = d.table_id AND d2.internal_id = d.internal_id) ` +
        `) WHERE value IS NOT NULL`,
    ).get(tableId);
    return Number(row?.n ?? 0);
  }

  async maxTimestamp(): Promise<bigint> {
    const row = this.prep(`SELECT MAX(ts) AS m FROM documents`).get();
    const m = row?.m;
    return m === null || m === undefined ? 0n : asBigInt(m);
  }

  async getGlobal(key: string): Promise<JSONValue | null> {
    const row = this.prep(`SELECT value FROM persistence_globals WHERE key = ?`).get(key);
    return row ? (JSON.parse(row.value as string) as JSONValue) : null;
  }

  async writeGlobal(key: string, value: JSONValue): Promise<void> {
    this.prep(`INSERT OR REPLACE INTO persistence_globals (key, value) VALUES (?, ?)`).run(
      key,
      JSON.stringify(value),
    );
  }

  async writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    const r = this.prep(`INSERT OR IGNORE INTO persistence_globals (key, value) VALUES (?, ?)`).run(
      key,
      JSON.stringify(value),
    );
    return r.changes > 0;
  }

  /** Close the underlying database adapter (checkpoint + release the file). Used by graceful shutdown. */
  close(): void {
    this.db.close();
  }
}
