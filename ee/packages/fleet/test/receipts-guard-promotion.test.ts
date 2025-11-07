/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Receipted Outbox — the promotion-barrier hole (the final whole-branch review's composed-path catch:
 * "the exactly-once barrier silently vanishes on promotion").
 *
 * THE HOLE (pre-fix): `EmbeddedRuntime.create()` registered the `clientReceiptsGuard()` exactly-once
 * barrier on `options.store`. On a SYNC-boot fleet node `options.store` is a `SwitchableDocStore` over
 * the read-only REPLICA, and `SwitchableDocStore.addCommitGuard` forwards to the CURRENT delegate but
 * is NOT re-forwarded on `swapTo` (by documented design). `promoteFleetNode` swaps the runtime store to
 * `pgStore` and `armWriter` installed ONLY the epoch fence there — so a PROMOTED single-writer node's
 * commits ran with NO receipts guard: applied receipts were never written, classification missed, and a
 * resent `(clientId, seq)` RE-EXECUTED.
 *
 * THE FIX (ownership handoff): the runtime boots with `externalReceiptsGuard` (it registers NOTHING),
 * and `armWriter` (`node.ts`) installs the receipts guard on the CONCRETE `pgStore` — BEFORE the epoch
 * fence (receipts-before-fence ordering), with the SAME release-on-re-arm discipline the fence uses.
 * Ownership rule: whoever owns the concrete write store owns the receipts guard (non-fleet: the runtime
 * on `options.store`; fleet: `armWriter` on `pgStore`).
 *
 * These tests exercise the guards at the level `armWriter` calls them (the `commit-guard-restack.test.ts`
 * precedent) — real `PostgresDocStore` over PGlite, a real `SwitchableDocStore` for the swapTo path,
 * and the real `clientReceiptsGuard` + `installCommitGuard`.
 */
