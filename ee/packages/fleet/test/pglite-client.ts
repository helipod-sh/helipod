import { PGlite } from "@electric-sql/pglite";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@stackbase/docstore-postgres";
import { ADVISORY_LOCK_KEY } from "@stackbase/docstore-postgres";

/**
 * Test-only PgClient over PGlite (real Postgres in WASM, in-process, single connection),
 * local to @stackbase/fleet (packages/docstore-postgres/test/pglite-client.ts is not exported
 * from that package, so this is a minimal local mirror for fleet's own tests).
 *
 * Same int8 (OID 20) parser rationale as the docstore-postgres original: PGlite's default int8
 * decoding is inconsistent (small values -> number, values beyond Number.MAX_SAFE_INTEGER ->
 * bigint), so the typed-parsers option is registered at construction time to force `bigint`
 * unconditionally, matching the PgClient normalization contract (`query` returns int8 as bigint).
 */
export class PgliteClient implements PgClient {
  private readonly pg = new PGlite({ parsers: { 20: (v: string) => BigInt(v) } });

  async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const res = await this.pg.query(text, params as unknown[] | undefined);
    return res.rows as PgRow[];
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
    // Single in-process connection: contention is unobservable. No-op.
    void ADVISORY_LOCK_KEY;
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    // Same rationale as acquireWriterLock: single in-process connection, contention unobservable.
    void ADVISORY_LOCK_KEY;
    return true;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}
