/**
 * Smoke test for the embedded-postgres harness (`test-support/embedded-pg.ts`) — the Docker-free
 * substrate the fleet/outbox/optimistic E2E suites run on. Proves the capabilities those suites
 * depend on, on the real PostgreSQL 16 postmaster:
 *   - two genuinely concurrent sessions contending on an advisory lock (the single-writer invariant)
 *   - `pg_terminate_backend` by `application_name` (the fleet eviction path)
 *   - pause()/unpause() (SIGSTOP/SIGCONT — the `docker pause` equivalent the fleet E2E uses)
 */
import { describe, it, expect } from "vitest";
import pg from "pg";
import { startEmbeddedPg, embeddedPgAvailable } from "../test-support/embedded-pg";

describe.skipIf(!embeddedPgAvailable())("embedded-postgres harness", () => {
  it("boots a real multi-session Postgres: advisory contention, backend termination, pause/unpause", async () => {
    const server = await startEmbeddedPg();
    try {
      const a = new pg.Client({ connectionString: server.url, application_name: "smoke-a" });
      const b = new pg.Client({ connectionString: server.url, application_name: "smoke-b" });
      await a.connect();
      await b.connect();
      // terminated/paused backends surface socket errors later — keep them from killing the process
      a.on("error", () => {});
      b.on("error", () => {});

      // 1. real multi-session advisory-lock contention (PGlite structurally cannot do this)
      const lockA = await a.query("SELECT pg_try_advisory_lock(42) AS got");
      const lockB = await b.query("SELECT pg_try_advisory_lock(42) AS got");
      expect(lockA.rows[0].got).toBe(true);
      expect(lockB.rows[0].got).toBe(false);

      // 2. pg_terminate_backend by application_name — the fleet eviction path
      const killed = await b.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'smoke-a'",
      );
      expect(killed.rowCount).toBe(1);
      await expect(a.query("SELECT 1")).rejects.toThrow();
      // termination released the lock to the survivor
      const lockB2 = await b.query("SELECT pg_try_advisory_lock(42) AS got");
      expect(lockB2.rows[0].got).toBe(true);

      // 3. pause = frozen server (queries hang, no errors); unpause resumes them
      server.pause();
      const raced = await Promise.race([
        b.query("SELECT 1").then(() => "responded"),
        new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1_000)),
      ]);
      expect(raced).toBe("hung");
      server.unpause();
      const resumed = await b.query("SELECT 1");
      expect(resumed.rowCount).toBe(1);

      await b.end();
    } finally {
      await server.stop();
    }
  }, 60_000);
});
