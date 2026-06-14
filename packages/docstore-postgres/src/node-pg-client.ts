/**
 * The production `PgClient` over `pg` (node-postgres). Honors the seam's normalization
 * contract (see `./pg-client.ts`): `query` returns int8 (OID 20) as JS `bigint` and bytea
 * (OID 17) as `Uint8Array`, and accepts `Uint8Array` params for bytea columns.
 *
 * `pg`'s default int8 decoding is a STRING (it refuses to guess between number/bigint), so
 * a type parser must be wired for OID 20. This uses `pg`'s documented per-Client override —
 * `new Client({ types: { getTypeParser(oid, format) { ... } } })` — verified against the
 * installed `pg@8.22.0`: `Client` wraps the passed `types` in a `TypeOverrides` instance
 * whose `getTypeParser` falls through to the passed object for any oid without a `setTypeParser`
 * override, so this is real per-client wiring, not a global mutation of `pg.types`.
 *
 * Uses a single pinned `pg.Client` connection (not a `Pool`) for queries, `write()`, the writer
 * lock, lease heartbeats/eviction and setup — the engine is single-writer, so one connection is all
 * a single-shard `PostgresDocStore` ever needs, and `transaction` requires pinning to one connection
 * anyway (a `Pool` would risk BEGIN/COMMIT landing on different connections).
 *
 * The ONE exception (Fenced Frontier B2a, D1): when constructed with `commitPool`, a dedicated
 * `pg.Client` is lazily opened PER SHARD for `commitWrite` transactions only. Concurrent cross-shard
 * commits need independent Postgres sessions — two `transaction()` calls on one session interleave
 * into a single BEGIN/COMMIT and corrupt atomicity. Each commit connection gets the same session
 * timeouts (hazard (a)), routes its loss to that shard's lease (hazard (b)), and hosts that slot's
 * session-scoped advisory lock (hazard (c)). LISTEN keeps its own separate connection, unchanged.
 *
 * `queryStream` (Task 4) is a SECOND exception, for the same reason LISTEN is: a `pg-cursor` portal
 * occupies its connection's query slot for the cursor's ENTIRE lifetime (every intervening `read()`
 * round trip), so running it on the pinned connection would stall every other query/write/transaction
 * on that connection until the stream finishes or is closed — and would outright corrupt an
 * in-progress writer transaction if a caller streamed mid-`transaction()`. So `queryStream` borrows a
 * connection from a small BOUNDED READ POOL (Task 9) instead of the pinned one — up to `READ_POOL_MAX`
 * dedicated `pg.Client`s (same `buildClient` helper: same int8→bigint type map, same `application_name`
 * convention), built lazily and REUSED across calls rather than opened-and-torn-down per call (a fresh
 * TCP+auth handshake per read was a real regression for small/typical reads). A connection that errors
 * mid-stream is discarded (never returned to the pool — it may have a dangling cursor/transaction);
 * a healthy one is returned to the idle pool for the next caller. `close()` drains the whole pool. This
 * also sidesteps any need for the mutex the PGlite test client uses to serialize concurrent streams on
 * its one shared session — real `pg` connections are independent.
 */
import pg from "pg";
import Cursor from "pg-cursor";
import type { PgClient, PgQuerier, PgRow, PgTransactionalQuerier, PgValue } from "./pg-client";
import {
  ADVISORY_LOCK_KEY,
  SHARD_ADVISORY_LOCK_CLASS,
  STREAM_BATCH_INITIAL,
  STREAM_BATCH_MAX,
} from "./pg-client";

const { Client, types } = pg;

// int8 (OID 20) → bigint (pg defaults to string). Set on a per-client type map, not globally.
const INT8_OID = 20;

/** Bounded read-connection pool size for `queryStream` (Task 9). A cursor needs its own dedicated
 *  connection (can't share the pinned writer mid-transaction) — this caps how many such connections
 *  can exist concurrently, reused across calls instead of opened-and-torn-down per call. */
const READ_POOL_MAX = 4;

