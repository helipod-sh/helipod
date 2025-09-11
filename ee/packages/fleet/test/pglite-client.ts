/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
import { PGlite } from "@electric-sql/pglite";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@stackbase/docstore-postgres";
import { ADVISORY_LOCK_KEY } from "@stackbase/docstore-postgres";

/**
 * Test-only `PgClient` over PGlite (real Postgres in WASM, in-process, single connection) —
 * mirrors `packages/docstore-postgres/test/pglite-client.ts` (see there for the OID 20 bigint
 * parser rationale). `listen`/`notify` are stubbed to throw: PGlite is a single in-process WASM
 * instance with no cross-connection notification channel, so `ReplicaTailer.start()` must
 * tolerate a `listen()` rejection and fall back to its poll loop — which is exactly the path
 * these fixtures exercise (see `replica-tailer.test.ts`). The real LISTEN/NOTIFY path is
 * latency-only and proven against real Postgres in the fleet E2E, not here.
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
    void ADVISORY_LOCK_KEY;
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    void ADVISORY_LOCK_KEY;
    return true;
  }

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
