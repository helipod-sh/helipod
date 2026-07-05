/**
 * The "Bun is primary" native `PgClient` over `Bun.SQL` — Bun's built-in Postgres driver
 * (measured ~10-15% faster p50 per query than `pg` on a local server; see the package's smoke
 * benchmark). Implements the full `PgClient` surface: `query`, `transaction`,
 * `acquireWriterLock`/`tryAcquireWriterLock`, `close`, a best-effort `onConnectionLost`, streaming
 * `queryStream`, and the fleet/sharding surface (`commitQuerierFor`/`tryAcquireShardLock`/
 * `releaseShardLock`/`onShardConnectionLost`) mirroring `NodePgClient`'s per-shard dedicated
 * connections.
 *
 * ## The type codec (verified against a real `postgres:16`, not assumed — see the package's
 * `test/bun-sql-smoke.ts`)
 * `Bun.SQL`'s DEFAULT int8 (bigint) decoding is a STRING ("9223372036854775807"), not a JS
 * `bigint` — diverging from `NodePgClient`'s per-client type-parser override. `Bun.SQL` exposes
 * its own equivalent as a constructor option instead: `new Bun.SQL({ url, bigint: true })` makes
 * every int8 column (and int8 param) round-trip as a native `bigint`, matching the seam's
 * documented contract (`./pg-client.ts`: "query returns int8 columns as JS bigint") exactly — no
 * per-row coercion needed for `ts`/`prev_ts`/`commit_ts`/`seq`/etc. bytea decodes as a Node
 * `Buffer` (a `Uint8Array` subclass, same as `pg`) — `normalizeRows` below narrows it to a plain
 * `Uint8Array` for parity with `NodePgClient`'s own normalization. boolean and null pass through
 * as native JS `boolean`/`null` already. Uint8Array/bigint/boolean/string/null PARAMS are all
 * accepted directly by `Bun.SQL`'s `unsafe(sql, params)` — no Buffer conversion needed on the way
 * in, unlike `pg` (which wants a `Buffer` for bytea params).
 *
 * ## The pinned-connection writer lock (RISK 2)
 * `pg_advisory_lock`/`pg_try_advisory_lock` are SESSION-scoped, but `Bun.SQL` POOLS connections
 * by default (`max: 10`) — a lock taken on one pooled connection would be invisible to a query
 * that later happens to land on a different one, silently defeating the single-writer invariant.
 * Mirrors `NodePgClient`'s pinned-connection design: `sql.reserve()` takes ONE dedicated
 * connection out of the pool for the client's whole lifetime (lazily, memoized — see
 * `ensurePinned`), and `acquireWriterLock`/`tryAcquireWriterLock`/`transaction` all run on it, so
 * the lock and the commit path share one Postgres session. Plain `query()` (reads, plus the
 * handful of single-statement autocommit writes like `setupSchema`'s DDL / `writeGlobal`) uses
 * the general pool instead — those don't need session pinning, and spreading them across the pool
 * is exactly the concurrency `Bun.SQL`'s native pooling is for. A `close()` before ending the pool
 * MUST `release()` a still-reserved connection first: `sql.end()` hangs forever waiting for every
 * reserved connection to be returned (verified empirically — see `test/bun-sql-smoke.ts`'s close
 * path), which `NodePgClient` has no equivalent hazard for (`pg.Client` isn't pooled).
 *
 * ## queryStream (verified empirically against a real `postgres:16` — `Bun.SQL` exposes NO
 * `.cursor()`/async-iterator API on its `Query` object; confirmed by inspecting the returned
 * object's prototype at runtime, see the task report). Falls back to plain SQL-level cursors
 * instead: `DECLARE ... NO SCROLL CURSOR FOR <query>` / `FETCH <n> FROM <cursor>` / `CLOSE
 * <cursor>` issued as ordinary `unsafe()` statements — this works because DECLARE/FETCH are just
 * SQL, not a driver feature, and non-holdable (NO SCROLL, no WITH HOLD) cursors are cheap: an
 * early `break` leaves the remaining range genuinely uncomputed by the server, same as
 * `NodePgClient`'s `pg-cursor` portal.
 *
 * Stream reservations are drawn from a small BOUNDED REUSE POOL (`STREAM_POOL_MAX`), mirroring
 * `NodePgClient`'s bounded read pool (`READ_POOL_MAX`/`acquireReadConn`/`releaseReadConn`) rather
 * than reserving a fresh `sql.reserve()` connection per call: an unbounded per-call reserve shares
 * `Bun.SQL`'s own general pool with the pinned writer/commit reservations, so a burst of concurrent
 * `queryStream` callers could starve out a pinned reservation behind a queue of reader reservations
 * (priority inversion). `acquireStreamConn`/`releaseStreamConn` (below) implement the identical
 * shape: an idle stack, a `streamPoolTotal` slot counter (bounds total pool size without a separate
 * "in use" list), a FIFO waiter queue for callers blocked at capacity, and a broken-connection path
 * that discards (never returns to idle) and frees its slot instead. A `sql.reserve()` failure frees
 * the slot and wakes one waiter with no connection (so it loops back and retries the freed slot)
 * before rethrowing — the exact `acquireReadConn` connect-failure-deadlock lesson: without this, a
 * transient reserve() failure would permanently leak a pool slot. `releaseStreamConn` hands a
 * healthy release DIRECTLY to the oldest waiter (never via the idle stack) for the same FIFO-
 * fairness reason `releaseReadConn`'s doc comment explains (a synchronous new caller could otherwise
 * steal a just-freed connection out from under an older waiter in the microtask gap between "push to
 * idle" and the woken waiter's continuation actually running). `queryStreamImpl` acquires from this
 * pool at the top and releases in its `finally` (`broken: true` on the error path, since a
 * connection that failed mid-cursor may have a dangling portal/transaction). Released in `finally`
 * on every exit (full drain, early break, or error) — AND tracked in `streamReservations` for the
 * duration it's outstanding (now: while pooled *or* borrowed), so `close()` can force-release/drain
 * every stream reservation, pooled-idle or still-borrowed by a consumer that stopped iterating
 * without a `break`/drain: an abandoned generator sits forever suspended at its `yield`, and
 * `sql.end()` hangs forever waiting for a reserved connection nobody will ever return otherwise
 * (verified empirically — see `test/bun-sql-smoke.ts`'s close-while-streaming case). `STREAM_POOL_MAX`
 * is sized well under `Bun.SQL`'s own default pool `max: 10`, leaving headroom for the pinned writer
 * reservation and any commit-pool shard reservations to always get a slot. A `HELIPOD_PG_STREAM=0`/
 * `"false"` env var (mirroring `NodePgClient`'s identical kill switch) disables `queryStream`
 * entirely — the field is left `undefined` in the constructor so `PostgresDocStore.index_scan`'s
 * truthiness check falls back to buffered `query`.
 *
 * Honest gap vs. `NodePgClient`'s read pool: `NodePgClient.acquireReadConn` proactively filters a
 * broken IDLE connection via a per-connection `pg.Client.on("error", ...)` listener
 * (`readPoolBroken`), so a connection that dies while sitting idle never gets handed to the next
 * borrower. `Bun.SQL` has no equivalent — its reserved-connection object (`ReservedSQL`) exposes no
 * per-connection error/close event, only pool-wide `onclose`/`onconnect` constructor callbacks that
 * fire for ANY connection in the pool with no way to identify which one, so they can't be used to
 * mark one specific idle reservation broken. `acquireStreamConn` therefore pops an idle reservation
 * WITHOUT a liveness check; a reservation that dies while idle (server `idle_session_timeout`, an
 * LB/pgbouncer reap, a network blip) is only detected LAZILY, on next use — its `BEGIN`/`DECLARE`
 * throws, `queryStreamImpl`'s `catch`/`finally` marks it `broken`, and `releaseStreamConn` discards
 * it and frees the slot. This is self-healing (one spurious caller-visible error, then the pool
 * recovers), never a hang or a leak — just not proactive the way the read pool is.
 *
 * ## `.code` normalization (verified empirically — see the task report / `test/bun-sql-smoke.ts`)
 * `Bun.SQL`'s `PostgresError.code` is a generic Bun/Node-style code (`ERR_POSTGRES_SERVER_ERROR`),
 * NOT the pg-style SQLSTATE `NodePgClient`'s `pg` driver puts on `.code` (`23505`/`42P07`/etc.).
 * The actual SQLSTATE lives on `.errno` instead. `PostgresDocStore.setupSchema`'s duplicate-object
 * race swallow reads `(e as {code?}).code` expecting a SQLSTATE string — so every genuine
 * `PostgresError` this client throws (`query`/`transaction`/`queryStream`/the fleet paths) is
 * re-tagged here, overwriting `.code` with `.errno`'s SQLSTATE, before it ever reaches a caller.
 */