/** Bounded-writer-session timeouts (Fenced Frontier B1, D4). Applied ONLY to fleet writer-capable
 *  connections (see `prepareFleetNode`) — a non-fleet single-node `NodePgClient` passes no
 *  `sessionTimeouts` and runs unbounded, exactly as before. */
export interface PgSessionTimeouts {
  /** `idle_in_transaction_session_timeout` — kills a transaction left open (a wedged writer stuck
   *  mid-commit holding the row lock a fencer needs). Milliseconds. */
  idleInTransactionMs: number;
  /** `statement_timeout` — caps any single runaway statement. Milliseconds. */
  statementMs: number;
}

/**
 * The `SET` statements that install {@link PgSessionTimeouts} on a connection — a pure builder so the
 * exact SQL is unit-testable without a live Postgres. Issued post-connect on the pinned connection
 * (see `ensure()`), NOT via the `options`/`-c` connection-string param: pg merges a parsed connection
 * string OVER explicit config fields (the same footgun the `application_name` wiring below documents),
 * so an app-supplied `options=` in the URL would silently shadow a config-field `options`; a plain
 * post-connect `SET` on the already-pinned single connection has no such merge ambiguity. Both GUCs
 * read a bare integer as MILLISECONDS.
 */
export function pgSessionTimeoutStatements(t: PgSessionTimeouts): string[] {
  return [
    `SET idle_in_transaction_session_timeout = ${Math.trunc(t.idleInTransactionMs)}`,
    `SET statement_timeout = ${Math.trunc(t.statementMs)}`,
  ];
}

function toDriverParams(params?: readonly PgValue[]): unknown[] | undefined {
  if (!params) return undefined;
  // pg wants a Buffer for bytea; convert Uint8Array → Buffer. bigint is serialized fine by pg as text.
  return params.map((p) => (p instanceof Uint8Array ? Buffer.from(p) : p));
}
function normalizeValue(v: unknown): PgValue {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return new Uint8Array(v); // bytea → Uint8Array
  return v as PgValue; // int8 handled by the type parser below → bigint
}
function normalizeRows(rows: Record<string, unknown>[]): PgRow[] {
  return rows.map((r) => {
    const out: PgRow = {};
    for (const [k, val] of Object.entries(r)) out[k] = normalizeValue(val);
    return out;
  });
}

/** One shard's dedicated commit connection (D1). Lazily opened; `connected` gates teardown; `lostFired`
 *  guards a single per-shard connection-lost fire (error-then-end double-event, and graceful close). */
interface ShardCommitConn {
  readonly shardId: string;
  readonly client: pg.Client;
  connectPromise?: Promise<void>;
  connected: boolean;
  lostFired: boolean;
}

export class NodePgClient implements PgClient {
  private readonly client: pg.Client;
  private readonly connectionString: string;
  private readonly applicationName?: string;
  private connected = false;
  private connectPromise?: Promise<void>;
  private readonly connectionLostCbs: Array<() => void> = [];
  private connectionLostFired = false;
  /** Bounded-writer-session timeouts, applied post-connect in `ensure()`. Undefined (the default,
   *  and every non-fleet construction) → no `SET`, unbounded session. Public+readonly so a fleet
   *  boot can be introspected in tests without a live connection. */
  readonly sessionTimeouts?: PgSessionTimeouts;
  /** Ordered commit-pool shard list (index = slot), or undefined for a non-pool (single-shard) client.
   *  Public+readonly so a fleet boot / test can introspect the configured shards without connecting. */
  readonly commitPoolShards?: readonly string[];
  /** Lazily-opened per-shard commit connections (pool mode only). */
  private readonly commitConns = new Map<string, ShardCommitConn>();
  private readonly shardConnectionLostCbs: Array<(shardId: string) => void> = [];

