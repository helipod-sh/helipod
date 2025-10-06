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

/** A querier that can also open its own BEGIN/COMMIT on a specific pinned connection — what a
 *  per-shard commit connection hands back so `commitWrite` runs entirely on that shard's session. */
export interface PgTransactionalQuerier extends PgQuerier {
  /** Run `fn` in one BEGIN/COMMIT (ROLLBACK on throw) on this querier's own pinned connection. */
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>;
}

export interface PgClient extends PgQuerier {
  /** Run `fn` in one BEGIN/COMMIT (ROLLBACK on throw); `tx` is pinned to a single connection. */
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T>;
  /** Take the process-lifetime single-writer advisory lock; throw if already held elsewhere. */
  acquireWriterLock(): Promise<void>;
  /** Non-blocking attempt at the same advisory lock; resolves `true`/`false` instead of throwing. */
  tryAcquireWriterLock(): Promise<boolean>;
  /**
   * Register a callback fired once when the underlying connection is lost. Optional — only drivers
   * with a single pinned connection whose loss is definitive (see `NodePgClient`) implement it; the
   * fleet writer lease monitor uses it to treat a dropped connection as definitive lease loss.
   * Absent (undefined) on drivers that don't need it (e.g. the in-process PGlite test client).
   */
  onConnectionLost?(cb: () => void): void;
  /**
   * Pool mode only (Fenced Frontier B2a, D1): return a querier bound to `shardId`'s DEDICATED commit
   * connection, lazily opening it on first use. `commitWrite` runs its whole transaction on this so
   * two shards commit on two independent Postgres sessions concurrently — the single pinned connection
   * physically CANNOT (pg queues per session: two interleaved `transaction()` calls yield a no-op second
   * BEGIN and a first COMMIT that commits BOTH shards' half-staged rows — atomicity corruption). Absent
   * (undefined) on non-pool drivers (single-node `NodePgClient`, the PGlite test client): `commitWrite`
   * then keeps its byte-identical pinned-connection path. */
  commitQuerierFor?(shardId: string): Promise<PgTransactionalQuerier>;
  /**
   * Pool mode only (D1 hazard (b)): register a callback fired once, per commit connection, when THAT
   * shard's commit connection is lost (error/end) — mapping a dropped connection to that shard's
   * definitive lease loss. The fleet lease monitor uses it to relinquish exactly the affected shard(s).
   * Multiple callbacks allowed; all fire (a throwing one can't mask the loss for the others). */
  onShardConnectionLost?(cb: (shardId: string) => void): void;
  /**
   * Pool mode only (D1 hazard (c) / D5 per-slot locks): take slot `slot`'s advisory lock via the
   * two-int `pg_try_advisory_lock({@link SHARD_ADVISORY_LOCK_CLASS}, slot)` form, executed ON that
   * shard's commit connection so the lock is SESSION-scoped to it — that connection's death releases
   * exactly that shard's lock, nothing else. `slot` indexes the ordered commit-pool shard list.
   * Non-blocking: resolves `true`/`false`. */
  tryAcquireShardLock?(slot: number): Promise<boolean>;
  /**
   * Pool mode only (Fenced Frontier B2b, D2): release slot `slot`'s advisory lock via
   * `pg_advisory_unlock({@link SHARD_ADVISORY_LOCK_CLASS}, slot)`, executed ON that shard's commit
   * connection — the exact mirror of {@link tryAcquireShardLock}'s acquire, since a two-int advisory
   * lock is only released by the session that took it (or by that session ending). Used by the
   * per-shard relinquish dispatcher when a fence policy decides to drop a shard WITHOUT killing the
   * node: the shard's slot lock is freed so ANY node (including this one, later) can cleanly
   * re-acquire it, while the connection itself — and every other shard's lock — stays untouched.
   * A slot with no lock currently held is a harmless no-op.
   */
  releaseShardLock?(slot: number): Promise<void>;
  close(): Promise<void>;
}

/** Fixed application key for the single-writer guard — the one-int `pg_try_advisory_lock(int8)` form. */
export const ADVISORY_LOCK_KEY = 0x5354424153454e31n;

/**
 * Class id for the per-slot commit locks — the two-int `pg_try_advisory_lock(classId, slot)` form.
 * Postgres keeps the one-int (int8) and two-int (int4,int4) advisory-lock spaces DISJOINT, so a slot
 * lock can never collide with the {@link ADVISORY_LOCK_KEY} single-writer lock even numerically; this
 * distinct constant also namespaces the slot locks so slot `n` means the same thing across nodes.
 * `int4`-range (< 2^31): "STBS".
 */
export const SHARD_ADVISORY_LOCK_CLASS = 0x53544253;