import type { PgClient, PgQuerier, PgRow, PgTransactionalQuerier, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY, SHARD_ADVISORY_LOCK_CLASS, STREAM_BATCH_INITIAL, STREAM_BATCH_MAX } from "./pg-client";

// ── Minimal local ambient typing for the slice of Bun.SQL this file uses ──────────────────────────
// `bun-types` isn't installed in this workspace (this package's tsconfig only pulls in "node"
// types, and adding a Bun global package-wide risks clashing with the Node-side code the rest of
// this package still typechecks under `tsc --noEmit`/vitest). So: a narrow local shape, read off
// `globalThis` with a single cast rather than a `declare global` augmentation — real correctness
// comes from actually running this against Postgres via `bun test/bun-sql-smoke.ts`, which Node
// vitest never collects (see that file's header).
interface BunSQLRow extends Record<string, unknown> {}
interface BunSQLQuerier {
  unsafe(query: string, params?: readonly unknown[]): Promise<BunSQLRow[]>;
}
interface BunSQLReservedConnection extends BunSQLQuerier {
  /** Return this connection to its pool (does NOT close the socket). */
  release(): void;
}
interface BunSQLHandle extends BunSQLQuerier {
  reserve(): Promise<BunSQLReservedConnection>;
  end(): Promise<void>;
}
interface BunSQLCtor {
  new (opts: { url: string; bigint: true }): BunSQLHandle;
  /** Bun.SQL's own SQL-error class — a genuine server-side error (constraint violation, bad
   *  syntax, …) is `instanceof` this. Anything else thrown by `unsafe()` (a raw `Error`, e.g. from
   *  a dead/killed connection) is NOT — the `onConnectionLost` heuristic below keys off exactly
   *  that distinction (verified empirically against a `pg_terminate_backend`-killed connection). */
  PostgresError: abstract new (...args: never[]) => Error;
}
/** The shape of a genuine `Bun.SQL.PostgresError` this file cares about: `.code` is a generic
 *  Bun/Node-style code (`ERR_POSTGRES_SERVER_ERROR`), `.errno` is the real pg SQLSTATE string
 *  (`"23505"`/`"42P07"`/…) — see the class doc comment's `.code` normalization section. */
