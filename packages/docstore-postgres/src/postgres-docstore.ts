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
  ClientVerdictRecord,
  ClientVerdictWrite,
  CommitGuardUnit,
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
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";
import { SCHEMA_STATEMENTS } from "./schema";

function asBigInt(v: PgValue | undefined): bigint {
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}
function asBigIntOrNull(v: PgValue | undefined): bigint | null {
  return v === null || v === undefined ? null : asBigInt(v);
}

// ── Client mutation receipts (the Receipted Outbox, verdict §(c)) — pure helpers ──────────────────
// Mirror `docstore-sqlite/src/sqlite-docstore.ts`'s helpers of the same names — kept in lockstep
// (Risk R9: the two stores are independent implementations of one behavioral contract).

/** Build the WHERE fragment (and its bound params, in order, starting at `$3` — `$1`/`$2` are
 *  always `identity`/`client_id`) for `pruneClientMutations`'s DELETE — the
 *  `seq <= ackedThrough OR createdAt < ttlBeforeMs` union (verdict §(c)). `{clause: null}` when
 *  neither bound is set (nothing to delete this call — a legal no-op). */
function clientMutationsDeleteClause(opts: {
  ackedThrough?: number;
  ttlBeforeMs?: number;
}): { clause: string | null; params: bigint[] } {
  const parts: string[] = [];
  const params: bigint[] = [];
  if (opts.ackedThrough !== undefined) {
    parts.push(`seq <= $${3 + params.length}`);
    params.push(BigInt(opts.ackedThrough));
  }
  if (opts.ttlBeforeMs !== undefined) {
    parts.push(`created_at < $${3 + params.length}`);
    params.push(BigInt(opts.ttlBeforeMs));
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

function clientVerdictRecordFromRow(row: PgRow): ClientVerdictRecord {
  return {
    verdict: row.verdict as "applied" | "failed",
    commitTs: asBigInt(row.commit_ts),
    hasValue: row.value_json !== null,
    value: row.value_json === null ? null : (JSON.parse(row.value_json as string) as JSONValue),
    errorCode: (row.error_code as string | null | undefined) ?? null,
    createdAt: Number(row.created_at),
  };
}

/** Thrown by `write()` while the store is in read-only mode (see `PostgresDocStore`'s
 * `readOnly` option and `setWritable()`). Fleet followers construct the store read-only so a
 * stray write can't happen before the node actually holds the writer lease. */
export class ReadOnlyStoreError extends Error {
  constructor() {
    super("PostgresDocStore is read-only — call setWritable() after acquiring the writer lock");
    this.name = "ReadOnlyStoreError";
  }
}

export interface PostgresDocStoreOptions {
  /** Start the store in read-only mode: `setupSchema()` still runs DDL but skips taking the
   * writer advisory lock, and `write()` throws `ReadOnlyStoreError` until `setWritable()` is
   * called (by the caller, after it has separately acquired the lock — e.g. via
   * `PgClient.tryAcquireWriterLock()` on promotion in a fleet). Default: false. */
  readOnly?: boolean;
}

/** A Postgres commit guard — see `PostgresDocStore.addCommitGuard`'s doc comment (which this type
 *  exists to be referenced from) for the full contract: batch-shaped, runs inside the commit
 *  transaction after all units' row inserts and before COMMIT, throwing aborts the whole batch. */
export type PgCommitGuard = (
  q: PgQuerier,
  units: readonly CommitGuardUnit[],
  shardId: ShardId,
) => Promise<void>;

export class PostgresDocStore implements DocStore {
  private readOnly: boolean;
  /** The commit-guard CHAIN (Receipted Outbox decision 2 — the old single `commitGuard` slot
   * generalized to composition). Guards run in REGISTRATION ORDER, once per `commitWriteBatch`
   * transaction, after ALL units' row inserts and before COMMIT; ANY guard throwing aborts the
   * whole commit (every unit) — the whole chain shares the fence's original all-or-nothing
   * contract. Empty at Tier 0 (no guard ever runs). `units` is the batch's per-unit `{ts, meta}`
   * in unit/ts order (Fleet B4, D1) — each guard fences/effects once per batch over the whole
   * array, not once per unit. The single-commit `commitWrite` path passes a one-unit array. */
  private guards: PgCommitGuard[] = [];

  constructor(
    private readonly db: PgClient,
    options?: PostgresDocStoreOptions,
  ) {
    this.readOnly = options?.readOnly ?? false;
  }

  /** Append `guard` to the commit-guard chain — see `guards`'s doc comment for the full contract.
   * Returns an unregister function that removes exactly this guard (a no-op if called again, or
   * if the guard was never/no-longer registered). Registration order = invocation order. */
  addCommitGuard(guard: PgCommitGuard): () => void {
    this.guards.push(guard);
    return () => {
      const i = this.guards.indexOf(guard);
      if (i >= 0) this.guards.splice(i, 1);
    };
  }

  /** @deprecated Use `addCommitGuard` — kept only for callers not yet migrated. Semantics: CLEARS
   * the whole chain, then (if `guard` is non-null) adds `guard` as the chain's sole member. This
   * is NOT a simple compat shim for a multi-guard chain (it wipes out any other registered guard),
   * so mixing `setCommitGuard` with `addCommitGuard` on the same store is almost certainly a bug —
   * new code should call `addCommitGuard` directly. */
  setCommitGuard(guard: PgCommitGuard | null): void {
    this.guards = guard ? [guard] : [];
  }

  /** The underlying `PgClient` — exposed so fleet code (leader election, LISTEN/NOTIFY signaling)
   * reuses the same connection this store writes through, rather than opening a second one. */
  pgClient(): PgClient {
    return this.db;
  }

  /** Promote a read-only store to writable. Caller must already hold the single-writer advisory
   * lock (e.g. via `pgClient().tryAcquireWriterLock()`) — this method does not itself take it. */
  setWritable(): void {
    this.readOnly = false;
  }

  private serializeValue(value: DocumentValue): string {
    return JSON.stringify(convexToJson(value as Value));
  }
  private parseValue(text: string): DocumentValue {
    return jsonToConvex(JSON.parse(text) as JSONValue) as DocumentValue;
  }

  async setupSchema(_options?: SchemaSetupOptions): Promise<void> {
    // One idempotent statement per query() — portable across single-statement (PGlite) and
    // multi-statement (pg) drivers. Engine-authored text, no interpolation.
    //
    // `CREATE ... IF NOT EXISTS` is NOT fully race-proof in Postgres: two sessions racing to
    // create the same object on a fresh database can both pass the "does it exist" check before
    // either commits, and the loser gets a duplicate-object error instead of a clean no-op
    // (a documented Postgres quirk, not a bug in this code). Fleet self-sufficiency (C7) means
    // every node now runs this DDL concurrently on first boot, widening exposure from one runner
    // to N — so swallow only the duplicate-object race codes here; the statement's objective
    // (the object exists) is already achieved when one of these fires, so continuing is correct.
    // Anything else (e.g. a syntax error) is a real problem and must still propagate.
    for (const stmt of SCHEMA_STATEMENTS) {
      try {
        await this.db.query(stmt);
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        // 42710 (duplicate_object) is the third face of the same race: two concurrent
        // CREATE TABLE IF NOT EXISTS can both pass the existence check, and the loser
        // surfaces as "type <table> already exists" (the table's composite rowtype).
        if (code !== "23505" /* unique_violation */ && code !== "42P07" /* duplicate_table */ && code !== "42710" /* duplicate_object */) throw e;
      }
    }
    // Single-writer invariant — fail fast if another engine already holds the advisory lock.
    // No-op under PGlite (single in-process connection); real guard under NodePgClient.
    // Skipped entirely in read-only mode: a follower runs DDL (schema must exist) but must NOT
    // contend for the writer lock — the leader (or its own later promotion) owns that.
    if (!this.readOnly) {
      await this.db.acquireWriterLock();
      // Seed the commit-ts sequence exactly once per database, under the writer lock. The sentinel
      // global makes this one-shot and race-safe: concurrent booters all attempt the insert, but
      // ON CONFLICT DO NOTHING means only one gets `true` back and runs the setval; the rest skip.
      //   - fresh DB   (MAX(ts)=0): setval(1, is_called=false) → first nextval returns 1
      //   - existing DB(MAX(ts)=N): setval(N, is_called=true)  → next  nextval returns N+1
      // so an upgraded deployment continues its ts line seamlessly without a gap.
      if (await this.writeGlobalIfAbsent("core:tsSeqSeeded", "1")) {
        await this.db.query(
          `SELECT setval(
             'stackbase_ts',
             GREATEST((SELECT COALESCE(MAX(ts), 0) FROM documents), 1),
             (SELECT COALESCE(MAX(ts), 0) FROM documents) > 0
           )`,
        );
      }
    }
  }

  /** Build + run the document and index INSERTs for one commit, against `tx`. Entries arrive with
   * their `ts` already final (caller-supplied for `write()`, store-allocated for `commitWrite`);
   * this is the single home for the INSERT SQL and its column list (incl. `shard_id`), so the two
   * write paths can never drift. Dedup is last-wins to mirror SQLite `INSERT OR REPLACE` and avoid
   * an ON CONFLICT double-affect within one batch. */
  private async writeRows(
    tx: PgQuerier,
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId: ShardId,
  ): Promise<void> {
    // Note: under the "Error" conflict strategy, SQLite's per-row INSERT would throw on a
    // duplicate (table_id, internal_id, ts) within one batch, but this dedup silently keeps
    // the last write instead. That divergence is intentional and safe here: exactly one commit
    // `ts` is stamped per transaction and at most one revision per document is staged, so a
    // genuine duplicate key never reaches this method within a single batch.
    const docByKey = new Map<string, DocumentLogEntry>();
    for (const e of documents) {
      docByKey.set(`${encodeStorageTableId(e.id.tableNumber)}|${Buffer.from(e.id.internalId).toString("hex")}|${e.ts}`, e);
    }
    const idxByKey = new Map<string, IndexWrite>();
    for (const w of indexUpdates) {
      idxByKey.set(`${w.update.indexId}|${Buffer.from(w.update.key).toString("hex")}|${w.ts}`, w);
    }

    const docs = [...docByKey.values()];
    if (docs.length > 0) {
      const cols = 6;
      const rowsSql = docs
        .map(
          (_, i) =>
            `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6})`,
        )
        .join(",");
      const params: PgValue[] = [];
      for (const e of docs) {
        params.push(
          encodeStorageTableId(e.id.tableNumber),
          e.id.internalId,
          e.ts,
          e.prev_ts,
          e.value === null ? null : this.serializeValue(e.value.value),
          shardId,
        );
      }
      const conflict =
        conflictStrategy === "Overwrite"
          ? ` ON CONFLICT (table_id, internal_id, ts) DO UPDATE SET prev_ts = EXCLUDED.prev_ts, value = EXCLUDED.value, shard_id = EXCLUDED.shard_id`
          : ``; // "Error": plain INSERT — a PK collision raises, matching the strategy.
      await tx.query(
        `INSERT INTO documents (table_id, internal_id, ts, prev_ts, value, shard_id) VALUES ${rowsSql}${conflict}`,
        params,
      );
    }

    const idxs = [...idxByKey.values()];
    if (idxs.length > 0) {
      const cols = 7;
      const rowsSql = idxs
        .map(
          (_, i) =>
            `($${i * cols + 1},$${i * cols + 2},$${i * cols + 3},$${i * cols + 4},$${i * cols + 5},$${i * cols + 6},$${i * cols + 7})`,
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
          shardId,
        );
      }
      await tx.query(
        `INSERT INTO indexes (index_id, key, ts, table_id, internal_id, deleted, shard_id) VALUES ${rowsSql}` +
          ` ON CONFLICT (index_id, key, ts) DO UPDATE SET table_id = EXCLUDED.table_id, internal_id = EXCLUDED.internal_id, deleted = EXCLUDED.deleted, shard_id = EXCLUDED.shard_id`,
        params,
      );
    }
  }

  async write(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    conflictStrategy: ConflictStrategy,
    shardId?: ShardId,
  ): Promise<void> {
    if (this.readOnly) throw new ReadOnlyStoreError();
    await this.db.transaction(async (tx) => {
      await this.writeRows(tx, documents, indexUpdates, conflictStrategy, shardId ?? DEFAULT_SHARD);
    });
  }

  async commitWrite(
    documents: readonly DocumentLogEntry[],
    indexUpdates: readonly IndexWrite[],
    shardId?: ShardId,
    opts?: { meta?: Record<string, string> },
  ): Promise<bigint> {
    // Single commit = a one-unit batch (Fleet B4, D1) — ONE implementation, so the guard invocation
    // shape (a one-unit array) is identical to any batch. The store never sees the difference.
    const [ts] = await this.commitWriteBatch([{ documents, indexUpdates, meta: opts?.meta }], shardId);
    return ts!;
  }

  async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    if (this.readOnly) throw new ReadOnlyStoreError();
    const shard = shardId ?? DEFAULT_SHARD;
    // ONE transaction for the whole batch (Fleet B4, D1): per unit, allocate a strictly-increasing ts
    // and stamp+insert its rows; then run the batch-shaped epoch fence ONCE over all units; COMMIT.
    // `nextval` inside the transaction makes each ts visible atomically with its rows — no
    // allocated-but-unlanded window. ANY error — including the guard — rolls the WHOLE batch back, so
    // no unit lands. Advanced sequence values are not reclaimed on rollback (Postgres sequences are
    // non-transactional), which is harmless — ts gaps are legal.
    const runCommit = async (tx: PgQuerier): Promise<bigint[]> => {
      const commitTsList: bigint[] = [];
      const guardUnits: CommitGuardUnit[] = [];
      for (const unit of units) {
        // `nextval` is the primary allocator (and the shared clock the D4 eviction fencer bumps).
        // `GREATEST(nextval, MAX(ts)+1)` also covers out-of-band `write()` rows whose ts did not come
        // from this sequence, keeping each commit strictly above every existing ts (incl. this batch's
        // already-inserted earlier units, which MAX(ts) now sees) — byte-identical to SQLite's
        // `MAX(ts)+1`. So ts's are strictly increasing across units, in unit order. Race-free under the
        // single writer.
        const rows = await tx.query(
          `SELECT GREATEST(nextval('stackbase_ts'), (SELECT COALESCE(MAX(ts), 0) FROM documents) + 1) AS ts`,
        );
        const commitTs = asBigInt(rows[0]!.ts);
        const stampedDocs = unit.documents.map((e) => ({ ...e, ts: commitTs }));
        const stampedIdx = unit.indexUpdates.map((w) => ({ ...w, ts: commitTs }));
        await this.writeRows(tx, stampedDocs, stampedIdx, "Error", shard);
        commitTsList.push(commitTs);
        guardUnits.push({ ts: commitTs, meta: unit.meta });
      }
      // The WHOLE chain, in registration order, ONE invocation each over the whole batch (epoch
      // fence once, frontier once at ts_N, per-unit idempotency INSERT). Skipped for an empty
      // batch — nothing to commit, nothing to fence. ANY guard throwing aborts the whole batch —
      // the `for` loop's exception propagates straight out of `runCommit`, so a later guard never
      // runs and the transaction (including every earlier guard's writes) rolls back.
      if (guardUnits.length > 0) {
        for (const g of this.guards) await g(tx, guardUnits, shard);
      }
      return commitTsList;
    };
    // Pool mode (D1): route the whole batch onto THIS shard's dedicated commit connection, so
    // concurrent cross-shard commits run on independent Postgres sessions. Without a pool (single-node,
    // Tier-0 tests, PGlite) the transaction runs on the pinned connection — byte-identical to before,
    // which the existing conformance suite proves.
    if (this.db.commitQuerierFor) {
      const q = await this.db.commitQuerierFor(shard);
      return q.transaction(runCommit);
    }
    return this.db.transaction(runCommit);
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

  /** Builds the `index_scan` SQL + params — see {@link index_scan} for the query shape rationale. */
  private buildIndexScanSql(
    indexId: string,
    _tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): { sql: string; params: PgValue[] } {
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
    return { sql, params };
  }

  /** Maps one `index_scan` result row to the `[key, LatestDocument]` shape callers expect. */
  private mapIndexRow(row: PgRow): readonly [Uint8Array, LatestDocument] {
    const docId: InternalDocumentId = {
      tableNumber: decodeStorageTableId(row.table_id as string),
      internalId: row.internal_id as Uint8Array,
    };
    const doc: LatestDocument = {
      ts: asBigInt(row.ts),
      prev_ts: asBigIntOrNull(row.prev_ts),
      value: { id: docId, value: this.parseValue(row.value as string) },
    };
    return [row.key as Uint8Array, doc] as const;
  }

  async *index_scan(
    indexId: string,
    tableId: string,
    readTimestamp: bigint,
    interval: Interval,
    order: Order,
    limit?: number,
  ): AsyncGenerator<readonly [Uint8Array, LatestDocument]> {
    const { sql, params } = this.buildIndexScanSql(indexId, tableId, readTimestamp, interval, order, limit);
    const rows = await this.db.query(sql, params);
    for (const row of rows) {
      yield this.mapIndexRow(row);
    }
  }

  async *load_documents(
    range: TimestampRange,
    order: Order,
    limit?: number,
  ): AsyncGenerator<DocumentLogEntry> {
    const dir = order === "desc" ? "DESC" : "ASC";
    // The LIMIT MUST land in the SQL: this implementation buffers the whole result before yielding,
    // so a caller-side generator break would not bound the query. A raw LIMIT is correct here (the
    // log tail returns every revision incl. tombstones — nothing is dropped after the LIMIT counts it).
    const params: PgValue[] = [range.minInclusive, range.maxExclusive];
    let sql = `SELECT table_id, internal_id, ts, prev_ts, value FROM documents WHERE ts >= $1 AND ts < $2
       ORDER BY ts ${dir}, table_id ${dir}, internal_id ${dir}`;
    if (limit !== undefined) {
      params.push(Math.max(0, Math.floor(limit)));
      sql += ` LIMIT $${params.length}`;
    }
    const rows = await this.db.query(sql, params);
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

  /**
   * The store's CURRENT materialized state (Slice 5 — migration export), the Postgres mirror of
   * `SqliteDocStore.dumpCurrentState()`: the newest non-tombstone revision of every document across
   * every table, plus the current row of every index entry (deletion markers included — the dump must
   * reproduce the index table's own rows exactly, not the documents they resolve to). Real ts/prev_ts,
   * not renumbered — restoring via `write(..., "Overwrite")` reproduces this exact state.
   */
  async dumpCurrentState(): Promise<{ documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] }> {
    const docRows = await this.db.query(
      `SELECT table_id, internal_id, ts, prev_ts, value FROM (
         SELECT DISTINCT ON (table_id, internal_id) table_id, internal_id, ts, prev_ts, value
         FROM documents ORDER BY table_id ASC, internal_id ASC, ts DESC
       ) latest WHERE value IS NOT NULL ORDER BY table_id ASC, internal_id ASC`,
    );
    const documents: DocumentLogEntry[] = docRows.map((row) => {
      const id: InternalDocumentId = {
        tableNumber: decodeStorageTableId(row.table_id as string),
        internalId: row.internal_id as Uint8Array,
      };
      return {
        ts: asBigInt(row.ts),
        id,
        value: { id, value: this.parseValue(row.value as string) },
        prev_ts: asBigIntOrNull(row.prev_ts),
      };
    });

    const idxRows = await this.db.query(
      `SELECT index_id, key, ts, table_id, internal_id, deleted FROM (
         SELECT DISTINCT ON (index_id, key) index_id, key, ts, table_id, internal_id, deleted
         FROM indexes ORDER BY index_id ASC, key ASC, ts DESC
       ) latest ORDER BY index_id ASC, key ASC`,
    );
    const indexUpdates: IndexWrite[] = idxRows.map((row) => {
      const deleted = row.deleted === true || Number(row.deleted) === 1;
      const value: DatabaseIndexUpdate["value"] = deleted
        ? { type: "Deleted" }
        : {
            type: "NonClustered",
            docId: {
              tableNumber: decodeStorageTableId(row.table_id as string),
              internalId: row.internal_id as Uint8Array,
            },
          };
      return { ts: asBigInt(row.ts), update: { indexId: row.index_id as string, key: row.key as Uint8Array, value } };
    });

    return { documents, indexUpdates };
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

  // ── Client mutation receipts (the Receipted Outbox, verdict §(c)) ─────────────────────────────

  async getClientVerdict(identity: string, clientId: string, seq: number): Promise<ClientVerdictRecord | null> {
    const rows = await this.db.query(
      `SELECT verdict, commit_ts, value_json, error_code, created_at FROM client_mutations
       WHERE identity = $1 AND client_id = $2 AND seq = $3`,
      [identity, clientId, BigInt(seq)],
    );
    return rows[0] ? clientVerdictRecordFromRow(rows[0]) : null;
  }

  async getClientFloor(identity: string, clientId: string): Promise<number | null> {
    const rows = await this.db.query(
      `SELECT pruned_through_seq FROM client_floors WHERE identity = $1 AND client_id = $2`,
      [identity, clientId],
    );
    return rows[0] ? Number(rows[0].pruned_through_seq) : null;
  }

  async recordClientVerdict(identity: string, clientId: string, seq: number, record: ClientVerdictWrite): Promise<void> {
    const valueJson = cappedValueJson(record.value);
    await this.db.query(
      `INSERT INTO client_mutations
         (identity, client_id, seq, verdict, commit_ts, value_json, error_code, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (identity, client_id, seq) DO NOTHING`,
      [
        identity,
        clientId,
        BigInt(seq),
        record.verdict,
        record.commitTs,
        valueJson,
        record.verdict === "failed" ? record.errorCode : null,
        BigInt(Date.now()),
      ],
    );
  }

  async updateClientVerdictValue(identity: string, clientId: string, seq: number, value: JSONValue): Promise<void> {
    const valueJson = cappedValueJson(value);
    await this.db.query(
      `UPDATE client_mutations SET value_json = $1 WHERE identity = $2 AND client_id = $3 AND seq = $4`,
      [valueJson, identity, clientId, BigInt(seq)],
    );
  }

  async pruneClientMutations(
    identity: string,
    clientId: string,
    opts: { ackedThrough?: number; ttlBeforeMs?: number },
  ): Promise<{ prunedThroughSeq: number }> {
    return this.db.transaction(async (tx) => {
      const floorRows = await tx.query(
        `SELECT pruned_through_seq FROM client_floors WHERE identity = $1 AND client_id = $2`,
        [identity, clientId],
      );
      const currentFloor = floorRows[0] ? Number(floorRows[0].pruned_through_seq) : null;

      let deletedMaxSeq: number | null = null;
      const { clause, params } = clientMutationsDeleteClause(opts);
      if (clause !== null) {
        const rows = await tx.query(
          `DELETE FROM client_mutations WHERE identity = $1 AND client_id = $2 AND (${clause}) RETURNING seq`,
          [identity, clientId, ...params],
        );
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
      await tx.query(
        `INSERT INTO client_floors (identity, client_id, pruned_through_seq, updated_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (identity, client_id) DO UPDATE SET
           pruned_through_seq = GREATEST(client_floors.pruned_through_seq, EXCLUDED.pruned_through_seq),
           updated_at = EXCLUDED.updated_at`,
        [identity, clientId, BigInt(candidate), BigInt(Date.now())],
      );
      return { prunedThroughSeq: candidate };
    });
  }

  async sweepExpiredClientMutations(beforeMs: number): Promise<{ deletedCount: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `DELETE FROM client_mutations WHERE created_at < $1 RETURNING identity, client_id, seq`,
        [BigInt(beforeMs)],
      );
      if (rows.length === 0) return { deletedCount: 0 };

      const maxByClient = new Map<string, { identity: string; clientId: string; maxSeq: number }>();
      for (const row of rows) {
        const identity = row.identity as string;
        const clientId = row.client_id as string;
        const seq = Number(row.seq);
        // NUL-delimited: identity/clientId are client-supplied strings, so an unescaped join
        // (e.g. a plain space) lets ("a","b c") and ("a b","c") collide onto the same batch key.
        const key = `${identity}\x00${clientId}`;
        const cur = maxByClient.get(key);
        if (!cur || seq > cur.maxSeq) maxByClient.set(key, { identity, clientId, maxSeq: seq });
      }
      const now = BigInt(Date.now());
      for (const { identity, clientId, maxSeq } of maxByClient.values()) {
        await tx.query(
          `INSERT INTO client_floors (identity, client_id, pruned_through_seq, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (identity, client_id) DO UPDATE SET
             pruned_through_seq = GREATEST(client_floors.pruned_through_seq, EXCLUDED.pruned_through_seq),
             updated_at = EXCLUDED.updated_at`,
          [identity, clientId, BigInt(maxSeq), now],
        );
      }
      return { deletedCount: rows.length };
    });
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
