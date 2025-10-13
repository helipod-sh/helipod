/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet B3, Task 3 — effectively-once forwarding: the `fleet_idempotency` control table, the
 * commit guard's atomic INSERT (`installCommitGuard`, `node.ts`), and `LeaseManager`'s
 * lookup/record/sweep methods, exercised against a real `PostgresDocStore` over PGlite (real
 * Postgres semantics, in-process) — the same style as `fence.test.ts`, whose `installCommitGuard`
 * epoch-fencing this feature sits beside (the idempotency INSERT is the guard's LAST step, after
 * the frontier fence succeeds).
 *
 * `packages/cli/test/fleet-idempotency-route.test.ts` covers the `/_fleet/run` handler side
 * (SELECT-first replay, the catch-unique_violation-then-replay path, and the full concurrent-race
 * simulation through a real handler + real store) — this file covers the LEASE/GUARD half only.
 */
import { describe, it, expect, vi } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@stackbase/id-codec";
import type { DocumentLogEntry } from "@stackbase/docstore";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { LeaseManager, IDEMPOTENCY_VALUE_CAP_BYTES } from "../src/lease";
import { installCommitGuard } from "../src/node";
import { ShardLeaseBalancer, type ShardLeaseBalancerDeps } from "../src/balancer";
import { PgliteClient } from "./pglite-client";

const TABLE = 20003;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

async function makeFencedStore(
  advertiseUrl = "http://node-a:4000",
): Promise<{ client: PgliteClient; pgStore: PostgresDocStore; lease: LeaseManager }> {
  const client = new PgliteClient();
  const pgStore = new PostgresDocStore(client);
  await pgStore.setupSchema();
  const lease = new LeaseManager(client, { advertiseUrl });
  await lease.setup();
  return { client, pgStore, lease };
}