interface BunPostgresErrorShape {
  code?: string;
  errno?: string;
}
/** Bounded reuse-pool size for `queryStream` reservations (mirrors `NodePgClient`'s `READ_POOL_MAX`).
 *  `Bun.SQL`'s own general pool defaults to `max: 10` connections total; this cap leaves headroom
 *  under that so the pinned writer reservation (`ensurePinned`) and any commit-pool shard
 *  reservations always have a slot available even when every stream slot is in use. Exported so
 *  `test/bun-sql-smoke.ts` can assert against the real bound instead of a hardcoded duplicate. */
export const STREAM_POOL_MAX = 4;

/**
 * Kill switch for the DECLARE/FETCH cursor streaming path, mirroring `NodePgClient`'s
 * `resolveStreamingEnabled` exactly (same env var, same semantics): `HELIPOD_PG_STREAM=0` (or
 * `"false"`) makes this client NOT advertise `queryStream`, so `PostgresDocStore.index_scan`'s
 * `if (this.db.queryStream)` gate falls through to the buffered `query` path. Default (unset, or
 * any other value) is streaming ON.
 */
function resolveStreamingEnabled(): boolean {
  const v = process.env.HELIPOD_PG_STREAM;
  return v !== "0" && v !== "false";
}

function getBunSql(): BunSQLCtor {
  const Bun = (globalThis as unknown as { Bun?: { SQL: BunSQLCtor } }).Bun;
  if (!Bun) {
    throw new Error(
      "BunSqlClient requires the `Bun` global (Bun.SQL) — it must run under the Bun runtime, not Node",
    );
  }
  return Bun.SQL;
}

function normalizeValue(v: unknown): PgValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return v instanceof Buffer ? new Uint8Array(v) : v; // bytea → plain Uint8Array
  return v as PgValue; // bigint/boolean/string/number already native, thanks to `{ bigint: true }`
}
function normalizeRows(rows: readonly BunSQLRow[]): PgRow[] {
  return rows.map((r) => {
    const out: PgRow = {};
    for (const [k, val] of Object.entries(r)) out[k] = normalizeValue(val);
    return out;
  });
}

/** One shard's dedicated commit connection (mirrors `NodePgClient`'s `ShardCommitConn`).
 *  `connPromise` is memoized per shard; `lostFired` guards a single per-shard loss fire. */
interface ShardCommitConn {
  readonly shardId: string;
  connPromise?: Promise<BunSQLReservedConnection>;
  lostFired: boolean;
}