  // ---- Bounded read-connection pool for queryStream (Task 9) --------------------------------
  /** Idle, healthy, ready-to-borrow read connections. */
  private readonly readPoolIdle: pg.Client[] = [];
  /** Count of read connections that exist (idle + currently borrowed) — bounds total pool size
   *  without needing a separate "in use" list. */
  private readPoolTotal = 0;
  /** Connections an `on("error")` fired on — checked (and cleared) at release time so an errored
   *  connection is discarded instead of returned to the idle pool, even if the borrower didn't
   *  itself notice (e.g. the error landed after the last `read()` but before release). */
  private readonly readPoolBroken = new WeakSet<pg.Client>();
  /** FIFO of waiters blocked on `acquireReadConn` when the pool is at `READ_POOL_MAX`. Woken (or
   *  rejected, on `close()`) by `releaseReadConn`/`close()`. */
  private readonly readPoolWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  /** Set by `close()`; makes any further `acquireReadConn` reject instead of hanging forever. */
  private readPoolClosed = false;

  // The three pool capabilities are PRESENT (bound in the constructor) only when a `commitPool` is
  // configured, and absent otherwise — so `PostgresDocStore.commitWrite`'s `if (db.commitQuerierFor)`
  // presence check correctly keeps a poolless single-node client on the pinned path. See the bindings
  // in the constructor; the real bodies are the `*Impl` methods below.
  readonly commitQuerierFor?: (shardId: string) => Promise<PgTransactionalQuerier>;
  readonly onShardConnectionLost?: (cb: (shardId: string) => void) => void;
  readonly tryAcquireShardLock?: (slot: number) => Promise<boolean>;
  readonly releaseShardLock?: (slot: number) => Promise<void>;

  constructor(opts: {
    connectionString: string;
    applicationName?: string;
    sessionTimeouts?: PgSessionTimeouts;
    /** Per-shard commit-connection pool (Fenced Frontier B2a, D1). `shards` is the ordered slot list —
     *  `shards[slot]` is the shard id `tryAcquireShardLock(slot)` locks. Unset → single pinned connection,
     *  byte-identical to today (the poolless `commitWrite` path the conformance suite proves). */
    commitPool?: { shards: readonly string[] };
  }) {
    this.connectionString = opts.connectionString;
    this.applicationName = opts.applicationName;
    this.sessionTimeouts = opts.sessionTimeouts;
    this.commitPoolShards = opts.commitPool ? [...opts.commitPool.shards] : undefined;
    this.client = this.buildClient(opts.applicationName);
    // Expose the pool capabilities ONLY in pool mode (presence == capability, per the PgClient seam).
    if (this.commitPoolShards) {
      this.commitQuerierFor = (shardId) => this.commitQuerierForImpl(shardId);
      this.onShardConnectionLost = (cb) => {
        this.shardConnectionLostCbs.push(cb);
      };
      this.tryAcquireShardLock = (slot) => this.tryAcquireShardLockImpl(slot);
      this.releaseShardLock = (slot) => this.releaseShardLockImpl(slot);
    }
  }

  /** Build a `pg.Client` on this client's connection string, with the shared int8→bigint type map and
   *  an optional `application_name`. Used for the pinned connection and every per-shard commit connection
   *  (so they carry the SAME normalization contract); LISTEN builds its own thinner client separately. */
  private buildClient(applicationName?: string): pg.Client {
    return new Client({
      connectionString: this.connectionString,
      // Tag this connection's backend in pg_stat_activity when a name is supplied (fleet nodes pass a
      // per-node `stackbase-fleet-<port>` so an operator — or the fleet self-exit E2E — can identify
      // and target one node's backends). Passed as an explicit config field, not appended to the
      // connection string: pg merges the parsed connection string OVER explicit fields, so this only
      // survives because our connection strings never set `application_name` themselves.
      application_name: applicationName,
      // Per-client type map: int8 (OID 20) → bigint; every other OID keeps pg's default parser.
      types: {
        getTypeParser: (oid: number, format?: string) =>
          oid === INT8_OID
            ? (val: string) => BigInt(val)
            : (types.getTypeParser as (oid: number, format?: string) => (val: string) => unknown)(oid, format),
      },
    });
  }

