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
 * Uses a single pinned `pg.Client` connection (not a `Pool`) — the engine is single-writer,
 * so one connection is all a `PostgresDocStore` ever needs, and `transaction` requires pinning
 * to one connection anyway (a `Pool` would risk BEGIN/COMMIT landing on different connections).
 */
import pg from "pg";
import type { PgClient, PgQuerier, PgRow, PgValue } from "./pg-client";
import { ADVISORY_LOCK_KEY } from "./pg-client";

const { Client, types } = pg;

// int8 (OID 20) → bigint (pg defaults to string). Set on a per-client type map, not globally.
const INT8_OID = 20;

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

export class NodePgClient implements PgClient {
  private readonly client: pg.Client;
  private connected = false;
  private connectPromise?: Promise<void>;

  constructor(opts: { connectionString: string }) {
    this.client = new Client({
      connectionString: opts.connectionString,
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
    return (this.connectPromise ??= this.client.connect().then(() => {
      this.connected = true;
    }));
  }

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    await this.ensure();
    const res = await this.client.query(text, toDriverParams(params));
    return normalizeRows(res.rows as Record<string, unknown>[]);
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

  async close(): Promise<void> {
    if (this.connected) {
      await this.client.end();
      this.connected = false;
      this.connectPromise = undefined;
    }
  }
}
