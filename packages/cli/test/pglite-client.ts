import { PGlite } from "@electric-sql/pglite";
import type { PgClient, PgQuerier, PgRow, PgValue } from "@helipod/docstore-postgres";
import { ADVISORY_LOCK_KEY } from "@helipod/docstore-postgres";

/**
 * Test-only `PgClient` over PGlite (real Postgres in WASM, in-process, single connection) — mirrors
 * `ee/packages/fleet/test/pglite-client.ts` (see there for the OID 20 bigint parser rationale).
 * Used ONLY by `fleet-idempotency-route.test.ts`, which needs a REAL `PostgresDocStore` +
 * `LeaseManager` + `installCommitGuard` (from `@helipod/fleet`, already a devDependency here) to
 * exercise the effectively-once forwarding concurrent-race scenario through the real `/_fleet/run`
 * handler — a fake in-memory idempotency store can't reproduce the guard's actual atomic-INSERT
 * conflict, which is the whole point of that test.
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

  async releaseShardLock(_slot: number): Promise<void> {}

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
