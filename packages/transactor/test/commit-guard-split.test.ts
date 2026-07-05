/**
 * Receipted Outbox (Plan A, Task 3) — the group committer's split-retry on a typed
 * `CommitGuardRejection`. This is the LIVE batch-collateral bug fix: pre-fix, a guard aborting on
 * ONE unit of a group-committed batch threw out of `commitWriteBatch` and the committer rejected
 * EVERY unit (the store rolled the whole txn back, so nothing landed — but the innocent co-batched
 * units were rejected as collateral). Post-fix, the committer catches the typed rejection, rejects
 * ONLY the offending unit with its code, and re-flushes the remainder (fresh ts — the rolled-back
 * txn allocated nothing durable), bounded at 3 split-retries, preserving strict unit-order publish.
 *
 * `GuardRejectStore` stands in for the real docstore guard: its `commitWriteBatch` can hold a flush
 * in flight (so units accumulate into ONE batch) AND throw a `CommitGuardRejection` for a chosen
 * unit index — mimicking a guard's per-unit abort, which (like the real store) lands nothing when it
 * throws. The batching machinery is store-agnostic; SQLite's real flush is synchronous, so the hold
 * is the only way to force a multi-unit batch deterministically (same lever `group-commit.test.ts`
 * uses).
 */
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import type { CommitUnit } from "@helipod/docstore";
import { CommitGuardRejection, isRetryableError } from "@helipod/errors";
import { newDocumentId, documentIdKey, type ShardId, type InternalDocumentId } from "@helipod/id-codec";
import { ShardedTransactor, type OplogDelta } from "../src/index";

const TABLE = 20011;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** A store whose `commitWriteBatch` can be gated per flush and can throw a chosen error (landing
 *  nothing, exactly like a real guard/fence abort — the whole txn rolls back). */
class GuardRejectStore extends SqliteDocStore {
  /** Await point at the start of each flush (by 0-based flush index) — the lever that holds a flush
   *  in flight while more units stage into the pending batch. */
  hold?: (flushIndex: number) => Promise<void>;
  /** Return an error to throw for THIS flush (landing nothing), or null to let the batch land. */
  throwPlan?: (units: readonly CommitUnit[], flushIndex: number) => Error | null;
  private flushIndex = 0;
  /** Every flush's unit count in flush order — the split trace. */
  readonly flushes: number[] = [];

  override async commitWriteBatch(units: readonly CommitUnit[], shardId?: ShardId): Promise<bigint[]> {
    const fi = this.flushIndex++;
    if (this.hold) await this.hold(fi);
    this.flushes.push(units.length);
    const err = this.throwPlan?.(units, fi) ?? null;
    if (err !== null) throw err;
    return super.commitWriteBatch(units, shardId);
  }
}

/** Convenience: a guard rejection of `unitIndex` for the batch-of-N flush at `rejectFlush`. */
function rejectUnit(rejectFlush: number, unitIndex: number) {
  return (_units: readonly CommitUnit[], fi: number): Error | null =>
    fi === rejectFlush ? new CommitGuardRejection(unitIndex, "FLEET_IDEMPOTENCY_CONFLICT", `flush=${fi}`) : null;
}

async function makeGroup() {
  const store = new GuardRejectStore(new NodeSqliteAdapter());
  await store.setupSchema();
  const deltas: OplogDelta[] = [];
  const transactor = new ShardedTransactor(store, {
    groupCommit: true,
    fanout: { publish: (d) => void deltas.push(d) },
  });
  return { store, transactor, deltas };
}

async function countRevisions(store: SqliteDocStore, id: InternalDocumentId) {
  const key = documentIdKey(id);
  const revs = [];
  for await (const e of store.load_documents({ minInclusive: 0n, maxExclusive: 1n << 62n }, "asc")) {
    if (documentIdKey(e.id) === key) revs.push(e);
  }
  return revs;
}

