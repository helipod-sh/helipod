/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Receipted Outbox, Task 2 — the guard slot→chain migration's spec-review-flagged hazard
 * (`docs/superpowers/specs/2026-07-10-receipted-outbox-design.md`, decision 2): `armWriter`
 * (`node.ts`) re-arms the commit guard on EVERY promotion. `installCommitGuard` now installs onto
 * an APPEND-ONLY `addCommitGuard` chain (`PostgresDocStore`), not a single overwritable slot. If a
 * caller re-arms WITHOUT first releasing the prior registration (the naive migration), each
 * re-arm STACKS a duplicate epoch-fence guard: the fence check just double-runs harmlessly
 * (idempotent `GREATEST`), but the per-unit `fleet_idempotency` INSERT does NOT — the SAME guard
 * closure runs twice in the SAME transaction, so a forwarded commit's idempotency key collides
 * with ITSELF (self-PK-collision) and the commit that should succeed instead aborts.
 *
 * `armWriter`'s fix: capture the `installCommitGuard` unregister handle and call it before
 * re-installing (`node.ts`'s `unregisterCommitGuard` closure variable). This file proves that
 * pattern is load-bearing by exercising `installCommitGuard` directly at the level `armWriter`
 * calls it — a "double promote" (two re-arms) followed by ONE forwarded commit.
 */
import { describe, it, expect } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import { PostgresDocStore } from "@helipod/docstore-postgres";
import { LeaseManager } from "../src/lease";
import { installCommitGuard } from "../src/node";
import { PgliteClient } from "./pglite-client";

const TABLE = 20050;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
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
  await lease.tryAcquire(); // epoch 1 — the same epoch every re-arm below re-installs a guard for
  return { client, pgStore, lease };
}

describe("commit-guard restack — armWriter's re-arm pattern (Receipted Outbox decision 2)", () => {
  it("double-promote (release-then-reinstall, armWriter's ACTUAL pattern): a forwarded commit lands EXACTLY once", async () => {
    const { client, pgStore, lease } = await makeFencedStore();

    // Arm 1 (writer boot).
    const unregister1 = installCommitGuard(pgStore, lease, () => {});
    // Arm 2 (a promotion event) — mirrors `armWriter`'s fixed code: release the PRIOR registration
    // before installing the new one.
    unregister1();
    const unregister2 = installCommitGuard(pgStore, lease, () => {});
    // Arm 3 (a SECOND promotion event, e.g. a re-failover) — "double promote".
    unregister2();
    installCommitGuard(pgStore, lease, () => {});

    // A forwarded commit (carries an idempotencyKey, as `/_fleet/run` threads through commitMeta)
    // must succeed — and land exactly once — with only ONE guard on the chain.
    const id = newDocumentId(TABLE);
    const commitTs = await pgStore.commitWrite([doc(id, "forwarded")], [], undefined, {
      meta: { idempotencyKey: "restack-key" },
    });
    expect(commitTs).toBeGreaterThan(0n);

    const idemRows = await client.query(`SELECT commit_ts FROM fleet_idempotency WHERE key = 'restack-key'`);
    expect(idemRows).toHaveLength(1); // exactly one row — one guard ran, one INSERT happened
    expect(BigInt(idemRows[0]!.commit_ts as string | bigint)).toBe(commitTs);

    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(1); // the commit landed exactly once, not rolled back

    await client.close();
  });

  it("REGRESSION shape: naive append (no unregister between re-arms) self-collides on the SAME forwarded commit — proves the fix is load-bearing", async () => {
    const { client, pgStore, lease } = await makeFencedStore();

    // The BUGGY pre-fix pattern: re-arm twice WITHOUT releasing the prior registration — exactly
    // what `armWriter` would have done if it called `addCommitGuard` on every re-arm without
    // capturing/calling the returned unregister handle first.
    installCommitGuard(pgStore, lease, () => {});
    installCommitGuard(pgStore, lease, () => {}); // stacks a SECOND epoch-fence guard, unreleased

    const id = newDocumentId(TABLE);
    // The SAME idempotencyKey now gets INSERTed twice in the SAME transaction — once per stacked
    // guard — so the second INSERT collides with the first (self-PK-collision) and the whole
    // commit aborts, even though nothing else is contending for this key.
    let caught: unknown;
    try {
      await pgStore.commitWrite([doc(id, "forwarded")], [], undefined, {
        meta: { idempotencyKey: "restack-key-buggy" },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    // The second stacked guard's `fleet_idempotency` INSERT self-collides — a raw `23505` the fence
    // guard now converts to the typed `CommitGuardRejection` (Receipted Outbox decision 2 / T3's
    // migrated contract), so the caller sees the typed rejection, not the raw driver code.
    expect((caught as { code?: unknown }).code).toBe("COMMIT_GUARD_REJECTION");
    expect((caught as { rejectionCode?: unknown }).rejectionCode).toBe("FLEET_IDEMPOTENCY_CONFLICT");

    // The whole transaction rolled back — the "should have succeeded" commit landed NOTHING.
    const docRows = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docRows[0]!.n)).toBe(0);

    await client.close();
  });
});
