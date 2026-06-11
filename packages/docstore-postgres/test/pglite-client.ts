import { PGlite } from "@electric-sql/pglite";
import type { PgClient, PgQuerier, PgRow, PgValue } from "../src/pg-client";
import { ADVISORY_LOCK_KEY, STREAM_BATCH } from "../src/pg-client";

/**
 * Encode `$1..$n` placeholders in `sql` as typed SQL literals, substituting `params` positionally.
 *
 * `DECLARE ... CURSOR` can't bind `$n` parameters over PGlite/PG's simple query path, so a
 * streaming query must inline its params as literals before issuing DECLARE. Longest-match-first
 * (`$10` before `$1`) so a two-digit placeholder is never partially replaced by its single-digit
 * prefix.
 */
function inlineParams(sql: string, params: readonly PgValue[]): string {
  let out = sql;
  for (let i = params.length; i >= 1; i--) {
    const value = params[i - 1];
    out = out.split(`$${i}`).join(literalFor(value));
  }
  return out;
}

function literalFor(value: PgValue | undefined): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Uint8Array) {
    let hex = "";
    for (const b of value) hex += b.toString(16).padStart(2, "0");
    return `'\\x${hex}'::bytea`;
  }
  if (typeof value === "bigint" || typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") {
    if (value.includes("$$")) {
      throw new Error("inlineParams: string param contains '$$', cannot dollar-quote safely");
    }
    return `$$${value}$$`;
  }
  throw new Error("inlineParams: unsupported param type");
}

/**
 * Test-only PgClient over PGlite (real Postgres in WASM, in-process, single connection).
 *
 * Empirically verified (2026-07): PGlite's default int8 (OID 20) decoding is INCONSISTENT —
 * small values come back as JS `number` and values exceeding Number.MAX_SAFE_INTEGER come back
 * as `bigint`, so a `k.endsWith("ts")`-style heuristic on the already-decoded value is not just
 * fragile, it also has to fight PGlite's own type-dependent behavior. PGlite's typed-parsers
 * option (`parsers: { 20: (v) => BigInt(v) } }` — OID 20 is int8) makes int8 decode to `bigint`
 * UNCONDITIONALLY, for every value including small ones and NULLs; confirmed with a scratch probe.
 * bytea (OID 17) is already `Uint8Array` both ways with no parser needed, and BOOLEAN already
 * decodes to a native JS `boolean`. So normalization here is just: register the OID 20 parser at
 * construction time and pass rows through unchanged — no per-row/per-key guessing.
 */
export class PgliteClient implements PgClient {
  private readonly pg = new PGlite({ parsers: { 20: (v: string) => BigInt(v) } });

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const res = await this.pg.query(text, params as unknown[] | undefined);
    return res.rows as PgRow[];
  }

  /**
   * Stream rows via a server-side cursor (`DECLARE`/`FETCH`), batched at `STREAM_BATCH` rows per
   * round trip. `DECLARE ... CURSOR` doesn't support `$n` bind params over the simple protocol, so
   * `inlineParams` encodes them as typed literals directly into the SQL text first.
   *
   * PGlite is a single in-process connection, so the cursor's lifetime is wrapped in its own
   * BEGIN/COMMIT. The `finally` always CLOSEs the cursor and COMMITs — including on an early
   * `break`/throw from the consumer — so the connection is never left mid-transaction.
   */
  async *queryStream(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow> {
    await this.query("BEGIN");
    try {
      await this.query(`DECLARE sbc NO SCROLL CURSOR FOR ${inlineParams(sql, params ?? [])}`);
      for (;;) {
        const rows = await this.query(`FETCH ${STREAM_BATCH} FROM sbc`);
        if (rows.length === 0) break;
        for (const r of rows) yield r;
      }
    } finally {
      await this.query("CLOSE sbc").catch(() => {});
      await this.query("COMMIT").catch(() => {});
    }
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    await this.pg.query("BEGIN");
    try {
      const result = await fn(this);
      await this.pg.query("COMMIT");
      return result;
    } catch (e) {
      await this.pg.query("ROLLBACK");
      throw e;
    }
  }

  async acquireWriterLock(): Promise<void> {
    // Single in-process connection: contention is unobservable. No-op. (Real guard: Task 6 + E2E.)
    void ADVISORY_LOCK_KEY;
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    // Same rationale as acquireWriterLock: single in-process connection, contention unobservable.
    void ADVISORY_LOCK_KEY;
    return true;
  }

  // ---- Per-shard commit pool (B2a, D1) ---------------------------------------------------------
  // NOTE: `commitQuerierFor` is deliberately NOT implemented. PGlite is a single in-process
  // connection with no pool, so leaving it undefined keeps `PostgresDocStore.commitWrite` on its
  // poolless pinned-connection path — the exact path the shared conformance suite (which runs on
  // this client) must keep proving byte-identical. The real two-connection pool is proven by the
  // `STACKBASE_TEST_DATABASE_URL`-gated test + the T6 fleet E2E against real Postgres. The two
  // members below ARE implemented as no-ops: they're consulted only by fleet lease code, never by
  // the store, so they can't divert any conformance path.

  /** No-op: a single in-process connection is never "lost". */
  onShardConnectionLost(_cb: (shardId: string) => void): void {}

  /** Single in-process connection: contention unobservable, mirrors `tryAcquireWriterLock`. */
  async tryAcquireShardLock(_slot: number): Promise<boolean> {
    return true;
  }

  /** No-op mirror of `tryAcquireShardLock`: a single in-process connection has no per-slot lock
   *  state to release (contention was never observable to acquire in the first place). */
  async releaseShardLock(_slot: number): Promise<void> {}

  /** Not implemented: PGlite is a single in-process WASM instance with no cross-connection
   * notification channel to speak of; the real LISTEN/NOTIFY path is proven by the fleet E2E
   * against real Postgres, not this test client. */
  async listen(_channel: string, _onNotify: (payload: string) => void): Promise<() => Promise<void>> {
    throw new Error("listen/notify not supported on PGlite test client");
  }

  async notify(_channel: string, _payload: string): Promise<void> {
    throw new Error("listen/notify not supported on PGlite test client");
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
