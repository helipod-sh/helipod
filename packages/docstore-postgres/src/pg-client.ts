/**
 * The narrow async SQL seam the Postgres DocStore sits on — the analogue of docstore-sqlite's
 * synchronous DatabaseAdapter. A PgClient is the ONLY thing that knows a concrete Postgres driver
 * (pg, Bun.SQL, PGlite). Its normalization contract is load-bearing: `query` returns int8 columns
 * as JS bigint and bytea columns as Uint8Array, and accepts bytea params as Uint8Array. Each impl
 * converts to/from its driver's native types so PostgresDocStore only sees bigint/Uint8Array.
 */
export type PgValue = null | number | bigint | string | Uint8Array | boolean;
export type PgRow = Record<string, PgValue>;

export interface PgQuerier {
  /** Run a parameterized query ($1,$2,…); returns normalized rows. */
  query(text: string, params?: readonly PgValue[]): Promise<PgRow[]>;
}

export interface PgClient extends PgQuerier {
  /** Run `fn` in one BEGIN/COMMIT (ROLLBACK on throw); `tx` is pinned to a single connection. */
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>;
  /** Take the process-lifetime single-writer advisory lock; throw if already held elsewhere. */
  acquireWriterLock(): Promise<void>;
  close(): Promise<void>;
}

/** Fixed application key for pg_advisory_lock (single-writer guard). */
export const ADVISORY_LOCK_KEY = 0x5354424153454e31n;