import { describe, it, expect } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { NodeSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { CommitGuardRejection } from "@stackbase/errors";
import { clientReceiptsGuard } from "@stackbase/runtime-embedded";
import { LeaseManager } from "../src/lease";
import { installCommitGuard } from "../src/node";
import { SwitchableDocStore } from "../src/switchable-store";
import { PgliteClient } from "./pglite-client";

const TABLE = 20070;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

/** The dedup-key wire contract the receipts guard reads off each commit unit's `meta`
 *  (`packages/runtime-embedded/src/client-dedup.ts`: `DEDUP_META_IDENTITY`/`CLIENT_ID`/`SEQ`). Built
 *  inline here — as `commit-guard-restack.test.ts` builds `{ idempotencyKey }` inline — so the fleet
 *  package needn't re-export those constants just for a test. */
function dedupMeta(clientId: string, seq: number, identity = ""): Record<string, string> {
  return { identity, clientId, seq: String(seq) };
}

async function makeFencedStore(): Promise<{
  client: PgliteClient;
  pgStore: PostgresDocStore;
  lease: LeaseManager;
}> {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema();
  const lease = new LeaseManager(client, { advertiseUrl: "http://node-a:4000" });
  await lease.setup();
  await lease.tryAcquire(); // epoch 1 — the fence guard's live epoch check passes on the default shard
  return { client, pgStore, lease };
}

/**
 * Mirrors `node.ts`'s `armWriter` guard-arming block EXACTLY: the receipts guard FIRST (on the concrete
 * `pgStore`, wrapped async to satisfy `PgCommitGuard`), then the epoch fence — each released before
 * being re-added, so the on-chain order stays receipts-before-fence across re-arms. Returns both
 * unregister handles so a caller can re-arm (double-promotion) with the same release-on-re-arm
 * discipline. Pass the prior arm's handles as `prev` to replicate a promotion re-arm.
 */
function armGuards(
  pgStore: PostgresDocStore,
  lease: LeaseManager,
  prev?: { unregisterReceipts: () => void; unregisterFence: () => void },
): { unregisterReceipts: () => void; unregisterFence: () => void } {
  prev?.unregisterReceipts();
  const receiptsGuard = clientReceiptsGuard();
  const unregisterReceipts = pgStore.addCommitGuard(async (q, units, shardId) => {
    await receiptsGuard(q, units, shardId);
  });
  prev?.unregisterFence();
  const unregisterFence = installCommitGuard(pgStore, lease, () => {});
  return { unregisterReceipts, unregisterFence };
}

describe("Receipted Outbox — receipts guard survives fleet promotion (the promotion-barrier hole)", () => {
  it("PROMOTED single-writer node (the swapTo path): the receipt SURVIVES promotion; a resend replay-collides instead of re-executing", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    const replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    const switchable = new SwitchableDocStore(replica);

    // Promotion: `promoteFleetNode` swaps the runtime store from the replica to `pgStore` (step 3),
    // then `armWriter` installs the receipts guard on the CONCRETE `pgStore` (before the fence).
    switchable.swapTo(pgStore);
    const guards = armGuards(pgStore, lease);

    // A keyed mutation commits THROUGH the (post-swap) switchable → `pgStore`.
    const id1 = newDocumentId(TABLE);
    const commitTs = await switchable.commitWrite([doc(id1, "keyed")], [], undefined, { meta: dedupMeta("c1", 1) });
    expect(commitTs).toBeGreaterThan(0n);

    // The applied receipt EXISTS on the concrete `pgStore`, carrying this commitTs (pre-fix: null).
    const rec = await pgStore.getClientVerdict("", "c1", 1);
    expect(rec).not.toBeNull();
    expect(rec!.verdict).toBe("applied");
    expect(rec!.commitTs).toBe(commitTs);

    // A resend of the SAME (clientId, seq): the receipts guard's plain INSERT self-collides → the
    // typed CLIENT_MUTATION_DUP (the caller replay-acks it), and the commit ABORTS → no second doc.
    const id2 = newDocumentId(TABLE);
    let caught: unknown;
    try {
      await switchable.commitWrite([doc(id2, "keyed")], [], undefined, { meta: dedupMeta("c1", 1) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CommitGuardRejection);
    expect((caught as CommitGuardRejection).rejectionCode).toBe("CLIENT_MUTATION_DUP");
    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(1); // exactly once — the resend wrote nothing

    guards.unregisterReceipts();
    guards.unregisterFence();
    await client.close();
  });

  it("REGRESSION shape (the hole): a receipts guard registered on the SwitchableDocStore vanishes on swapTo — a promoted node RE-EXECUTES a resend", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    const replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    const switchable = new SwitchableDocStore(replica);

    // The BUGGY pre-fix wiring: the runtime registered the receipts guard on `options.store` = the
    // switchable, which forwarded it to the REPLICA delegate. On promotion the store swaps to `pgStore`
    // and that guard does NOT follow (SwitchableDocStore.addCommitGuard is not re-forwarded on swapTo).
    // Only the fence arms on `pgStore` (armWriter, pre-fix) — receipts do not.
    switchable.addCommitGuard(clientReceiptsGuard()); // lands on the replica, never runs for pgStore commits
    switchable.swapTo(pgStore);
    installCommitGuard(pgStore, lease, () => {}); // armWriter's fence only — the pre-fix arming

    const id1 = newDocumentId(TABLE);
    await switchable.commitWrite([doc(id1, "keyed")], [], undefined, { meta: dedupMeta("c1", 1) });
    // No receipt on the concrete `pgStore` — the barrier silently vanished on promotion.
    expect(await pgStore.getClientVerdict("", "c1", 1)).toBeNull();

    // So a resend RE-EXECUTES (the guard that should have collided is on the wrong store) → 2 docs.
    const id2 = newDocumentId(TABLE);
    await switchable.commitWrite([doc(id2, "keyed")], [], undefined, { meta: dedupMeta("c1", 1) });
    const rows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(rows[0]!.n)).toBe(2); // re-executed — exactly-once broken (exactly what the fix prevents)

    await client.close();
  });

  it("BOOT-writer path: armWriter arms receipts ONCE on the concrete pgStore — a keyed mutation writes EXACTLY ONE receipt (no double-registration)", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    // Writer boot: the runtime store IS `pgStore`, and (with `externalReceiptsGuard`) the runtime
    // registered NOTHING — `armWriter` is the sole registrar. If BOTH had registered (the double-reg
    // bug), the very first keyed commit would INSERT the receipt twice in one tx → self-collide + abort.
    // So a SUCCEEDING keyed commit with exactly one receipt row is itself the no-double-registration proof.
    armGuards(pgStore, lease);
    const id = newDocumentId(TABLE);
    const commitTs = await pgStore.commitWrite([doc(id, "keyed")], [], undefined, { meta: dedupMeta("cw", 1) });
    expect(commitTs).toBeGreaterThan(0n);

    const recRows = await client.query(
      `SELECT COUNT(*)::int AS n FROM client_mutations WHERE client_id = 'cw' AND seq = 1`,
    );
    expect(Number(recRows[0]!.n)).toBe(1); // exactly one receipt — no stacked duplicate guard
    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(1);

    await client.close();
  });

  it("ORDERING on the promoted node: receipts run BEFORE the fence — a commit colliding on BOTH keys surfaces CLIENT_MUTATION_DUP, not FLEET_IDEMPOTENCY_CONFLICT", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    const switchable = new SwitchableDocStore(pgStore);
    switchable.swapTo(pgStore);
    armGuards(pgStore, lease); // receipts registered first, fence second — armWriter's on-chain order

    // A commit carrying BOTH a dedup key (receipts guard) AND an idempotencyKey (fence guard) writes
    // one row into each control table.
    const id1 = newDocumentId(TABLE);
    await switchable.commitWrite([doc(id1, "both")], [], undefined, {
      meta: { ...dedupMeta("cord", 1), idempotencyKey: "idem-ord" },
    });

    // A resend with the SAME both keys would collide on BOTH guards. The guard registered FIRST
    // (receipts) throws first and aborts before the fence's idempotency INSERT runs → the surfaced
    // rejection is CLIENT_MUTATION_DUP. If the fence ran first it would be FLEET_IDEMPOTENCY_CONFLICT.
    const id2 = newDocumentId(TABLE);
    let caught: unknown;
    try {
      await switchable.commitWrite([doc(id2, "both")], [], undefined, {
        meta: { ...dedupMeta("cord", 1), idempotencyKey: "idem-ord" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CommitGuardRejection);
    expect((caught as CommitGuardRejection).rejectionCode).toBe("CLIENT_MUTATION_DUP");

    await client.close();
  });

  it("DOUBLE-PROMOTION restack (BOTH guards): release-then-reinstall on each arm → a keyed + idempotency-keyed commit lands EXACTLY once", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    // Arm 1 (writer boot / first promotion), Arm 2 (a promotion), Arm 3 (a re-failover) — each release
    // the PRIOR arm's BOTH handles before re-adding, mirroring `armWriter`'s discipline exactly.
    let guards = armGuards(pgStore, lease);
    guards = armGuards(pgStore, lease, guards);
    guards = armGuards(pgStore, lease, guards);

    const id = newDocumentId(TABLE);
    const commitTs = await pgStore.commitWrite([doc(id, "keyed")], [], undefined, {
      meta: { ...dedupMeta("crestack", 1), idempotencyKey: "idem-restack" },
    });
    expect(commitTs).toBeGreaterThan(0n);

    // Exactly one of each — no stacked guard double-INSERTed (which would have self-collided + aborted).
    const recRows = await client.query(`SELECT COUNT(*)::int AS n FROM client_mutations WHERE client_id = 'crestack'`);
    expect(Number(recRows[0]!.n)).toBe(1);
    const idemRows = await client.query(`SELECT COUNT(*)::int AS n FROM fleet_idempotency WHERE key = 'idem-restack'`);
    expect(Number(idemRows[0]!.n)).toBe(1);
    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(1);

    guards.unregisterReceipts();
    guards.unregisterFence();
    await client.close();
  });

  it("REGRESSION shape (receipts restack): re-arming receipts WITHOUT releasing the prior arm stacks a duplicate → a keyed commit self-collides + aborts", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    // The naive (buggy) re-arm: register receipts twice with NO release between — what `armWriter` would
    // do if it re-added on each promotion without capturing/calling the prior unregister handle.
    pgStore.addCommitGuard(async (q, u, s) => {
      await clientReceiptsGuard()(q, u, s);
    });
    pgStore.addCommitGuard(async (q, u, s) => {
      await clientReceiptsGuard()(q, u, s);
    });
    installCommitGuard(pgStore, lease, () => {});

    const id = newDocumentId(TABLE);
    let caught: unknown;
    try {
      await pgStore.commitWrite([doc(id, "keyed")], [], undefined, { meta: dedupMeta("cdup", 1) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CommitGuardRejection);
    expect((caught as CommitGuardRejection).rejectionCode).toBe("CLIENT_MUTATION_DUP");
    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(0); // aborted — the stacked duplicate broke a legit commit

    await client.close();
  });
});
