/**
 * The "Bun is primary" native `PgClient` over `Bun.SQL` — Bun's built-in Postgres driver
 * (measured ~10-15% faster p50 per query than `pg` on a local server; see the package's smoke
 * benchmark). Implements the CORE (single-node) `PgClient` surface only: `query`, `transaction`,
 * `acquireWriterLock`/`tryAcquireWriterLock`, `close`, and a best-effort `onConnectionLost`. The
 * fleet/sharding surface (`commitQuerierFor`/`tryAcquireShardLock`/`releaseShardLock`/
 * `onShardConnectionLost`) is intentionally NOT implemented here — v1 is single-node; a fleet-mode
 * commit pool for `Bun.SQL` (mirroring `NodePgClient`'s per-shard dedicated connections) is a
 * deferred follow-up, same as `queryStream` below.
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
 */
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";

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

export class BunSqlClient implements PgClient {
  private readonly sql: BunSQLHandle;
  private readonly PostgresErrorCtor: BunSQLCtor["PostgresError"];
  private pinnedPromise?: Promise<BunSQLReservedConnection>;
  private readonly connectionLostCbs: Array<() => void> = [];
  private connectionLostFired = false;

  constructor(opts: { connectionString: string }) {
    const SQL = getBunSql();
    // `bigint: true` is the whole int8 codec fix (see the class doc comment) — every other type
    // (bytea/boolean/text/null) already round-trips correctly under Bun.SQL's defaults.
    this.sql = new SQL({ url: opts.connectionString, bigint: true });
    this.PostgresErrorCtor = SQL.PostgresError;
  }

  /** Lazily reserve — and memoize — the ONE dedicated connection the writer lock and every
   *  `transaction()` share for this client's whole lifetime (RISK 2, see the class doc comment). */
  private ensurePinned(): Promise<BunSQLReservedConnection> {
    return (this.pinnedPromise ??= this.sql.reserve());
  }

  /** Run one statement on the pinned connection, routing a non-`PostgresError` failure (the
   *  connection-loss shape, not an ordinary SQL error) to the best-effort `onConnectionLost`
   *  callbacks before rethrowing. */
  private async pinnedUnsafe(
    pinned: BunSQLReservedConnection,
    text: string,
    params?: readonly PgValue[],
  ): Promise<BunSQLRow[]> {
    try {
      return await pinned.unsafe(text, params);
    } catch (e) {
      if (!(e instanceof this.PostgresErrorCtor)) this.fireConnectionLost();
      throw e;
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
    const rows = await this.sql.unsafe(text, params);
    return normalizeRows(rows);
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
      throw new Error("another Stackbase engine is already connected to this database (advisory lock held)");
    }
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    const pinned = await this.ensurePinned();
    const rows = normalizeRows(
      await this.pinnedUnsafe(pinned, `SELECT pg_try_advisory_lock($1) AS ok`, [ADVISORY_LOCK_KEY]),
    );
    return rows[0]?.ok === true;
  }

  // No `queryStream` in v1: Bun.SQL cursor support is unverified, so this simply stays undefined —
  // `PostgresDocStore.index_scan`'s `if (this.db.queryStream)` gate falls through to the proven
  // buffered `query` path (correct, just without the streaming benefit `NodePgClient` gets from
  // `pg-cursor`). Follow-up, tracked alongside the fleet/sharding methods above.

  async close(): Promise<void> {
    if (this.pinnedPromise) {
      // `sql.end()` hangs forever while any connection is still reserved (verified empirically) —
      // release it back to the pool first. A rejected reservation has nothing to release.
      const pinned = await this.pinnedPromise.catch(() => undefined);
      pinned?.release();
      this.pinnedPromise = undefined;
    }
    await this.sql.end();
  }
}
