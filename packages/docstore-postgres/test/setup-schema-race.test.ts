import { describe, it, expect } from "vitest";
import { PostgresDocStore } from "../src/postgres-docstore";
import type { PgClient, PgQuerier, PgRow, PgValue } from "../src/pg-client";

/**
 * Postgres's `CREATE ... IF NOT EXISTS` is not fully race-proof: two sessions racing to create
 * the same object on a fresh database can both pass the existence check before either commits,
 * and the loser gets a duplicate-object error (23505 unique_violation on the catalog, or 42P07
 * duplicate_table) instead of a clean no-op. Actually reproducing that race requires two real
 * concurrent Postgres sessions timed to hit the same instant — not reliably reproducible in a
 * unit test — so this tests the HANDLER instead: a scripted `PgClient` stub whose `query()`
 * throws an error with a given `code`, verifying `setupSchema()` swallows the known race codes
 * and still propagates everything else (e.g. a genuine syntax error).
 */
class ThrowingPgClient implements PgClient {
  constructor(private readonly code: string) {}

  async query(_text: string, _params?: readonly PgValue[]): Promise<PgRow[]> {
    const err = new Error(`stub error code ${this.code}`) as Error & { code?: string };
    err.code = this.code;
    throw err;
  }

  async transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async acquireWriterLock(): Promise<void> {
    // Not exercised: these tests use { readOnly: true } so setupSchema() never reaches this.
  }

  async tryAcquireWriterLock(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}
}

describe("setupSchema DDL race handling", () => {
  it("swallows a duplicate-object race (23505 unique_violation) and resolves", async () => {
    const store = new PostgresDocStore(new ThrowingPgClient("23505"), { readOnly: true });
    await expect(store.setupSchema()).resolves.toBeUndefined();
  });

  it("swallows a duplicate-table race (42P07 duplicate_table) and resolves", async () => {
    const store = new PostgresDocStore(new ThrowingPgClient("42P07"), { readOnly: true });
    await expect(store.setupSchema()).resolves.toBeUndefined();
  });

  it("still propagates an unrelated error (42601 syntax error)", async () => {
    const store = new PostgresDocStore(new ThrowingPgClient("42601"), { readOnly: true });
    await expect(store.setupSchema()).rejects.toMatchObject({ code: "42601" });
  });
});