describe("group commit — split-retry on CommitGuardRejection (the batch-collateral fix)", () => {
  it("a batch of 3 where unit 2's guard rejects → units 1+3 commit with fresh ts, unit 2 rejects with the code", async () => {
    const { store, transactor, deltas } = await makeGroup();
    const ids = Array.from({ length: 4 }, () => newDocumentId(TABLE));

    const g = gate();
    store.hold = async (fi) => {
      if (fi === 0) await g.promise; // hold the filler flush so the 3 reals accumulate into ONE batch
    };
    store.throwPlan = rejectUnit(1, 1); // reject the MIDDLE unit of the batch-of-3

    const pFiller = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20);
    const p1 = transactor.runInTransaction(async (ctx) => {
      ctx.put(ids[1]!, { u: 1n });
      return "v1";
    });
    const p2 = transactor.runInTransaction(async (ctx) => {
      ctx.put(ids[2]!, { u: 2n });
      return "v2";
    });
    const p3 = transactor.runInTransaction(async (ctx) => {
      ctx.put(ids[3]!, { u: 3n });
      return "v3";
    });
    await delay(20);
    g.release();

    const rFiller = await pFiller;
    const r1 = await p1;
    const r3 = await p3;
    // Unit 2 — and ONLY unit 2 — is rejected, with the guard's code.
    await expect(p2).rejects.toBeInstanceOf(CommitGuardRejection);
    await expect(p2).rejects.toMatchObject({ rejectionCode: "FLEET_IDEMPOTENCY_CONFLICT" });

    // Units 1 + 3 committed with fresh, strictly-increasing ts above the filler.
    expect(r1.committed).toBe(true);
    expect(r1.value).toBe("v1");
    expect(r3.committed).toBe(true);
    expect(r3.value).toBe("v3");
    expect(r1.commitTs > rFiller.commitTs).toBe(true);
    expect(r3.commitTs > r1.commitTs).toBe(true);

    // Ordering invariant held across the split: fan-out is filler, u1, u3 — strictly in unit order,
    // unit 2 never published.
    expect(deltas).toHaveLength(3);
    const tss = deltas.map((d) => d.commitTs);
    for (let i = 1; i < tss.length; i++) expect(tss[i]! > tss[i - 1]!).toBe(true);
    expect(deltas[1]!.commitTs).toBe(r1.commitTs);
    expect(deltas[2]!.commitTs).toBe(r3.commitTs);

    // Unit 2's row never landed (the rolled-back txn); units 1 + 3 did.
    expect(await countRevisions(store, ids[2]!)).toHaveLength(0);
    expect(await countRevisions(store, ids[1]!)).toHaveLength(1);
    expect(await countRevisions(store, ids[3]!)).toHaveLength(1);

    // Split trace: filler(1) → batch(3) rejected → re-flush the remainder(2).
    expect(store.flushes).toEqual([1, 3, 2]);
  });

  it("bounded at 3 split-retries: a guard rejecting a different unit each flush splits 3× then rejects the remaining chunk retryably", async () => {
    const { store, transactor } = await makeGroup();
    const ids = Array.from({ length: 5 }, () => newDocumentId(TABLE));

    const g = gate();
    store.hold = async (fi) => {
      if (fi === 0) await g.promise;
    };
    // Reject the HEAD of every real flush — an always-rejecting, always-moving guard.
    store.throwPlan = (_units, fi) =>
      fi >= 1 ? new CommitGuardRejection(0, "FLEET_IDEMPOTENCY_CONFLICT", `flush=${fi}`) : null;

    const pFiller = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20);
    const reals = [1, 2, 3, 4].map((k) =>
      transactor.runInTransaction(async (ctx) => {
        ctx.put(ids[k]!, { u: BigInt(k) });
        return `v${k}`;
      }),
    );
    await delay(20);
    g.release();

    await pFiller;
    const results = await Promise.allSettled(reals);
    // All four rejected: three were split out (coded), the last remaining chunk rejects retryably —
    // every rejection is a retryable CommitGuardRejection.
    for (const r of results) {
      expect(r.status).toBe("rejected");
      const err = (r as PromiseRejectedResult).reason;
      expect(err).toBeInstanceOf(CommitGuardRejection);
      expect(isRetryableError(err)).toBe(true);
    }

    // The load-bearing bound proof: the batch-of-4 is re-flushed at 3,2,1 (three splits) then the loop
    // STOPS — it does NOT re-flush the last unit forever. flush sizes: filler(1), 4, 3, 2, 1.
    expect(store.flushes).toEqual([1, 4, 3, 2, 1]);

    // The committer survived: a later mutation commits normally.
    store.throwPlan = () => null;
    const after = await transactor.runInTransaction(async (ctx) => ctx.put(newDocumentId(TABLE), { done: 1n }));
    expect(after.committed).toBe(true);
  });

  it("a non-CommitGuardRejection flush error (e.g. a fence) is whole-batch — every unit rejects, no split re-flush", async () => {
    const { store, transactor } = await makeGroup();
    const ids = Array.from({ length: 3 }, () => newDocumentId(TABLE));

    const g = gate();
    store.hold = async (fi) => {
      if (fi === 0) await g.promise;
    };
    // A fence-shaped error (name FencedError) on the batch-of-2 — NOT a CommitGuardRejection, so it
    // must abort the WHOLE batch and never trigger a per-unit split re-flush.
    store.throwPlan = (units, fi) =>
      fi === 1 && units.length === 2 ? Object.assign(new Error("fenced"), { name: "FencedError" }) : null;

    const pFiller = transactor.runInTransaction(async (ctx) => ctx.put(ids[0]!, { i: 0n }));
    await delay(20);
    const pB = transactor.runInTransaction(async (ctx) => ctx.put(ids[1]!, { b: 1n }));
    const pC = transactor.runInTransaction(async (ctx) => ctx.put(ids[2]!, { c: 1n }));
    await delay(20);
    g.release();

    await expect(pFiller).resolves.toMatchObject({ committed: true });
    await expect(pB).rejects.toMatchObject({ name: "FencedError" });
    await expect(pC).rejects.toMatchObject({ name: "FencedError" });
    // The {B,C} batch was flushed ONCE (a fence is never split); no re-flush of size 1.
    expect(store.flushes).toEqual([1, 2]);
  });
});