export class BunSqlClient implements PgClient {
  private readonly sql: BunSQLHandle;
  private readonly PostgresErrorCtor: BunSQLCtor["PostgresError"];
  private pinnedPromise?: Promise<BunSQLReservedConnection>;
  private readonly connectionLostCbs: Array<() => void> = [];
  private connectionLostFired = false;
  private nextStreamCursorId = 0;
  /** Every `queryStream` reservation this client currently holds — pooled-idle OR borrowed by an
   *  in-flight generator — tracked for the duration it's outstanding (added when a reservation is
   *  first created in `acquireStreamConn`, removed only when actually released back to Postgres) —
   *  so `close()` can drain the whole pool and force-release any still-borrowed reservation before
   *  `sql.end()`, which otherwise hangs forever waiting for a reserved connection that a paused/
   *  never-drained consumer will never return on its own (see the class doc comment's RISK 2 hang,
   *  and `close()` below). */
  private readonly streamReservations = new Set<BunSQLReservedConnection>();

  // ---- Bounded reuse pool for queryStream reservations (mirrors NodePgClient's read pool) ------
  /** Idle, healthy, ready-to-borrow stream reservations. */
  private readonly streamPoolIdle: BunSQLReservedConnection[] = [];
  /** Count of stream reservations that exist (idle + currently borrowed) — bounds total pool size
   *  without needing a separate "in use" list. */
  private streamPoolTotal = 0;
  /** FIFO of waiters blocked on `acquireStreamConn` when the pool is at `STREAM_POOL_MAX`. `resolve`
   *  takes an OPTIONAL connection: a healthy release hands the connection DIRECTLY to the oldest
   *  waiter (`resolve(conn)`, see `releaseStreamConn`'s FIFO-fairness note); a discard (broken
   *  connection, or a failed fresh `sql.reserve()`) instead wakes with no connection
   *  (`resolve(undefined)`) so the waiter loops back and retries the now-freed slot itself. */
  private readonly streamPoolWaiters: Array<{
    resolve: (conn?: BunSQLReservedConnection) => void;
    reject: (e: Error) => void;
  }> = [];
  /** Set by `close()`; makes any further `acquireStreamConn` reject instead of hanging forever. */
  private streamPoolClosed = false;

  /** Test/debug-only introspection of the stream pool's current occupancy: `total` is the count of
   *  distinct reservations created so far (idle + currently borrowed), never exceeding
   *  `STREAM_POOL_MAX` by construction — this is what `test/bun-sql-smoke.ts` asserts against to
   *  prove concurrent `queryStream` callers reuse a bounded set of connections rather than opening
   *  one per call. Not part of the `PgClient` seam. */
  get streamPoolStats(): { total: number; idle: number } {
    return { total: this.streamPoolTotal, idle: this.streamPoolIdle.length };
  }

  /** Ordered commit-pool shard list (index = slot), or undefined for a non-pool (single-shard)
   *  client — mirrors `NodePgClient.commitPoolShards`. */
  private readonly commitPoolShards?: readonly string[];
  /** Lazily-opened per-shard commit connections (pool mode only). */
  private readonly commitConns = new Map<string, ShardCommitConn>();
  private readonly shardConnectionLostCbs: Array<(shardId: string) => void> = [];

  // The four pool capabilities are PRESENT (bound in the constructor) only when a `commitPool` is
  // configured, and absent otherwise — same presence-equals-capability contract `NodePgClient` uses,
  // so `PostgresDocStore.commitWrite`'s `if (db.commitQuerierFor)` check correctly keeps a poolless
  // single-node client on the pinned path.
  readonly commitQuerierFor?: (shardId: string) => Promise<PgTransactionalQuerier>;
  readonly onShardConnectionLost?: (cb: (shardId: string) => void) => void;
  readonly tryAcquireShardLock?: (slot: number) => Promise<boolean>;
  readonly releaseShardLock?: (slot: number) => Promise<void>;

  /** Present (bound in the constructor) only when the {@link resolveStreamingEnabled} kill switch is
   *  ON (the default) — absent (`undefined`) when `HELIPOD_PG_STREAM=0`/`"false"` disables it, so
   *  `PostgresDocStore.index_scan`'s `if (this.db.queryStream)` truthiness check correctly falls
   *  through to buffered `query`, mirroring `NodePgClient`'s same field/gate exactly. */
  readonly queryStream?: (sql: string, params?: readonly PgValue[]) => AsyncIterable<PgRow>;

