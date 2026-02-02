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
  CommitGuardUnit,
  ClientVerdictRecord,
  ClientVerdictWrite,
  CommitUnit,
  ConflictStrategy,
  DatabaseIndexUpdate,
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
import { getPrevRevQueryKey, CLIENT_VERDICT_VALUE_CAP_BYTES } from "@stackbase/docstore";
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

CREATE TABLE IF NOT EXISTS client_mutations (
  identity   TEXT NOT NULL,
  client_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  verdict    TEXT NOT NULL,
  commit_ts  INTEGER NOT NULL,
  value_json TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity, client_id, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS client_mutations_by_created_at ON client_mutations (created_at);

CREATE TABLE IF NOT EXISTS client_floors (
  identity           TEXT NOT NULL,
  client_id          TEXT NOT NULL,
  pruned_through_seq INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  PRIMARY KEY (identity, client_id)
) WITHOUT ROWID;
`;

function asBigInt(v: SqlValue | undefined): bigint {
  return typeof v === "bigint" ? v : BigInt(v as number);
}
function asBigIntOrNull(v: SqlValue | undefined): bigint | null {
  return v === null || v === undefined ? null : asBigInt(v);
}

/** The narrow SYNCHRONOUS querier a SQLite commit guard writes receipts through — the sync mirror
 *  of `docstore-postgres`'s async `PgQuerier`. SQLite's commit runs inside one synchronous
 *  `db.transaction(() => {...})`, so a guard can only ever be handed synchronous primitives. */
export interface SqliteGuardQuerier {
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined;
}

/** A SQLite commit guard — see `SqliteDocStore.addCommitGuard`'s doc comment for the full
 *  contract. Unlike `PgCommitGuard`, this MUST be synchronous: it runs inside the one-transaction
 *  synchronous commit, which cannot await anything. Returning a thenable is a documented dev-time
 *  error — see `commitWriteBatch`'s thenable check. */
export type SqliteCommitGuard = (
  q: SqliteGuardQuerier,
  units: readonly CommitGuardUnit[],
  shardId: ShardId,
) => void;
// ── Client mutation receipts (the Receipted Outbox, verdict §(c)) — pure helpers ──────────────────

/** Build the WHERE fragment (and its bound params, in order) for `pruneClientMutations`'s DELETE —
 *  the `seq <= ackedThrough OR createdAt < ttlBeforeMs` union (verdict §(c)). `{clause: null}` when
 *  neither bound is set (nothing to delete this call — a legal no-op). */
function clientMutationsDeleteClause(opts: {
  ackedThrough?: number;
  ttlBeforeMs?: number;
}): { clause: string | null; params: number[] } {
  const parts: string[] = [];
  const params: number[] = [];
  if (opts.ackedThrough !== undefined) {
    parts.push(`seq <= ?`);
    params.push(opts.ackedThrough);
  }
  if (opts.ttlBeforeMs !== undefined) {
    parts.push(`created_at < ?`);
    params.push(opts.ttlBeforeMs);
  }
  return parts.length === 0 ? { clause: null, params: [] } : { clause: parts.join(" OR "), params };
}

/** The floor candidate a prune call covers: the client's own `ackedThrough` claim (which covers any
 *  never-recorded holes below it — floor-covers-holes, verdict decision 3) and/or the highest seq
 *  actually deleted this pass — whichever is higher. `null` when neither applies. */
function maxCandidate(ackedThrough: number | null, deletedMaxSeq: number | null): number | null {
  if (ackedThrough === null) return deletedMaxSeq;
  if (deletedMaxSeq === null) return ackedThrough;
  return Math.max(ackedThrough, deletedMaxSeq);
}

/** Serialize + cap-check a receipt's optional value. Over-cap values are silently DROPPED (never
 *  truncated, never rejected) — the receipt must still land (verdict §(c)); a dropped value reads
 *  back as `hasValue: false`, mapping to the wire's `valueMissing`. */
function cappedValueJson(value: JSONValue | undefined): string | null {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  return Buffer.byteLength(json, "utf8") > CLIENT_VERDICT_VALUE_CAP_BYTES ? null : json;
}

function clientVerdictRecordFromRow(row: SqlRow): ClientVerdictRecord {
  return {
    verdict: row.verdict as "applied" | "failed",
    commitTs: asBigInt(row.commit_ts),
    hasValue: row.value_json !== null,
    value: row.value_json === null ? null : (JSON.parse(row.value_json as string) as JSONValue),
    errorCode: (row.error_code as string | null | undefined) ?? null,
    createdAt: Number(row.created_at),
  };
}

export class SqliteDocStore implements DocStore {
  private readonly stmtCache = new Map<string, PreparedStatement>();
  /** The commit-guard CHAIN (Receipted Outbox decision 2), the SQLite counterpart of
   *  `PostgresDocStore.guards` — see `addCommitGuard`'s doc comment for the full contract. Empty
   *  at Tier 0 and in every non-fleet/non-receipts deployment (no guard ever runs — SQLite pays
   *  nothing for a feature it doesn't use). */
  private guards: SqliteCommitGuard[] = [];

  constructor(private readonly db: DatabaseAdapter) {}

  /** Append `guard` to the commit-guard chain — see `guards`'s doc comment. Guards run in
   * REGISTRATION ORDER, SYNCHRONOUSLY, inside `commitWriteBatch`'s one `db.transaction(() => …)`,
   * once per commit over the WHOLE unit array (never once per unit); ANY guard throwing aborts the
   * whole synchronous transaction (no unit lands) — SQLite's transaction wrapper already rolls
   * back on any thrown error, so this needs no special-casing here. A guard that returns a
   * thenable (i.e. is `async`) is a dev-time bug — see the check in `commitWriteBatch`. Returns an
   * unregister function that removes exactly this guard (a no-op if called again). */
  addCommitGuard(guard: SqliteCommitGuard): () => void {
    this.guards.push(guard);
    return () => {
      const i = this.guards.indexOf(guard);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  /** The synchronous querier handed to every SQLite commit guard — routes through the same
   * prepared-statement cache (`this.prep`) every other method uses, so a guard's writes share
   * SQLite's statement caching for free. */
  private guardQuerier(): SqliteGuardQuerier {
    return {
      run: (sql, ...params) => {
        this.prep(sql).run(...(params as SqlValue[]));
      },
      get: (sql, ...params) => this.prep(sql).get(...(params as SqlValue[])),
    };
  }

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
    // Opaque commit metadata (Fleet B3, D3): threaded through to `commitWriteBatch`'s per-unit
    // `meta`, same as Postgres — SQLite now has a commit-guard chain too (Receipted Outbox
    // decision 2), so this is no longer inert. When no guard is registered (Tier 0, most
    // deployments) it costs nothing: the chain is empty and never runs.
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    // Single commit = a one-unit batch (Fleet B4, D1) — one implementation, so `meta` reaches the
    // guard chain identically whether one or many units commit.
    const [ts] = await this.commitWriteBatch([{ documents, indexUpdates, meta: opts?.meta }], shardId);
    return ts!;
  }

  async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    // Allocate + stamp + write the WHOLE batch in ONE synchronous transaction (Fleet B4, D1). Under
    // the single-writer invariant, `MAX(ts) + 1` computed inside the transaction is race-free: no other
    // writer can interleave a higher ts. Each unit re-reads MAX(ts), which now includes the prior
    // units' just-inserted rows, so the batch stamps CONSECUTIVE, strictly-increasing ts's in unit
    // order. Note: SQLite's flush is synchronous — nothing accumulates during it — so real batching
    // is opportunistic (typically batch-of-1) on Tier 0; the shared path is correct-but-inert here.
    return this.db.transaction(() => {
      const out: bigint[] = [];
      const guardUnits: CommitGuardUnit[] = [];
      const shard = shardId ?? DEFAULT_SHARD;
      for (const unit of units) {
        const row = this.prep(`SELECT MAX(ts) AS m FROM documents`).get();
        const m = row?.m;
        const commitTs = (m === null || m === undefined ? 0n : asBigInt(m)) + 1n;
        const stampedDocs = unit.documents.map((e) => ({ ...e, ts: commitTs }));
        const stampedIdx = unit.indexUpdates.map((w) => ({ ...w, ts: commitTs }));
        this.insertRows(stampedDocs, stampedIdx, "Error", shard);
        out.push(commitTs);
        guardUnits.push({ ts: commitTs, meta: unit.meta });
      }
      // The WHOLE chain, in registration order, ONE SYNCHRONOUS invocation each over the whole
      // batch — the sync mirror of Postgres's chain loop. Skipped for an empty batch. ANY guard
      // throwing propagates straight out of this `db.transaction(() => …)` callback, which rolls
      // the whole synchronous transaction back — no unit lands, exactly like an insert failing.
      if (guardUnits.length > 0) {
        const q = this.guardQuerier();
        for (const g of this.guards) {
          const ret = g(q, guardUnits, shard) as unknown;
          if (ret && typeof (ret as { then?: unknown }).then === "function") {
            throw new Error(
              "[docstore-sqlite] a commit guard returned a Promise; SQLite guards must be " +
                "synchronous — its writes cannot be awaited inside the single-transaction commit",
            );
          }
        }
      }
      return out;
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

  async *load_documents(
    range: TimestampRange,
    order: Order,
    limit?: number,
  ): AsyncGenerator<DocumentLogEntry> {
    const dir = order === "desc" ? "DESC" : "ASC";
    // A raw SQL LIMIT is correct here (unlike `index_scan`, which post-filters tombstones): the log
    // tail returns EVERY revision including tombstones, so no row is dropped after the LIMIT counts it.
    const limitSql = limit !== undefined ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : "";
    const rows = this.prep(
      `SELECT table_id, internal_id, ts, prev_ts, value FROM documents WHERE ts >= ? AND ts < ? ` +
        `ORDER BY ts ${dir}, table_id ${dir}, internal_id ${dir}${limitSql}`,
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

  // ── Client mutation receipts (the Receipted Outbox, verdict §(c)) ─────────────────────────────

  async getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null> {
    const row = this.prep(
      `SELECT verdict, commit_ts, value_json, error_code, created_at FROM client_mutations
       WHERE identity = ? AND client_id = ? AND seq = ?`,
    ).get(identity, clientId, seq);
    if (!row) return null;
    return clientVerdictRecordFromRow(row);
  }

  async getClientFloor(identity: string, clientId: string): Promise<number | null> {
    const row = this.prep(
      `SELECT pruned_through_seq FROM client_floors WHERE identity = ? AND client_id = ?`,
    ).get(identity, clientId);
    return row ? Number(row.pruned_through_seq) : null;
  }

  async recordClientVerdict(identity: string, clientId: string, seq: number, record: ClientVerdictWrite): Promise<void> {
    const valueJson = cappedValueJson(record.value);
    this.prep(
      `INSERT OR IGNORE INTO client_mutations
         (identity, client_id, seq, verdict, commit_ts, value_json, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      identity,
      clientId,
      seq,
      record.verdict,
      record.commitTs,
      valueJson,
      record.verdict === "failed" ? record.errorCode : null,
      Date.now(),
    );
  }

  async updateClientVerdictValue(identity: string, clientId: string, seq: number, value: JSONValue): Promise<void> {
    const valueJson = cappedValueJson(value);
    this.prep(
      `UPDATE client_mutations SET value_json = ? WHERE identity = ? AND client_id = ? AND seq = ?`,
    ).run(valueJson, identity, clientId, seq);
  }

  async pruneClientMutations(
    identity: string,
    clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }> {
    return this.db.transaction(() => {
      const currentFloorRow = this.prep(
        `SELECT pruned_through_seq FROM client_floors WHERE identity = ? AND client_id = ?`,
      ).get(identity, clientId);
      const currentFloor = currentFloorRow ? Number(currentFloorRow.pruned_through_seq) : null;

      let deletedMaxSeq: number | null = null;
      const { clause, params } = clientMutationsDeleteClause(opts);
      if (clause !== null) {
        const rows = this.prep(
          `DELETE FROM client_mutations WHERE identity = ? AND client_id = ? AND (${clause}) RETURNING seq`,
        ).all(identity, clientId, ...params);
        for (const row of rows) {
          const s = Number(row.seq);
          if (deletedMaxSeq === null || s > deletedMaxSeq) deletedMaxSeq = s;
        }
      }

      const candidate = maxCandidate(opts.ackedThrough ?? null, deletedMaxSeq);
      const base = currentFloor ?? -1;
      if (candidate === null || candidate <= base) {
        return { prunedThroughSeq: currentFloor ?? 0 }; // no-op: nothing to advance to
      }
      this.prep(
        `INSERT INTO client_floors (identity, client_id, pruned_through_seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (identity, client_id) DO UPDATE SET
           pruned_through_seq = MAX(client_floors.pruned_through_seq, excluded.pruned_through_seq),
           updated_at = excluded.updated_at`,
      ).run(identity, clientId, candidate, Date.now());
      return { prunedThroughSeq: candidate };
    });
  }

  async sweepExpiredClientMutations(beforeMs: number): Promise<{ deletedCount: number }> {
    return this.db.transaction(() => {
      const rows = this.prep(
        `DELETE FROM client_mutations WHERE created_at < ? RETURNING identity, client_id, seq`,
      ).all(beforeMs);
      if (rows.length === 0) return { deletedCount: 0 };

      const maxByClient = new Map<string, { identity: string; clientId: string; maxSeq: number }>();
      for (const row of rows) {
        const identity = row.identity as string;
        const clientId = row.client_id as string;
        const seq = Number(row.seq);
        // NUL-delimited: identity/clientId are client-supplied strings, so an unescaped join
        // (e.g. a plain space) lets ("a","b c") and ("a b","c") collide onto the same batch key.
        const key = `${identity} ${clientId}`;
        const cur = maxByClient.get(key);
        if (!cur || seq > cur.maxSeq) maxByClient.set(key, { identity, clientId, maxSeq: seq });
      }
      const now = Date.now();
      const upsert = this.prep(
        `INSERT INTO client_floors (identity, client_id, pruned_through_seq, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (identity, client_id) DO UPDATE SET
           pruned_through_seq = MAX(client_floors.pruned_through_seq, excluded.pruned_through_seq),
           updated_at = excluded.updated_at`,
      );
      for (const { identity, clientId, maxSeq } of maxByClient.values()) upsert.run(identity, clientId, maxSeq, now);
      return { deletedCount: rows.length };
    });
  }

  /**
   * The store's CURRENT state (Tier 3 Slice 3, Task 3.1 — the snapshot source): for every document
   * id across every table, its LATEST revision, EXCLUDING ids whose latest revision is a tombstone
   * (`value === null`) — mirrors `scan()`'s per-table "newest revision per id" query, just without
   * the `table_id` filter, so it spans the whole store in one pass. Plus every CURRENT row of the
   * `indexes` table (the newest revision per `(index_id, key)`, live pointer OR deletion marker
   * alike — mirrors `index_scan()`'s own `MAX(ts)`-per-key subquery, but unlike `index_scan` this
   * does NOT skip deleted markers: the snapshot must reproduce the index table's own current rows
   * exactly, not the documents they resolve to).
   *
   * Each returned `DocumentLogEntry`/`IndexWrite` carries its REAL `ts`/`prev_ts` (not renumbered) —
   * `ObjectStoreDocStore.snapshot()` stamps the payload's own `frontierTs`/`segBase` around this, and
   * restoring via `write(dump.documents, dump.indexUpdates, "Overwrite")` on a fresh store reproduces
   * this exact state, with `prev_ts` chains intact so a tail segment's `prev_ts` still resolves.
   */
  async dumpCurrentState(): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }> {
    const docRows = this.prep(
      `SELECT d.table_id AS table_id, d.internal_id AS internal_id, d.ts AS ts, d.prev_ts AS prev_ts, d.value AS value FROM documents d ` +
        `WHERE d.ts = (SELECT MAX(d2.ts) FROM documents d2 WHERE d2.table_id = d.table_id AND d2.internal_id = d.internal_id) ` +
        `AND d.value IS NOT NULL ORDER BY d.table_id ASC, d.internal_id ASC`,
    ).all();

    const documents: DocumentLogEntry[] = docRows.map((row) => {
      const id: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      const value: ResolvedDocument = { id, value: this.parseValue(row.value as string) };
      return { ts: asBigInt(row.ts), id, value, prev_ts: asBigIntOrNull(row.prev_ts) };
    });

    const idxRows = this.prep(
      `SELECT i.index_id AS index_id, i.key AS key, i.ts AS ts, i.table_id AS table_id, i.internal_id AS internal_id, i.deleted AS deleted FROM indexes i ` +
        `WHERE i.ts = (SELECT MAX(i2.ts) FROM indexes i2 WHERE i2.index_id = i.index_id AND i2.key = i.key) ` +
        `ORDER BY i.index_id ASC, i.key ASC`,
    ).all();

    const indexUpdates: IndexWrite[] = idxRows.map((row) => {
      const deleted = Number(row.deleted) === 1;
      const value: DatabaseIndexUpdate["value"] = deleted
        ? { type: "Deleted" }
        : {
            type: "NonClustered",
            docId: {
              tableNumber: decodeStorageTableId(row.table_id as string),
              internalId: row.internal_id as Uint8Array,
            },
          };
      return {
        ts: asBigInt(row.ts),
        update: { indexId: row.index_id as string, key: row.key as Uint8Array, value },
      };
    });

    return { documents, indexUpdates };
  }

  /** Close the underlying database adapter (checkpoint + release the file). Used by graceful shutdown. */
  close(): void {
    this.db.close();
  }
}