  private ensure(): Promise<void> {
    // Memoize the in-flight connect promise so concurrent first-callers (e.g.
    // Promise.all([store.get(a), store.get(b)]) before any awaited setup) all
    // await the SAME connect() rather than each racing check-then-await-then-set
    // and calling this.client.connect() twice (pg rejects the second call).
    return (this.connectPromise ??= (() => {
      // Attach connection-loss listeners on the single pinned connection the moment we connect it.
      // A closed/errored pinned connection is DEFINITIVE — `ensure()` memoizes and never reconnects,
      // and the session-level advisory lock is released by Postgres when the backend goes away — so
      // fire the registered callbacks exactly once (guarding the error-then-end double-fire).
      this.client.on("error", () => this.fireConnectionLost());
      this.client.on("end", () => this.fireConnectionLost());
      return this.client.connect().then(async () => {
        // Install the bounded-session timeouts (fleet writer-capable connections only) BEFORE marking
        // connected, so they're in force for the very first query/transaction — no window where an
        // unbounded statement could run pre-SET. Chained into the memoized connect promise, so every
        // `ensure()` awaiter observes them applied.
        if (this.sessionTimeouts) {
          for (const stmt of pgSessionTimeoutStatements(this.sessionTimeouts)) {
            await this.client.query(stmt);
          }
        }
        this.connected = true;
      });
    })());
  }