  constructor(opts: {
    connectionString: string;
    /** Per-shard commit-connection pool (mirrors `NodePgClient`'s `commitPool` option). `shards` is
     *  the ordered slot list — `shards[slot]` is the shard id `tryAcquireShardLock(slot)` locks.
     *  Unset → single pinned connection, byte-identical to before this option existed. */
    commitPool?: { shards: readonly string[] };
  }) {
    const SQL = getBunSql();
    // `bigint: true` is the whole int8 codec fix (see the class doc comment) — every other type
    // (bytea/boolean/text/null) already round-trips correctly under Bun.SQL's defaults.
    this.sql = new SQL({ url: opts.connectionString, bigint: true });
    this.PostgresErrorCtor = SQL.PostgresError;
    this.commitPoolShards = opts.commitPool ? [...opts.commitPool.shards] : undefined;
    if (this.commitPoolShards) {
      this.commitQuerierFor = (shardId) => this.commitQuerierForImpl(shardId);
      this.onShardConnectionLost = (cb) => {
        this.shardConnectionLostCbs.push(cb);
      };
      this.tryAcquireShardLock = (slot) => this.tryAcquireShardLockImpl(slot);
      this.releaseShardLock = (slot) => this.releaseShardLockImpl(slot);
    }
    // Kill switch (HELIPOD_PG_STREAM=0/"false"): leave `queryStream` unassigned so it stays
    // falsy — `index_scan`'s `if (this.db.queryStream)` gate then falls through to buffered `query`.
    if (resolveStreamingEnabled()) {
      this.queryStream = (sql, params) => this.queryStreamImpl(sql, params);
    }
  }

  /** Lazily reserve — and memoize — the ONE dedicated connection the writer lock and every
   *  `transaction()` share for this client's whole lifetime (RISK 2, see the class doc comment). */
  private ensurePinned(): Promise<BunSQLReservedConnection> {
    return (this.pinnedPromise ??= this.sql.reserve());
  }

  /** Re-tag a genuine `Bun.SQL.PostgresError`'s `.code` with its `.errno` (the real pg SQLSTATE) —
   *  see the class doc comment's `.code` normalization section. A non-`PostgresError` (connection
   *  loss, a plain `Error`) passes through untouched — it never had a SQLSTATE to begin with. */
  private normalizeError(e: unknown): unknown {
    if (e instanceof this.PostgresErrorCtor) {
      const errno = (e as unknown as BunPostgresErrorShape).errno;
      if (typeof errno === "string") (e as unknown as BunPostgresErrorShape).code = errno;
    }
    return e;
  }

  /** Run one statement on the pinned connection, routing a non-`PostgresError` failure (the
   *  connection-loss shape, not an ordinary SQL error) to the best-effort `onConnectionLost`
   *  callbacks before rethrowing (with `.code` normalized to the SQLSTATE). */
  private async pinnedUnsafe(
    pinned: BunSQLReservedConnection,
    text: string,
    params?: readonly PgValue[],
  ): Promise<BunSQLRow[]> {
    try {
      return await pinned.unsafe(text, params);
    } catch (e) {
      if (!(e instanceof this.PostgresErrorCtor)) this.fireConnectionLost();
      throw this.normalizeError(e);
    }
  }

  onConnectionLost(cb: () => void): void {
    this.connectionLostCbs.push(cb);
  }

  private fireConnectionLost(): void {
    if (this.connectionLostFired) return;
    this.connectionLostFired = true;
    for (const cb of this.connectionLostCbs) {
      try {
        cb();
      } catch {
        // A misbehaving callback must not mask the loss for the others (mirrors NodePgClient).
      }
    }
  }

