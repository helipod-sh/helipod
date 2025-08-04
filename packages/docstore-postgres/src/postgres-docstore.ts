/**
 * `PostgresDocStore` — the MVCC document log over Postgres, mirroring `SqliteDocStore`'s three
 * physical tables (see `packages/docstore-sqlite/src/sqlite-docstore.ts`):
 *
 *   documents(table_id, internal_id, ts, prev_ts, value)   -- one row per revision; value NULL = tombstone
 *   indexes  (index_id, key, ts, table_id, internal_id, deleted)  -- MVCC index entries
 *   persistence_globals(key, value)                          -- engine metadata KV
 *
 * `setupSchema`/`write`/`get` (tasks 1-2), `scan`/`count`/`maxTimestamp`/`getGlobal`/
 * `writeGlobal`/`writeGlobalIfAbsent` (task 3, set-based via `DISTINCT ON`), and
 * `index_scan`/`load_documents`/`previous_revisions` (task 4, set-based: `DISTINCT ON` +
 * `LEFT JOIN LATERAL` for the index scan with tombstones filtered before `LIMIT`, an ordered
 * range scan for the change feed, and a batched `VALUES` + `LATERAL` join for the OCC
 * previous-revisions lookup) are all implemented over the async `PgClient` seam.
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
    // Single-writer invariant — fail fast if another engine already holds the advisory lock.
    // No-op under PGlite (single in-process connection); real guard under NodePgClient.
    await this.db.acquireWriterLock();
  }

  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    _shardId?: ShardId,
  ): Promise<void> {
    // Dedup last-wins to mirror SQLite INSERT OR REPLACE and avoid ON CONFLICT double-affect.
    const docByKey = new Map<string, DocumentLogEntry>();
    for (const e of documents) {
      docByKey.set(`${encodeStorageTableId(e.id.tableNumber)}|${Buffer.from(e.id.internalId).toString("hex")}|${e.ts}`, e);
    }
    const idxByKey = new Map<string, IndexWrite>();
    for (const w of indexUpdates) {
      idxByKey.set(`${w.update.indexId}|${Buffer.from(w.update.key).toString("hex")}|${w.ts}`, w);
    }

    await this.db.transaction(async (tx) => {
      const docs = [...docByKey.values()];
      if (docs.length > 0) {
        const cols = 5;
        const rowsSql = docs
          .map((_, i) => `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5})`)
          .join(",");
        const params: PgValue[] = [];
        for (const e of docs) {
          params.push(
            encodeStorageTableId(e.id.tableNumber),
            e.id.internalId,
            e.ts,
            e.prev_ts,
            e.value === null ? null : this.serializeValue(e.value.value),
          );
        }
        const conflict =
          conflictStrategy === "Overwrite"
            ? ` ON CONFLICT (table_id, internal_id, ts) DO UPDATE SET prev_ts = EXCLUDED.prev_ts, value = EXCLUDED.value`
            : ``; // "Error": plain INSERT — a PK collision raises, matching the strategy.
        await tx.query(
          `INSERT INTO documents (table_id, internal_id, ts, prev_ts, value) VALUES ${rowsSql}${conflict}`,
          params,
        );
      }

      const idxs = [...idxByKey.values()];
      if (idxs.length > 0) {
        const cols = 6;
        const rowsSql = idxs
          .map(
            (_, i) =>
              `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6})`,
          )
          .join(",");
        const params: PgValue[] = [];
        for (const { ts, update } of idxs) {
          const v = update.value;
          params.push(
            update.indexId,
            update.key,
            ts,
            v.type === "NonClustered" ? encodeStorageTableId(v.docId.tableNumber) : null,
            v.type === "NonClustered" ? v.docId.internalId : null,
            v.type !== "NonClustered", // deleted = true for a "Deleted" entry
          );
        }
        await tx.query(
          `INSERT INTO indexes (index_id, key, ts, table_id, internal_id, deleted) VALUES ${rowsSql}` +
            ` ON CONFLICT (index_id, key, ts) DO UPDATE SET table_id = EXCLUDED.table_id, internal_id = EXCLUDED.internal_id, deleted = EXCLUDED.deleted`,
          params,
        );
      }
    });
  }

  async get(id: InternalDocumentId, readTimestamp?: bigint): Promise<LatestDocument | null> {
    const tableId = encodeStorageTableId(id.tableNumber);
    const rows =
      readTimestamp === undefined
        ? await this.db.query(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = $1 AND internal_id = $2 ORDER BY ts DESC LIMIT 1`,
            [tableId, id.internalId],
          )
        : await this.db.query(
            `SELECT ts, prev_ts, value FROM documents WHERE table_id = $1 AND internal_id = $2 AND ts <= $3 ORDER BY ts DESC LIMIT 1`,
            [tableId, id.internalId, readTimestamp],
          );
    const row = rows[0];
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
    const params: PgValue[] = [indexId, interval.start, readTimestamp];
    let endClause = "";
    if (interval.end !== null) {
      endClause = ` AND i.key < $4`;
      params.push(interval.end);
    }
    // DISTINCT ON (i.key) with ORDER BY i.key <dir>, i.ts DESC → newest entry per key ≤ readTimestamp.
    // LATERAL resolves the pointed doc's newest visible revision. Filter dead rows, THEN limit —
    // a raw SQL LIMIT here would count deleted/tombstoned entries and return short pages.
    let sql =
      `SELECT idx.key AS key, doc.ts AS ts, doc.prev_ts AS prev_ts, doc.value AS value,
              idx.table_id AS table_id, idx.internal_id AS internal_id
       FROM (
         SELECT DISTINCT ON (i.key) i.key, i.table_id, i.internal_id, i.deleted
         FROM indexes i
         WHERE i.index_id = $1 AND i.key >= $2 AND i.ts <= $3${endClause}
         ORDER BY i.key ${dir}, i.ts DESC
       ) idx
       LEFT JOIN LATERAL (
         SELECT d.ts, d.prev_ts, d.value FROM documents d
         WHERE d.table_id = idx.table_id AND d.internal_id = idx.internal_id AND d.ts <= $3
         ORDER BY d.ts DESC LIMIT 1
       ) doc ON TRUE
       WHERE idx.deleted = FALSE AND idx.internal_id IS NOT NULL AND doc.value IS NOT NULL
       ORDER BY idx.key ${dir}`;
    if (limit !== undefined) {
      sql += ` LIMIT $${params.length + 1}`;
      params.push(Number(limit));
    }

    const rows = await this.db.query(sql, params);
    for (const row of rows) {
      const docId: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const doc: LatestDocument = {
        ts: asBigInt(row.ts),
        prev_ts: asBigIntOrNull(row.prev_ts),
        value: { id: docId, value: this.parseValue(row.value as string) },
      };
      yield [row.key as Uint8Array, doc] as const;
    }
  }

  async *load_documents(range: TimestampRange, order: Order): AsyncGenerator<DocumentLogEntry> {
    const dir = order === "desc" ? "DESC" : "ASC";
    const rows = await this.db.query(
      `SELECT table_id, internal_id, ts, prev_ts, value FROM documents WHERE ts >= $1 AND ts < $2
       ORDER BY ts ${dir}, table_id ${dir}, internal_id ${dir}`,
      [range.minInclusive, range.maxExclusive],
    );
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
    if (queries.length === 0) return out;
    // One round trip: a VALUES list (with an ordinality tag) LATERAL-joined to the newest visible rev.
    const cols = 4;
    const valuesSql = queries
      .map((_, i) =>
        i === 0
          ? `($${i * cols + 1}::int, $${i * cols + 2}::text, $${i * cols + 3}::bytea, $${i * cols + 4}::bigint)`
          : `($${i * cols + 1}, $${i * cols + 2}, $${i * cols + 3}, $${i * cols + 4})`,
      )
      .join(",");
    const params: PgValue[] = [];
    queries.forEach((q, i) => {
      params.push(i, encodeStorageTableId(q.id.tableNumber), q.id.internalId, q.ts);
    });
    const rows = await this.db.query(
      `SELECT q.ord AS ord, d.ts AS ts, d.prev_ts AS prev_ts, d.value AS value
       FROM (VALUES ${valuesSql}) AS q(ord, table_id, internal_id, ts)
       JOIN LATERAL (
         SELECT dd.ts, dd.prev_ts, dd.value FROM documents dd
         WHERE dd.table_id = q.table_id AND dd.internal_id = q.internal_id AND dd.ts <= q.ts
         ORDER BY dd.ts DESC LIMIT 1
       ) d ON TRUE`,
      params,
    );
    for (const row of rows) {
      const q = queries[Number(row.ord)]!;
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
    const rows =
      readTimestamp === undefined
        ? await this.db.query(
            `SELECT internal_id, ts, prev_ts, value FROM (
               SELECT DISTINCT ON (internal_id) internal_id, ts, prev_ts, value
               FROM documents WHERE table_id = $1
               ORDER BY internal_id ASC, ts DESC
             ) latest WHERE value IS NOT NULL ORDER BY internal_id ASC`,
            [tableId],
          )
        : await this.db.query(
            `SELECT internal_id, ts, prev_ts, value FROM (
               SELECT DISTINCT ON (internal_id) internal_id, ts, prev_ts, value
               FROM documents WHERE table_id = $1 AND ts <= $2
               ORDER BY internal_id ASC, ts DESC
             ) latest WHERE value IS NOT NULL ORDER BY internal_id ASC`,
            [tableId, readTimestamp],
          );
    return rows.map((row) => {
      const id: InternalDocumentId = { tableNumber, internalId: row.internal_id as Uint8Array };
      return {
        ts: asBigInt(row.ts),
        prev_ts: asBigIntOrNull(row.prev_ts),
        value: { id, value: this.parseValue(row.value as string) },
      };
    });
  }

  async count(tableId: string): Promise<number> {
    const rows = await this.db.query(
      `SELECT COUNT(*)::bigint AS n FROM (
         SELECT DISTINCT ON (internal_id) value FROM documents WHERE table_id = $1
         ORDER BY internal_id ASC, ts DESC
       ) latest WHERE value IS NOT NULL`,
      [tableId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async maxTimestamp(): Promise<bigint> {
    const rows = await this.db.query(`SELECT MAX(ts) AS m FROM documents`);
    const m = rows[0]?.m;
    return m === null || m === undefined ? 0n : asBigInt(m);
  }

  async getGlobal(key: string): Promise<JSONValue | null> {
    const rows = await this.db.query(`SELECT value FROM persistence_globals WHERE key = $1`, [key]);
    return rows[0] ? (JSON.parse(rows[0].value as string) as JSONValue) : null;
  }

  async writeGlobal(key: string, value: JSONValue): Promise<void> {
    await this.db.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
  }

  async writeGlobalIfAbsent(key: string, value: JSONValue): Promise<boolean> {
    const rows = await this.db.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, JSON.stringify(value)],
    );
    return rows.length > 0; // a row is RETURNED only when the insert actually happened
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
