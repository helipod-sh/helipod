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
 */
import pg from "pg";
import type { PgClient, PgQuerier, PgRow, PgTransactionalQuerier, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY, SHARD_ADVISORY_LOCK_CLASS } from "./pg-client";

const { Client, types } = pg;

// int8 (OID 20) → bigint (pg defaults to string). Set on a per-client type map, not globally.
const INT8_OID = 20;

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

  // The three pool capabilities are PRESENT (bound in the constructor) only when a `commitPool` is
  // configured, and absent otherwise — so `PostgresDocStore.commitWrite`'s `if (db.commitQuerierFor)`
  // presence check correctly keeps a poolless single-node client on the pinned path. See the bindings
  // in the constructor; the real bodies are the `*Impl` methods below.
  readonly commitQuerierFor?: (shardId: string) => Promise<PgTransactionalQuerier>;
  readonly onShardConnectionLost?: (cb: (shardId: string) => void) => void;
  readonly tryAcquireShardLock?: (slot: number) => Promise<boolean>;

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
      return c.client.connect().then(async () => {
        if (this.sessionTimeouts) {
          for (const stmt of pgSessionTimeoutStatements(this.sessionTimeouts)) {
            await c.client.query(stmt);
          }
        }
        c.connected = true;
      });
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
  }
}