  /** Reads (and single-statement autocommit writes) go through the general pool — `Bun.SQL`
   *  connects/borrows lazily per call, no explicit `ensure()` needed (unlike `NodePgClient`'s
   *  single unpooled connection). */
  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    try {
      const rows = await this.sql.unsafe(text, params);
      return normalizeRows(rows);
    } catch (e) {
      throw this.normalizeError(e);
    }
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    const pinned = await this.ensurePinned();
    const tx: PgQuerier = {
      query: async (text, params) => normalizeRows(await this.pinnedUnsafe(pinned, text, params)),
    };
    await this.pinnedUnsafe(pinned, "BEGIN");
    try {
      const result = await fn(tx);
      await this.pinnedUnsafe(pinned, "COMMIT");
      return result;
    } catch (e) {
      await this.pinnedUnsafe(pinned, "ROLLBACK");
      throw e;
    }
  }

  async acquireWriterLock(): Promise<void> {
    const pinned = await this.ensurePinned();
    const rows = normalizeRows(
      await this.pinnedUnsafe(pinned, `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]),
    );
    if (rows[0]?.ok !== true) {
      throw new Error("another Helipod engine is already connected to this database (advisory lock held)");
    }
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    const pinned = await this.ensurePinned();
    const rows = normalizeRows(
      await this.pinnedUnsafe(pinned, `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]),
    );
    return rows[0]?.ok === true;
  }

  /**
   * Borrow a reservation from the bounded stream pool (see the class doc comment's queryStream
   * section), building a new one lazily via `sql.reserve()` if under `STREAM_POOL_MAX` and none is
   * idle, or waiting for a release if the pool is already full. A `sql.reserve()` failure frees the
   * slot it reserved (`streamPoolTotal--`) and wakes one waiter with NO connection (so it loops back
   * and retries the now-freed slot itself) before rethrowing — without this, a transient reserve()
   * failure would permanently leak a pool slot, eventually deadlocking every future
   * `acquireStreamConn` (mirrors `NodePgClient.acquireReadConn`'s identical connect-failure lesson).
   */
  private async acquireStreamConn(): Promise<BunSQLReservedConnection> {
    for (;;) {
      if (this.streamPoolClosed) throw new Error("BunSqlClient: stream pool closed");
      const idle = this.streamPoolIdle.pop();
      if (idle) return idle;
      if (this.streamPoolTotal < STREAM_POOL_MAX) {
        this.streamPoolTotal++;
        try {
          const reserved = await this.sql.reserve();
          this.streamReservations.add(reserved);
          return reserved;
        } catch (e) {
          // The slot reserved by `streamPoolTotal++` above must be freed here, or enough
          // consecutive failures drive `streamPoolTotal` to `STREAM_POOL_MAX` with zero live
          // reservations, permanently hanging every future `acquireStreamConn` on
          // `streamPoolWaiters` (nothing left could ever release to wake them).
          this.streamPoolTotal = Math.max(0, this.streamPoolTotal - 1);
          this.streamPoolWaiters.shift()?.resolve(undefined);
          throw this.normalizeError(e);
        }
      }
      // Pool is at capacity: block until a release either hands us a connection DIRECTLY (FIFO-fair
      // healthy release, see `releaseStreamConn`) or wakes us with none (a discard freed a slot
      // instead) — in which case loop back and re-check, since the re-check may now build fresh.
      const handed = await new Promise<BunSQLReservedConnection | undefined>((resolve, reject) =>
        this.streamPoolWaiters.push({ resolve, reject }),
      );
      if (handed) return handed;
    }
  }

  /**
   * Return a borrowed stream reservation to the pool — or discard it if `broken` (the caller's
   * cursor loop errored, so the reservation may have a dangling portal/transaction and must not be
   * handed to the next borrower). Always called from `queryStreamImpl`'s `finally`, so a borrowed
   * reservation is never permanently lost and a waiter is never left hanging.
   *
   * FIFO fairness: a HEALTHY release hands the reservation DIRECTLY to the oldest queued waiter
   * (`waiter.resolve(conn)`) instead of pushing it to `streamPoolIdle` and merely waking the waiter
   * to go re-pop idle itself — closing the same microtask-gap starvation hole
   * `NodePgClient.releaseReadConn`'s doc comment documents (a brand-new, never-waited caller's own
   * synchronous `acquireStreamConn()` idle-pop could otherwise win the race and steal the
   * just-freed connection). Only when there is no waiter does a healthy reservation go back on the
   * idle stack.
   */
  private releaseStreamConn(conn: BunSQLReservedConnection, opts?: { broken?: boolean }): void {
    const broken = opts?.broken ?? false;
    if (broken || this.streamPoolClosed) {
      this.streamPoolTotal = Math.max(0, this.streamPoolTotal - 1);
      this.streamReservations.delete(conn);
      try {
        conn.release();
      } catch {
        // A release failure here must not mask the original stream error, nor block shutdown — a
        // concurrent close() may already have released this exact connection (best-effort overlap,
        // mirrors close()'s own try/catch around its force-release loop below).
      }
      this.streamPoolWaiters.shift()?.resolve(undefined);
      return;
    }
    const waiter = this.streamPoolWaiters.shift();
    if (waiter) {
      waiter.resolve(conn); // direct hand-off — never touches streamPoolIdle, no gap to steal through
    } else {
      this.streamPoolIdle.push(conn);
    }
  }

  /**
   * Stream rows via a SQL-level, non-holdable cursor (`DECLARE ... NO SCROLL CURSOR FOR <sql>` /
   * `FETCH <n> FROM <cursor>` / `CLOSE <cursor>`, issued as ordinary `unsafe()` statements on a
   * reservation borrowed from the bounded stream pool — see the class doc comment's queryStream
   * section for why `Bun.SQL` needs this instead of a native cursor API, and why the pool exists).
   * Batches adaptively: starts at `STREAM_BATCH_INITIAL` rows per `FETCH` and doubles after each
   * fetch up to `STREAM_BATCH_MAX`, matching `NodePgClient`'s `pg-cursor` batching exactly.
   *
   * The reservation is released back to the pool in `finally` on every exit path (full drain, an
   * early consumer `break` — an async generator's `finally` runs on the implicit `.return()` that
   * produces — or a thrown error, `broken: true`). A non-holdable cursor is implicitly dropped when
   * its transaction ends, but `CLOSE` is issued explicitly first for clarity/symmetry with
   * `NodePgClient`. On error, `ROLLBACK` (not `COMMIT`) — this path never writes, so either is
   * transactionally safe, but `ROLLBACK` is the honest outcome for a broken stream.
   */
  private async *queryStreamImpl(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow> {
    const reserved = await this.acquireStreamConn();
    const cursorName = `helipod_stream_${this.nextStreamCursorId++}`;
    let batch = STREAM_BATCH_INITIAL;
    let broken = false;
    try {
      await reserved.unsafe("BEGIN");
      await reserved.unsafe(`DECLARE ${cursorName} NO SCROLL CURSOR FOR ${sql}`, params);
      for (;;) {
        const rows = await reserved.unsafe(`FETCH ${batch} FROM ${cursorName}`);
        if (rows.length === 0) break;
        for (const r of normalizeRows(rows)) yield r;
        batch = Math.min(batch * 2, STREAM_BATCH_MAX);
      }
    } catch (e) {
      broken = true;
      throw this.normalizeError(e);
    } finally {
      await reserved.unsafe(`CLOSE ${cursorName}`).catch(() => {});
      await reserved.unsafe(broken ? "ROLLBACK" : "COMMIT").catch(() => {});
      this.releaseStreamConn(reserved, { broken });
    }
  }

  // ---- Per-shard commit pool (mirrors NodePgClient's Fenced Frontier B2a support) --------------

  /** Resolve the (lazily-created, lazily-reserved) commit connection for `shardId`. A rejected
   *  reservation evicts the whole cache entry (mirrors `NodePgClient.ensureShardConn`) so the NEXT
   *  call for this shard builds fresh instead of replaying the same rejection forever. */
  private ensureShardConn(shardId: string): ShardCommitConn {
    if (!this.commitPoolShards) throw new Error("BunSqlClient: commit pool not configured (no commitPool option)");
    if (!this.commitPoolShards.includes(shardId)) {
      throw new Error(`BunSqlClient: '${shardId}' is not a configured commit-pool shard`);
    }
    let conn = this.commitConns.get(shardId);
    if (!conn) {
      conn = { shardId, lostFired: false };
      this.commitConns.set(shardId, conn);
    }
    const c = conn;
    c.connPromise ??= this.sql.reserve().catch((e: unknown) => {
      if (this.commitConns.get(shardId) === c) this.commitConns.delete(shardId);
      throw e;
    });
    return c;
  }

  private shardSlotToId(slot: number): string {
    if (!this.commitPoolShards) throw new Error("BunSqlClient: commit pool not configured (no commitPool option)");
    const shardId = this.commitPoolShards[slot];
    if (shardId === undefined) {
      throw new Error(`BunSqlClient: shard slot ${slot} out of range (pool has ${this.commitPoolShards.length} shards)`);
    }
    return shardId;
  }

  /** Run one statement on a shard's dedicated commit connection, routing a non-`PostgresError`
   *  failure to that shard's connection-lost callbacks before rethrowing (`.code` normalized). */
  private async shardUnsafe(conn: ShardCommitConn, text: string, params?: readonly PgValue[]): Promise<BunSQLRow[]> {
    const reserved = await conn.connPromise!;
    try {
      return await reserved.unsafe(text, params);
    } catch (e) {
      if (!(e instanceof this.PostgresErrorCtor)) this.fireShardConnectionLost(conn);
      throw this.normalizeError(e);
    }
  }

  private async commitQuerierForImpl(shardId: string): Promise<PgTransactionalQuerier> {
    const conn = this.ensureShardConn(shardId);
    await conn.connPromise; // surface a connect failure here, before handing back a querier
    // A querier whose query() and transaction() BOTH run on THIS shard's dedicated connection, so the
    // whole commitWrite (nextval → inserts → guard → COMMIT) is one atomic session, concurrent with
    // other shards' commits on their own connections.
    const querier: PgQuerier = {
      query: async (text, params) => normalizeRows(await this.shardUnsafe(conn, text, params)),
    };
    return {
      ...querier,
      transaction: async <T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> => {
        await this.shardUnsafe(conn, "BEGIN");
        try {
          const result = await fn(querier);
          await this.shardUnsafe(conn, "COMMIT");
          return result;
        } catch (e) {
          await this.shardUnsafe(conn, "ROLLBACK");
          throw e;
        }
      },
    };
  }

  private fireShardConnectionLost(conn: ShardCommitConn): void {
    if (conn.lostFired) return;
    conn.lostFired = true;
    for (const cb of this.shardConnectionLostCbs) {
      try {
        cb(conn.shardId);
      } catch {
        // A misbehaving callback must not mask the loss for the others (mirrors the pinned path).
      }
    }
  }

  private async tryAcquireShardLockImpl(slot: number): Promise<boolean> {
    const shardId = this.shardSlotToId(slot);
    const conn = this.ensureShardConn(shardId);
    // Two-int form ON the shard's commit connection → the lock is bound to that session; the
    // connection's death releases exactly this slot, nothing else.
    const rows = normalizeRows(
      await this.shardUnsafe(conn, `SELECT pg_try_advisory_lock($1, $2) AS ok`, [SHARD_ADVISORY_LOCK_CLASS, slot]),
    );
    return rows[0]?.ok === true;
  }

  /** Release slot `slot`'s per-shard advisory lock — the exact mirror of `tryAcquireShardLockImpl`.
   *  A slot with no lock held resolves as a no-op (the caller doesn't need the boolean
   *  `pg_advisory_unlock` returns). */
  private async releaseShardLockImpl(slot: number): Promise<void> {
    const shardId = this.shardSlotToId(slot);
    const conn = this.ensureShardConn(shardId);
    await this.shardUnsafe(conn, `SELECT pg_advisory_unlock($1, $2) AS ok`, [SHARD_ADVISORY_LOCK_CLASS, slot]);
  }

  async close(): Promise<void> {
    if (this.pinnedPromise) {
      // `sql.end()` hangs forever while any connection is still reserved (verified empirically) —
      // release it back to the pool first. A rejected reservation has nothing to release.
      const pinned = await this.pinnedPromise.catch(() => undefined);
      pinned?.release();
      this.pinnedPromise = undefined;
    }
    // Tear down every commit-pool connection the same way — set the per-shard fired-guard FIRST so
    // a graceful close never trips a spurious per-shard connection-lost fire (mirrors the pinned path).
    for (const conn of this.commitConns.values()) {
      conn.lostFired = true;
      if (conn.connPromise) {
        const reserved = await conn.connPromise.catch(() => undefined);
        reserved?.release();
      }
    }
    this.commitConns.clear();
    // Drain the stream pool: mark closed FIRST so any `queryStreamImpl` finishing concurrently
    // releases its reservation via `releaseStreamConn`'s discard path (release-and-decrement, not
    // back to idle) rather than racing to hand off to a waiter that's about to be rejected anyway —
    // mirrors `NodePgClient`'s `readPoolClosed` ordering. `streamReservations` tracks every
    // reservation this client currently holds (pooled-idle AND still-borrowed by an in-flight/
    // abandoned generator — e.g. a consumer mid-iteration that stopped calling `.next()` without
    // draining or `break`ing, whose own `finally` never runs to release it), so force-releasing all
    // of them here is what unblocks `sql.end()`, which otherwise hangs forever waiting for a
    // reserved connection nobody will ever return on its own (RISK 2, see the class doc comment).
    // Best-effort for a still-borrowed one: its generator may still be suspended holding an open
    // cursor/transaction on this connection, but releasing it back to the pool unblocks `sql.end()`
    // regardless of that generator's fate.
    this.streamPoolClosed = true;
    // A reservation whose `acquireStreamConn` is still awaiting `sql.reserve()` when this loop runs
    // isn't in `streamReservations` yet, so it isn't force-released here — but it self-cleans: once
    // the reserve() resolves, `queryStreamImpl` runs BEGIN/DECLARE on it, that fails against a
    // closing pool, and its own `finally` sees `streamPoolClosed` and discards it via
    // `releaseStreamConn`'s broken path. So this drain loop doesn't need to (and can't) wait for it,
    // and `close()` doesn't hang on it.
    for (const reserved of this.streamReservations) {
      try {
        reserved.release();
      } catch {
        // A release failure here must not block sql.end() from completing.
      }
    }
    this.streamReservations.clear();
    this.streamPoolIdle.length = 0;
    this.streamPoolTotal = 0;
    const streamWaiters = this.streamPoolWaiters.splice(0);
    for (const w of streamWaiters) w.reject(new Error("BunSqlClient: stream pool closed"));
    await this.sql.end();
  }
}