  /**
   * Register a callback fired once when the pinned connection is lost (error/end). Used by the fleet
   * writer lease monitor to treat a dropped connection as definitive lease loss. Multiple callbacks
   * allowed; all fire (a throwing one can't mask the loss for the others). Absent on drivers that
   * don't need it (the seam member is optional).
   */
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
        // A misbehaving callback must not mask the connection loss for the others.
      }
    }
  }

  /** Run + normalize a query on a specific connection (the pinned one, or a shard's commit connection).
   *  Assumes the connection is already established — callers `await` the relevant `ensure`/`connectPromise`. */
  private async queryOn(client: pg.Client, text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const res = await client.query(text, toDriverParams(params));
    return normalizeRows(res.rows as Record<string, unknown>[]);
  }

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    await this.ensure();
    return this.queryOn(this.client, text, params);
  }

  /**
   * Borrow a connection from the bounded read pool (Task 9), building a new one lazily if under
   * `READ_POOL_MAX` and none is idle, or waiting for a release if the pool is already full. Every
   * connection this builds gets its own `on("error")` listener — attached ONCE, for the connection's
   * whole pooled lifetime (not per-borrow) — for the same reason the pinned connection and per-shard
   * commit connections do (`ensure()`/`fireShardConnectionLost`): with zero 'error' listeners, Node/Bun
   * throws an unhandled 'error' event as an uncaught exception on a connection-level failure (socket
   * ECONNRESET, backend killed via pg_terminate_backend, mid-stream disconnect). The listener just
   * marks the connection broken in `readPoolBroken`; `releaseReadConn` is what actually discards it.
   *
   * Deliberately skips the fleet `sessionTimeouts` (statement_timeout / idle_in_transaction_session_timeout)
   * applied to the pinned connection in `ensure()` — a v1 omission, not an oversight: a stream may
   * legitimately want a longer (or no) statement timeout than a normal write transaction.
   */
  private async acquireReadConn(): Promise<pg.Client> {
    for (;;) {
      if (this.readPoolClosed) throw new Error("NodePgClient: read pool closed");
      const idle = this.readPoolIdle.pop();
      if (idle) return idle;
      if (this.readPoolTotal < READ_POOL_MAX) {
        this.readPoolTotal++;
        const conn = this.buildClient(this.applicationName ? `${this.applicationName}-stream` : undefined);
        conn.on("error", () => {
          this.readPoolBroken.add(conn);
        });
        await conn.connect();
        return conn;
      }
      // Pool is at capacity: block until a release wakes us, then loop back and re-check (a
      // released-broken connection frees a `readPoolTotal` slot rather than enqueuing to idle, so
      // the re-check may build fresh instead of finding something idle).
      await new Promise<void>((resolve, reject) => this.readPoolWaiters.push({ resolve, reject }));
    }
  }

  /**
   * Return a borrowed read connection to the pool — or discard it if `broken` (explicitly, because
   * the caller's read loop errored) or if an `on("error")` already flagged it in `readPoolBroken`
   * (a connection-level failure the caller's read loop never itself observed). A discarded connection
   * is `end()`ed and its `readPoolTotal` slot freed; a healthy one goes back on the idle stack. Either
   * way, wakes one waiter (if any) — always called from `queryStream`'s `finally`, so a borrowed
   * connection is never permanently lost and a waiter is never left hanging.
   */
  private releaseReadConn(conn: pg.Client, opts?: { broken?: boolean }): void {
    const broken = (opts?.broken ?? false) || this.readPoolBroken.has(conn);
    this.readPoolBroken.delete(conn);
    if (broken || this.readPoolClosed) {
      this.readPoolTotal = Math.max(0, this.readPoolTotal - 1);
      conn.end().catch(() => {});
    } else {
      this.readPoolIdle.push(conn);
    }
    const waiter = this.readPoolWaiters.shift();
    waiter?.resolve();
  }

  /**
   * Stream rows via a real server-side cursor (`pg-cursor`, the extended-query-protocol Parse/Bind/
   * Describe/Execute portal — NOT SQL `DECLARE ... CURSOR`, and critically NOT `WITH HOLD`: a holdable
   * cursor materializes its entire result into a tuplestore at commit time regardless of how few rows
   * the caller actually reads, which defeats the whole point of streaming — an early `break` must
   * leave the remaining range genuinely uncomputed by the server). Batches adaptively: starts at
   * `STREAM_BATCH_INITIAL` rows per `cursor.read()` round trip and doubles after each fetch up to
   * `STREAM_BATCH_MAX` — cheap on an early `break` (only the first small batch is ever computed),
   * few round trips on a full drain.
   *
   * Borrows a connection from the bounded read pool (see `acquireReadConn`/the class doc comment)
   * instead of opening a fresh one per call. Released in `finally` on every exit path: full drain, an
   * early consumer `break` (an async generator's `finally` runs on the implicit `.return()` that
   * produces), or a thrown error — marked `broken` on the error path, since a connection that failed
   * mid-cursor may have a dangling portal/transaction and must not be handed to the next borrower.
   * `cursor.close()` closes the portal and syncs the session; it's best-effort (`.catch(() => {})`) so
   * a failure closing an already-broken cursor can't mask the real error or block releasing the
   * connection.
   */
  async *queryStream(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow> {
    const conn = await this.acquireReadConn();
    const cursor = conn.query(new Cursor(sql, toDriverParams(params) ?? []));
    let batch = STREAM_BATCH_INITIAL;
    let broken = false;
    try {
      for (;;) {
        const rows = await cursor.read(batch);
        if (rows.length === 0) break;
        for (const r of normalizeRows(rows as Record<string, unknown>[])) yield r;
        batch = Math.min(batch * 2, STREAM_BATCH_MAX);
      }
    } catch (e) {
      broken = true;
      throw e;
    } finally {
      await cursor.close().catch(() => {});
      this.releaseReadConn(conn, { broken });
    }
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    await this.ensure();
    await this.client.query("BEGIN");
    try {
      const result = await fn(this); // single-writer: reuse the one pinned connection
      await this.client.query("COMMIT");
      return result;
    } catch (e) {
      await this.client.query("ROLLBACK");
      throw e;
    }
  }

  async acquireWriterLock(): Promise<void> {
    await this.ensure();
    // session-level, non-blocking: fail fast if another engine holds it.
    const rows = await this.query(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    if (rows[0]?.ok !== true) {
      throw new Error("another Stackbase engine is already connected to this database (advisory lock held)");
    }
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    await this.ensure();
    // Non-blocking: resolve true/false instead of throwing — callers (fleet failover) poll this.
    const rows = await this.query(`SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]);
    return rows[0]?.ok === true;
  }

  // ---- Per-shard commit pool (Fenced Frontier B2a, D1) -----------------------------------------

  /** Resolve the (lazily-created, lazily-connected) commit connection for `shardId`, returning it
   *  together with the memoized connect promise every caller awaits. Connecting installs the SAME
   *  session timeouts as the pinned connection (hazard (a)) and wires error/end → per-shard loss
   *  (hazard (b)), both BEFORE marking it connected so no unbounded/un-monitored window exists. */
  private ensureShardConn(shardId: string): ShardCommitConn {
    if (!this.commitPoolShards) throw new Error("NodePgClient: commit pool not configured (no commitPool option)");
    if (!this.commitPoolShards.includes(shardId)) {
      throw new Error(`NodePgClient: '${shardId}' is not a configured commit-pool shard`);
    }
    let conn = this.commitConns.get(shardId);
    if (!conn) {
      const client = this.buildClient(this.applicationName ? `${this.applicationName}-commit-${shardId}` : undefined);
      conn = { shardId, client, connected: false, lostFired: false };
      this.commitConns.set(shardId, conn);
    }
    const c = conn;
    c.connectPromise ??= (() => {
      c.client.on("error", () => this.fireShardConnectionLost(c));
      c.client.on("end", () => this.fireShardConnectionLost(c));
      const promise = c.client.connect().then(async () => {
        if (this.sessionTimeouts) {
          for (const stmt of pgSessionTimeoutStatements(this.sessionTimeouts)) {
            await c.client.query(stmt);
          }
        }
        c.connected = true;
      });
      // A rejected connect poisons `c.client` forever — `pg.Client` refuses a second `connect()`
      // call on the same instance ("Client has already been connected. You cannot reuse a
      // client."), even after a failed first attempt. So a memoized-forever `connectPromise`
      // would replay this same rejection on every future call for this shard's process lifetime.
      // Evict the WHOLE cache entry (not just `connectPromise`) on rejection, attached here
      // BEFORE this promise is returned to the caller, so the eviction always runs ahead of the
      // caller's own `await conn.connectPromise` (promise handlers fire in attachment order) —
      // the in-flight caller still observes the original rejection via the returned promise
      // itself, but the NEXT `ensureShardConn(shardId)` call finds no cached entry and builds a
      // fresh `pg.Client` + connection from scratch.
      promise.catch(() => {
        if (this.commitConns.get(shardId) === c) this.commitConns.delete(shardId);
      });
      return promise;
    })();
    return c;
  }

  private async commitQuerierForImpl(shardId: string): Promise<PgTransactionalQuerier> {
    const conn = this.ensureShardConn(shardId);
    await conn.connectPromise;
    // A querier whose query() and transaction() BOTH run on THIS shard's dedicated connection, so the
    // whole commitWrite (nextval → inserts → guard → COMMIT) is one atomic session, concurrent with
    // other shards' commits on their own connections.
    const querier: PgQuerier = { query: (text, params) => this.queryOn(conn.client, text, params) };
    return {
      ...querier,
      transaction: async <T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> => {
        await conn.client.query("BEGIN");
        try {
          const result = await fn(querier);
          await conn.client.query("COMMIT");
          return result;
        } catch (e) {
          await conn.client.query("ROLLBACK");
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
    if (!this.commitPoolShards) throw new Error("NodePgClient: commit pool not configured (no commitPool option)");
    const shardId = this.commitPoolShards[slot];
    if (shardId === undefined) {
      throw new Error(`NodePgClient: shard slot ${slot} out of range (pool has ${this.commitPoolShards.length} shards)`);
    }
    const conn = this.ensureShardConn(shardId);
    await conn.connectPromise;
    // Two-int form ON the shard's commit connection → the lock is bound to that session; the
    // connection's death releases exactly this slot, nothing else (D1 hazard (c) / D5 per-slot locks).
    const rows = await this.queryOn(conn.client, `SELECT pg_try_advisory_lock($1, $2) AS ok`, [
      SHARD_ADVISORY_LOCK_CLASS,
      slot,
    ]);
    return rows[0]?.ok === true;
  }

  /**
   * Release slot `slot`'s per-shard advisory lock — the exact mirror of {@link tryAcquireShardLockImpl}:
   * same shard resolution, same connection, the `pg_advisory_unlock` two-int counterpart of the
   * `pg_try_advisory_lock` it undoes. Used by the fleet relinquish dispatcher (B2b, D2) when a fence
   * policy decides to drop a shard WITHOUT tearing down the connection itself — releasing here leaves
   * the connection open and every OTHER slot's lock untouched, so the same node can re-acquire this
   * slot later (or another node can, immediately). A slot with no lock held resolves as a no-op (the
   * caller doesn't need the boolean `pg_advisory_unlock` returns — either way the lock is not held by
   * this session afterward).
   */
  private async releaseShardLockImpl(slot: number): Promise<void> {
    if (!this.commitPoolShards) throw new Error("NodePgClient: commit pool not configured (no commitPool option)");
    const shardId = this.commitPoolShards[slot];
    if (shardId === undefined) {
      throw new Error(`NodePgClient: shard slot ${slot} out of range (pool has ${this.commitPoolShards.length} shards)`);
    }
    const conn = this.ensureShardConn(shardId);
    await conn.connectPromise;
    await this.queryOn(conn.client, `SELECT pg_advisory_unlock($1, $2) AS ok`, [SHARD_ADVISORY_LOCK_CLASS, slot]);
  }

  /**
   * LISTEN on a dedicated connection — `pg.Client` delivers `notification` events only on the
   * connection that issued LISTEN, and the main connection is busy with query/transaction
   * traffic, so a second connection is created lazily (only if `listen` is ever called) reusing
   * the same connection string. The returned closer ends that connection; safe to call once.
   */
  async listen(channel: string, onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    const listener = new Client({ connectionString: this.connectionString, application_name: this.applicationName });
    await listener.connect();
    listener.on("notification", (msg) => {
      if (msg.channel === channel && msg.payload !== undefined) onNotify(msg.payload);
    });
    try {
      await listener.query(`LISTEN "${channel.replace(/"/g, '""')}"`);
    } catch (e) {
      // The dedicated connection connected fine but LISTEN itself failed — end it before
      // rethrowing so a failed listen() doesn't leak a live Postgres connection.
      await listener.end();
      throw e;
    }
    let closed = false;
    return async () => {
      if (closed) return;
      closed = true;
      await listener.end();
    };
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
  }

  async close(): Promise<void> {
    if (this.connected) {
      // A deliberate close is not a lost connection: suppress the `end`-event fire so a graceful
      // shutdown never trips the writer lease monitor into a spurious process.exit(1).
      this.connectionLostFired = true;
      await this.client.end();
      this.connected = false;
      this.connectPromise = undefined;
    }
    // Tear down every commit-pool connection. Set the per-shard fired-guard FIRST so the resulting
    // `end` event never routes a graceful shutdown into a spurious per-shard lease loss (mirrors the
    // pinned path above). Only `end()` a connection that actually finished connecting.
    for (const conn of this.commitConns.values()) {
      conn.lostFired = true;
      if (conn.connectPromise) {
        try {
          await conn.connectPromise;
        } catch {
          continue; // never connected (connect() rejected) → nothing to end
        }
        if (conn.connected) await conn.client.end();
      }
    }
    this.commitConns.clear();

    // Drain the read pool: mark closed FIRST so any `queryStream` finishing concurrently releases
    // its connection as end()-and-discard (see `releaseReadConn`) rather than back to idle, then end
    // every currently-idle connection and reject every waiter (best-effort for in-use connections —
    // they're the concurrently-finishing case just described, not silently dropped).
    this.readPoolClosed = true;
    const idleConns = this.readPoolIdle.splice(0);
    for (const conn of idleConns) {
      this.readPoolTotal = Math.max(0, this.readPoolTotal - 1);
      await conn.end().catch(() => {});
    }
    const waiters = this.readPoolWaiters.splice(0);
    for (const w of waiters) w.reject(new Error("NodePgClient: closed"));
  }
}