describe("Fleet B3, D3: fleet_idempotency + the commit guard's atomic INSERT", () => {
  it("setup() creates the fleet_idempotency table", async () => {
    const { client, lease } = await makeFencedStore();
    await lease.setup(); // idempotent — called twice here, mirrors production (setupSchema also idempotent)
    const rows = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_name = 'fleet_idempotency'`,
    );
    expect(rows.length).toBe(1);
    await client.close();
  });

  it("a commit with NO commitMeta inserts no fleet_idempotency row at all (non-forwarded writes carry no meta)", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});

    // Two flavors of "no meta": omit `opts` entirely (a plain local commit), and pass `opts` with
    // `meta` explicitly `undefined` (what `ShardWriter.commit` always sends — see its doc comment).
    // Both must leave the guard's `meta` param falsy, so its `if (meta?.idempotencyKey)` is a no-op.
    const id1 = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(id1, "a")], []);
    const id2 = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(id2, "b")], [], undefined, { meta: undefined });

    const rows = await client.query(`SELECT COUNT(*)::int AS n FROM fleet_idempotency`);
    expect(Number(rows[0]!.n)).toBe(0);
    await client.close();
  });

  it("installCommitGuard: a commit carrying commitMeta.idempotencyKey INSERTs the fleet_idempotency row atomically (same commit_ts)", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});

    const id = newDocumentId(TABLE);
    const commitTs = await pgStore.commitWrite([doc(id, "a")], [], undefined, {
      meta: { idempotencyKey: "key-1" },
    });

    const rows = await client.query(`SELECT commit_ts, value_json, oversized FROM fleet_idempotency WHERE key = 'key-1'`);
    expect(rows.length).toBe(1);
    expect(BigInt(rows[0]!.commit_ts as string | bigint)).toBe(commitTs);
    expect(rows[0]!.value_json).toBeNull(); // the guard only ever records commit_ts — value comes later
    expect(rows[0]!.oversized).toBe(false);
    await client.close();
  });

  it("a duplicate idempotencyKey's guard INSERT aborts the WHOLE commit — row absent from documents AND fleet_idempotency's row for that key is unchanged (the concurrent-duplicate race's loser path)", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});

    const id1 = newDocumentId(TABLE);
    const winnerCommitTs = await pgStore.commitWrite([doc(id1, "winner")], [], undefined, {
      meta: { idempotencyKey: "dup-key" },
    });

    const id2 = newDocumentId(TABLE);
    let caught: unknown;
    try {
      await pgStore.commitWrite([doc(id2, "loser")], [], undefined, { meta: { idempotencyKey: "dup-key" } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect((caught as { code?: unknown }).code).toBe("23505");
    expect((caught as { table?: unknown }).table).toBe("fleet_idempotency");

    // The loser's OWN document row never landed — the whole transaction rolled back.
    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(1); // only the winner's

    // The fleet_idempotency row is still the WINNER's — untouched by the aborted loser.
    const rows = await client.query(`SELECT commit_ts FROM fleet_idempotency WHERE key = 'dup-key'`);
    expect(rows.length).toBe(1);
    expect(BigInt(rows[0]!.commit_ts as string | bigint)).toBe(winnerCommitTs);

    await client.close();
  });

  it("lookupIdempotency + recordIdempotencyValue round-trip: a value within the cap is recorded and read back", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});

    const id = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(id, "a")], [], undefined, { meta: { idempotencyKey: "val-key" } });

    await lease.recordIdempotencyValue("val-key", { hello: "world" });
    const hit = await lease.lookupIdempotency("val-key");
    expect(hit).not.toBeNull();
    expect(hit!.hasValue).toBe(true);
    expect(hit!.oversized).toBe(false);
    expect(hit!.value).toEqual({ hello: "world" });

    await client.close();
  });

  it("recordIdempotencyValue: a legitimate JSON null return value is recorded as hasValue:true (distinct from 'not recorded')", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});
    const id = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(id, "a")], [], undefined, { meta: { idempotencyKey: "null-key" } });

    await lease.recordIdempotencyValue("null-key", null);
    const hit = await lease.lookupIdempotency("null-key");
    expect(hit!.hasValue).toBe(true);
    expect(hit!.value).toBeNull();
    await client.close();
  });

  it("recordIdempotencyValue: a value over the 64KB cap is NOT stored — oversized:true, value_json NULL", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});
    const id = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(id, "a")], [], undefined, { meta: { idempotencyKey: "big-key" } });

    const big = "x".repeat(IDEMPOTENCY_VALUE_CAP_BYTES + 100);
    await lease.recordIdempotencyValue("big-key", big);
    const hit = await lease.lookupIdempotency("big-key");
    expect(hit!.hasValue).toBe(false);
    expect(hit!.oversized).toBe(true);
    expect(hit!.value).toBeNull();
    await client.close();
  });

  it("crash-window shape: a row whose value was never recorded (value_json NULL, oversized false) reads back as hasValue:false", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});
    const id = newDocumentId(TABLE);
    const commitTs = await pgStore.commitWrite([doc(id, "a")], [], undefined, {
      meta: { idempotencyKey: "crash-key" },
    });

    // Simulates a crash between the commit and the post-run value UPDATE — never call
    // recordIdempotencyValue at all.
    const hit = await lease.lookupIdempotency("crash-key");
    expect(hit).not.toBeNull();
    expect(hit!.commitTs).toBe(commitTs);
    expect(hit!.hasValue).toBe(false);
    expect(hit!.oversized).toBe(false);
    await client.close();
  });

  it("lookupIdempotency returns null for a key that was never committed", async () => {
    const { client, lease } = await makeFencedStore();
    const hit = await lease.lookupIdempotency("never-seen");
    expect(hit).toBeNull();
    await client.close();
  });

  it("sweepIdempotency deletes only rows older than 1h, leaving fresh rows intact", async () => {
    const { client, pgStore, lease } = await makeFencedStore();
    await lease.tryAcquire();
    installCommitGuard(pgStore, lease, () => {});

    const oldId = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(oldId, "old")], [], undefined, { meta: { idempotencyKey: "old-key" } });
    const freshId = newDocumentId(TABLE);
    await pgStore.commitWrite([doc(freshId, "fresh")], [], undefined, { meta: { idempotencyKey: "fresh-key" } });

    // Backdate the "old" row's created_at past the 1h sweep window; leave "fresh" alone.
    await client.query(`UPDATE fleet_idempotency SET created_at = now() - interval '2 hours' WHERE key = 'old-key'`);

    await lease.sweepIdempotency();

    expect(await lease.lookupIdempotency("old-key")).toBeNull();
    expect(await lease.lookupIdempotency("fresh-key")).not.toBeNull();

    await client.close();
  });
});

describe("Fleet B3, D3: ShardLeaseBalancer sweeps idempotency on the writer-ish beat only", () => {
  function makeDeps(overrides: Partial<ShardLeaseBalancerDeps> = {}): ShardLeaseBalancerDeps {
    return {
      lease: {
        heartbeatPresence: vi.fn(async () => {}),
        liveNodes: vi.fn(async () => ["http://self"]),
        readShardOwnership: vi.fn(async () => new Map()),
      },
      myUrl: "http://self",
      numShards: 1,
      isHeld: () => false,
      isWriterish: () => true,
      tryAcquireShard: vi.fn(async () => false),
      releaseShard: vi.fn(async () => {}),
      requestPromotion: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it("calls sweepIdempotency on a writer-ish tick", async () => {
    const sweepIdempotency = vi.fn(async () => {});
    const balancer = new ShardLeaseBalancer(makeDeps({ isWriterish: () => true, sweepIdempotency }));
    await balancer.tick();
    expect(sweepIdempotency).toHaveBeenCalledTimes(1);
  });

  it("does NOT call sweepIdempotency on a pure sync (non-writer-ish) tick", async () => {
    const sweepIdempotency = vi.fn(async () => {});
    const balancer = new ShardLeaseBalancer(makeDeps({ isWriterish: () => false, sweepIdempotency }));
    await balancer.tick();
    expect(sweepIdempotency).not.toHaveBeenCalled();
  });

  it("a sweep failure is caught and logged, never overshadowing the beat's acquire/release work", async () => {
    const sweepIdempotency = vi.fn(async () => {
      throw new Error("sweep boom");
    });
    const log = vi.fn();
    const balancer = new ShardLeaseBalancer(makeDeps({ isWriterish: () => true, sweepIdempotency, log }));
    await expect(balancer.tick()).resolves.toBeUndefined(); // tick() never throws
    expect(log).toHaveBeenCalledWith(expect.stringContaining("idempotency sweep failed"));
  });

  it("omitting sweepIdempotency (older/stub deps) is a no-op — no crash", async () => {
    const balancer = new ShardLeaseBalancer(makeDeps({ isWriterish: () => true, sweepIdempotency: undefined }));
    await expect(balancer.tick()).resolves.toBeUndefined();
  });
});
