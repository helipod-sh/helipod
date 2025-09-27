/**
 * The REAL two-connection concurrency proof for the per-shard commit pool (Fenced Frontier B2a, D1).
 *
 * This is the parallelism regression test the spec review asked for: shard A's commit transaction is
 * held OPEN across an await while shard B's full commit completes and becomes visible — impossible on
 * a single shared connection (there, B's work would either queue behind A or interleave into A's txn
 * and corrupt atomicity; see the PGlite hazard test in `commit-pool.test.ts`). It requires TWO real
 * Postgres connections, which PGlite cannot provide (single in-process instance, no cross-instance DB
 * sharing), so it is GATED on `STACKBASE_TEST_DATABASE_URL` — the same gate the docstore conformance
 * suite uses for its real-Postgres runs — and is otherwise skipped. The T6 fleet E2E exercises the
 * same property end-to-end through the real server.
 *
 * Run locally with e.g.:
 *   STACKBASE_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *     bun run --filter @stackbase/docstore-postgres test
 */
import { describe, it, expect } from "vitest";
import { NodePgClient } from "../src/node-pg-client";

const DATABASE_URL = process.env.STACKBASE_TEST_DATABASE_URL;

describe.skipIf(!DATABASE_URL)("commit pool — genuine cross-shard concurrency (real Postgres)", () => {
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
});
