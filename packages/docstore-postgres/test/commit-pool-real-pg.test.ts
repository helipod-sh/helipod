/**
 * The REAL two-connection concurrency proof for the per-shard commit pool (Fenced Frontier B2a, D1).
 *
 * This is the parallelism regression test the spec review asked for: shard A's commit transaction is
 * held OPEN across an await while shard B's full commit completes and becomes visible — impossible on
 * a single shared connection (there, B's work would either queue behind A or interleave into A's txn
 * and corrupt atomicity; see the PGlite hazard test in `commit-pool.test.ts`). It requires TWO real
 * Postgres connections, which PGlite cannot provide (single in-process instance, no cross-instance DB
 * sharing), so it runs against a real server: `STACKBASE_TEST_DATABASE_URL` when provided, else an
 * embedded native Postgres booted by the harness (`test-support/embedded-pg.ts`) — so it runs in
 * every gate rather than lying dormant behind the env var. The T6 fleet E2E exercises the same
 * property end-to-end through the real server.
 *
 * To point it at your own server instead:
 *   STACKBASE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *     bun run --filter @stackbase/docstore-postgres test
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NodePgClient } from "../src/node-pg-client";
import { startEmbeddedPg, embeddedPgAvailable, type EmbeddedPg } from "../test-support/embedded-pg";

// Prefer an explicitly-provided server; otherwise boot an embedded one (real native Postgres, no
// Docker) so this proof runs in every gate instead of lying dormant behind an env var.
const ENV_URL = process.env.STACKBASE_TEST_DATABASE_URL;

describe.skipIf(!ENV_URL && !embeddedPgAvailable())("commit pool — genuine cross-shard concurrency (real Postgres)", () => {
  let DATABASE_URL = ENV_URL;
  let embedded: EmbeddedPg | undefined;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      embedded = await startEmbeddedPg();
      DATABASE_URL = embedded.url;
    }
  }, 60_000);

  afterAll(async () => {
    await embedded?.stop();
  });

  it("holds shard A's commit open while shard B's commit completes and is visible (two connections)", async () => {
    const client = new NodePgClient({
      connectionString: DATABASE_URL!,
      applicationName: "stackbase-b2a-pool-test",
      sessionTimeouts: { idleInTransactionMs: 5000, statementMs: 10000 },
      commitPool: { shards: ["s0", "s1"] },
    });

    // Setup on the pinned connection.
    await client.query("CREATE TABLE IF NOT EXISTS b2a_pool_proof (id int, shard text)");
    await client.query("TRUNCATE b2a_pool_proof");

    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    let aReleased = false;

    const qA = await client.commitQuerierFor!("s0");
    const qB = await client.commitQuerierFor!("s1");

    // A: begin on shard s0's connection, insert, then HOLD open on the gate.
    const txA = qA.transaction(async (tx) => {
      await tx.query("INSERT INTO b2a_pool_proof VALUES (1, 's0')");
      await gateA;
      aReleased = true;
    });
    // Let A reach the gate.
    await new Promise((r) => setTimeout(r, 20));

    // B: a FULL commit on shard s1's own connection — runs to COMMIT while A is still open.
    await qB.transaction(async (tx) => {
      await tx.query("INSERT INTO b2a_pool_proof VALUES (2, 's1')");
    });

    // Proof of concurrency: B finished while A has NOT released (two independent sessions).
    expect(aReleased).toBe(false);
    // B's committed row is visible from a third (pinned) connection…
    const bVisible = await client.query("SELECT id FROM b2a_pool_proof WHERE shard = 's1'");
    expect(bVisible.map((r) => Number(r.id))).toEqual([2]);
    // …while A's row is still uncommitted and invisible (isolation intact — not one shared txn).
    const aHidden = await client.query("SELECT id FROM b2a_pool_proof WHERE shard = 's0'");
    expect(aHidden).toHaveLength(0);

    releaseA();
    await txA;

    const both = await client.query("SELECT id FROM b2a_pool_proof ORDER BY id");
    expect(both.map((r) => Number(r.id))).toEqual([1, 2]);

    await client.query("DROP TABLE b2a_pool_proof");
    await client.close();
  });

  it("releaseShardLock frees a slot for a GENUINELY DIFFERENT connection to acquire, while the original connection stays alive (B2b, D2)", async () => {
    const client = new NodePgClient({
      connectionString: DATABASE_URL!,
      applicationName: "stackbase-b2b-unlock-test",
      commitPool: { shards: ["s0"] },
    });
    // A second, independent client — its own commit connection for the SAME slot's shard — models
    // "another node" (or this node re-acquiring on a fresh connection after a restart).
    const other = new NodePgClient({
      connectionString: DATABASE_URL!,
      applicationName: "stackbase-b2b-unlock-test-other",
      commitPool: { shards: ["s0"] },
    });

    try {
      // Take the lock on client's s0 connection.
      expect(await client.tryAcquireShardLock!(0)).toBe(true);
      // While held, a genuinely different session cannot take it (real advisory-lock exclusion —
      // proof that this test is exercising real Postgres semantics, not the pg mock).
      expect(await other.tryAcquireShardLock!(0)).toBe(false);

      // Release it — on `client`'s own connection, per the seam's contract.
      await client.releaseShardLock!(0);

      // The SAME slot is now re-acquirable — on the OTHER (previously-blocked) connection.
      expect(await other.tryAcquireShardLock!(0)).toBe(true);

      // `client`'s original connection is still alive and usable — releasing the lock did not close
      // or otherwise disturb the connection itself.
      const rows = await client.query("SELECT 1 AS ok");
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await client.close();
      await other.close();
    }
  });
});
