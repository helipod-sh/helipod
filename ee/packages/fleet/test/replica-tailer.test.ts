/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `ReplicaTailer` — the slice 2 core: verbatim MVCC log apply from a Postgres primary onto a local
 * embedded replica (`SqliteDocStore`), batch-derived invalidation, bootstrap catch-up, and the
 * `waitFor` read-your-own-writes primitive Task 3 relies on.
 *
 * Every expected value here is computed via the engine's OWN helpers/types (`encodeIndexKey`,
 * `encodeStorageTableId`/`encodeStorageIndexId`, `DocumentLogEntry`/`IndexWrite`/`DatabaseIndexValue`
 * shapes) or read straight back from the PRIMARY store for the same args — never a hand-rolled
 * expected string/byte sequence — per the slice-1 lesson: reconstruction must invert the producer's
 * serialization exactly (`postgres-docstore.ts`'s `write()`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type {
  DocStore,
  DocumentLogEntry,
  IndexWrite,
  Interval,
  InternalDocumentId,
} from "@stackbase/docstore";
import { PgliteClient } from "./pglite-client";
import { ReplicaTailer, type AppliedInvalidation } from "../src/replica-tailer";
import { stablePrefixFromFrontier, type StablePrefixTs } from "../src/stable-prefix";
import { LeaseManager } from "../src/lease";
import { installCommitGuard } from "../src/node";

const T1 = 10001;
const T2 = 10002;
const INDEX_ID_T1 = encodeStorageIndexId(T1, "by_key");
const INDEX_ID_T2 = encodeStorageIndexId(T2, "by_key");

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}
function idxPut(indexId: string, id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId, key, value: { type: "NonClustered", docId: id } } };
}
function idxDel(indexId: string, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId, key, value: { type: "Deleted" } } };
}
async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
const FULL: Interval = { start: new Uint8Array(), end: null };

async function waitUntil(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: timed out");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * Fenced Frontier B1 (D5) test helper: advances `shard_leases.frontier_ts` (the tailer's pull
 * target `F`) directly via SQL, mirroring exactly what the epoch-fenced commit guard
 * (`installCommitGuard`, `node.ts`) does inside a real `commitWrite` transaction — `prev_ts` takes
 * the OLD frontier, `frontier_ts` becomes `ts`. Used by every test below that drives the primary
 * via the raw, caller-supplied-ts `write()` path (this file's whole reason for existing: verbatim
 * MVCC-apply parity at EXACT historical ts values) rather than `commitWrite`, which would allocate
 * its own ts and defeat that. `beforeEach` seeds a real `shard_leases` row (epoch 1, frontier 0)
 * via `LeaseManager`, so this is just "pretend the guard already ran for this raw write."
 */
async function bumpFrontier(pgClient: PgliteClient, ts: bigint): Promise<void> {
  await pgClient.query(
    `UPDATE shard_leases SET prev_ts = frontier_ts, frontier_ts = $1 WHERE shard_id = 'default'`,
    [ts],
  );
}

/** Reaches `ReplicaTailer`'s private `tick()` directly — needed by the density/F-regression tests
 *  below, which must observe a SPECIFIC tick's rejection deterministically rather than racing the
 *  fire-and-forget `setInterval`/LISTEN-wake callers (`void this.tick()`) the public API uses,
 *  where a thrown error would surface only as an unhandled rejection. */
function forceTick(t: ReplicaTailer): Promise<void> {
  return (t as unknown as { tick(): Promise<void> }).tick();
}

/** Delegates every `DocStore` method straight through to `real` EXCEPT `maxTimestamp`, which always
 *  reports 0 — used to force a SECOND `ReplicaTailer` to seed its watermark at 0 over an
 *  ALREADY-caught-up replica (test (b)), so it re-walks and re-applies the FULL primary range a
 *  second time via `"Overwrite"` instead of seeing itself as already caught up and doing nothing.
 *  Plain delegation (not a `Proxy`) so there's no `this`-rebinding risk against the real store's
 *  internals. */
class ZeroWatermarkDocStore implements DocStore {
  constructor(private readonly real: DocStore) {}
  setupSchema(...args: Parameters<DocStore["setupSchema"]>) {
    return this.real.setupSchema(...args);
  }
  write(...args: Parameters<DocStore["write"]>) {
    return this.real.write(...args);
  }
  commitWrite(...args: Parameters<DocStore["commitWrite"]>) {
    return this.real.commitWrite(...args);
  }
  commitWriteBatch(...args: Parameters<DocStore["commitWriteBatch"]>) {
    return this.real.commitWriteBatch(...args);
  }
  addCommitGuard(...args: Parameters<DocStore["addCommitGuard"]>) {
    return this.real.addCommitGuard(...args);
  }
  get(...args: Parameters<DocStore["get"]>) {
    return this.real.get(...args);
  }
  index_scan(...args: Parameters<DocStore["index_scan"]>) {
    return this.real.index_scan(...args);
  }
  load_documents(...args: Parameters<DocStore["load_documents"]>) {
    return this.real.load_documents(...args);
  }
  previous_revisions(...args: Parameters<DocStore["previous_revisions"]>) {
    return this.real.previous_revisions(...args);
  }
  scan(...args: Parameters<DocStore["scan"]>) {
    return this.real.scan(...args);
  }
  count(...args: Parameters<DocStore["count"]>) {
    return this.real.count(...args);
  }
  async maxTimestamp(): Promise<bigint> {
    return 0n;
  }
  getGlobal(...args: Parameters<DocStore["getGlobal"]>) {
    return this.real.getGlobal(...args);
  }
  writeGlobal(...args: Parameters<DocStore["writeGlobal"]>) {
    return this.real.writeGlobal(...args);
  }
  writeGlobalIfAbsent(...args: Parameters<DocStore["writeGlobalIfAbsent"]>) {
    return this.real.writeGlobalIfAbsent(...args);
  }
  getClientVerdict(...args: Parameters<DocStore["getClientVerdict"]>) {
    return this.real.getClientVerdict(...args);
  }
  getClientFloor(...args: Parameters<DocStore["getClientFloor"]>) {
    return this.real.getClientFloor(...args);
  }
  recordClientVerdict(...args: Parameters<DocStore["recordClientVerdict"]>) {
    return this.real.recordClientVerdict(...args);
  }
  updateClientVerdictValue(...args: Parameters<DocStore["updateClientVerdictValue"]>) {
    return this.real.updateClientVerdictValue(...args);
  }
  pruneClientMutations(...args: Parameters<DocStore["pruneClientMutations"]>) {
    return this.real.pruneClientMutations(...args);
  }
  sweepExpiredClientMutations(...args: Parameters<DocStore["sweepExpiredClientMutations"]>) {
    return this.real.sweepExpiredClientMutations(...args);
  }
  close() {
    return this.real.close();
  }
}

describe("ReplicaTailer", () => {
  let client: PgliteClient;
  let primary: PostgresDocStore;
  let replica: SqliteDocStore;
  let lease: LeaseManager;
  let tailer: ReplicaTailer | undefined;
  let tailer2: ReplicaTailer | undefined;

  beforeEach(async () => {
    client = new PgliteClient();
    primary = new PostgresDocStore(client);
    await primary.setupSchema();
    replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    // Fenced Frontier B1 (D5): the tailer's pull target is now `shard_leases.frontier_ts`, not
    // `primary.maxTimestamp()` — every test needs a real lease row to target. Acquiring seeds it
    // at epoch 1, frontier_ts 0 (see `lease.ts`'s `tryAcquire`); `bumpFrontier` above advances it
    // for tests that drive the primary via raw `write()` rather than the guarded `commitWrite`.
    lease = new LeaseManager(client, { advertiseUrl: "http://replica-tailer-test:0" });
    await lease.setup();
    await lease.tryAcquire();
  });

  afterEach(async () => {
    if (tailer) await tailer.stop();
    if (tailer2) await tailer2.stop();
    tailer = undefined;
    tailer2 = undefined;
    await primary.close();
    await replica.close();
  });

  it("(a) verbatim MVCC parity across 2 tables incl. historical ts — updates + a delete", async () => {
    const a = newDocumentId(T1);
    const b = newDocumentId(T2);
    const c = newDocumentId(T1);
    const ka = encodeIndexKey(["a"]);
    const kb = encodeIndexKey(["b"]);
    const ka2 = encodeIndexKey(["a2"]);
    const kc = encodeIndexKey(["c"]);

    await primary.write([rev(a, 1n, null, "A1")], [idxPut(INDEX_ID_T1, a, ka, 1n)], "Error");
    await primary.write([rev(b, 2n, null, "B1")], [idxPut(INDEX_ID_T2, b, kb, 2n)], "Error");
    // Update A: reindex — old key tombstoned, new key put, same commit ts.
    await primary.write(
      [rev(a, 3n, 1n, "A2")],
      [idxDel(INDEX_ID_T1, ka, 3n), idxPut(INDEX_ID_T1, a, ka2, 3n)],
      "Error",
    );
    await primary.write([rev(c, 4n, null, "C1")], [idxPut(INDEX_ID_T1, c, kc, 4n)], "Error");
    await primary.write([rev(b, 5n, 2n, null)], [idxDel(INDEX_ID_T2, kb, 5n)], "Error"); // delete B
    await bumpFrontier(client, 5n); // D5: reveal the whole range to the tailer's F-target

    tailer = new ReplicaTailer(client, primary, replica, {
      pollMs: 20,
      onInvalidation: async () => {},
    });
    await tailer.start();

    expect(await replica.maxTimestamp()).toBe(await primary.maxTimestamp());
    expect(await replica.maxTimestamp()).toBe(5n);

    // Historical reads (MVCC parity) — every (id, ts) pair must match the primary byte for byte.
    const checks: Array<[InternalDocumentId, bigint | undefined]> = [
      [a, 1n],
      [a, 2n],
      [a, 3n],
      [b, 2n],
      [b, 4n],
      [b, 5n],
      [c, 4n],
      [a, undefined],
      [b, undefined],
      [c, undefined],
    ];
    for (const [id, ts] of checks) {
      const expected = ts === undefined ? await primary.get(id) : await primary.get(id, ts);
      const actual = ts === undefined ? await replica.get(id) : await replica.get(id, ts);
      expect(actual).toEqual(expected);
    }
    expect(await replica.get(b)).toBeNull(); // tombstoned on both

    // Index scans must match at latest AND at a historical snapshot (before B's delete).
    const primaryLatest = await collect(primary.index_scan(INDEX_ID_T1, "", 5n, FULL, "asc"));
    const replicaLatest = await collect(replica.index_scan(INDEX_ID_T1, "", 5n, FULL, "asc"));
    expect(replicaLatest).toEqual(primaryLatest);
    expect(replicaLatest.map(([, d]) => d.value.value.body)).toEqual(["A2", "C1"]);

    const primaryAt2 = await collect(primary.index_scan(INDEX_ID_T2, "", 2n, FULL, "asc"));
    const replicaAt2 = await collect(replica.index_scan(INDEX_ID_T2, "", 2n, FULL, "asc"));
    expect(replicaAt2).toEqual(primaryAt2);
    expect(replicaAt2.map(([, d]) => d.value.value.body)).toEqual(["B1"]);
  });

  it("(b) idempotent re-apply: a second tailer forced to watermark 0 re-applies the SAME range without throwing", async () => {
    const a = newDocumentId(T1);
    const b = newDocumentId(T2);
    const ka = encodeIndexKey(["a"]);
    const kb = encodeIndexKey(["b"]);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(INDEX_ID_T1, a, ka, 1n)], "Error");
    await primary.write([rev(b, 2n, null, "B1")], [idxPut(INDEX_ID_T2, b, kb, 2n)], "Error");
    await primary.write([rev(a, 3n, 1n, null)], [idxDel(INDEX_ID_T1, ka, 3n)], "Error"); // delete a
    await bumpFrontier(client, 3n); // D5

    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20, onInvalidation: async () => {} });
    await tailer.start();
    expect(await replica.maxTimestamp()).toBe(3n);

    const beforeA = await replica.get(a);
    const beforeB = await replica.get(b);
    const beforeScan = await collect(replica.index_scan(INDEX_ID_T2, "", 3n, FULL, "asc"));

    tailer2 = new ReplicaTailer(client, primary, new ZeroWatermarkDocStore(replica), {
      pollMs: 20,
      onInvalidation: async () => {},
    });
    await expect(tailer2.start()).resolves.toBeUndefined(); // no throw on the second Overwrite pass

    expect(await replica.get(a)).toEqual(beforeA);
    expect(await replica.get(b)).toEqual(beforeB);
    expect(await collect(replica.index_scan(INDEX_ID_T2, "", 3n, FULL, "asc"))).toEqual(beforeScan);
    expect(await replica.maxTimestamp()).toBe(3n); // final state unchanged
  });

  it("(c) invalidation values match the ones computed directly from the engine helpers (parity regression)", async () => {
    // Snapshotted expectation, computed via the engine's OWN id/key codecs for the same write —
    // NOT by importing the (now-deleted) slice-1 CommitTailer and cross-checking against it.
    const replicaInvs: AppliedInvalidation[] = [];
    tailer = new ReplicaTailer(client, primary, replica, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        replicaInvs.push(inv);
      },
    });
    await tailer.start();

    const a = newDocumentId(T1);
    const ka = encodeIndexKey(["a"]);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(INDEX_ID_T1, a, ka, 1n)], "Error");
    await bumpFrontier(client, 1n); // D5: reveal it to the already-running poll loop

    await waitUntil(() => replicaInvs.length > 0);
    expect(replicaInvs).toHaveLength(1);

    const r = replicaInvs[0]!;
    expect(r.newMaxTs).toBe(1n);
    // A NonClustered index put carries the storage table id; the doc-keyspace half comes from the
    // applied DocumentLogEntry. Both are reproduced with the engine's own encoders.
    expect(r.writtenTables).toEqual([encodeStorageTableId(T1)]);
    expect(r.writtenKeys).toEqual([{ indexId: INDEX_ID_T1, key: ka }]);
    expect(r.writtenDocs).toEqual([{ tableId: encodeStorageTableId(T1), internalId: a.internalId }]);
  });

  it("(d) tombstone-only batch: doc-keyspace ranges + tombstone applied even with no NonClustered index row", async () => {
    const a = newDocumentId(T1);
    const ka = encodeIndexKey(["a"]);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(INDEX_ID_T1, a, ka, 1n)], "Error");
    await bumpFrontier(client, 1n); // D5: reveal the insert to the bootstrap catch-up below

    const invalidations: AppliedInvalidation[] = [];
    tailer = new ReplicaTailer(client, primary, replica, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        invalidations.push(inv);
      },
    });
    await tailer.start(); // bootstraps the initial insert
    expect(invalidations).toHaveLength(1);
    invalidations.length = 0; // reset — only the delete below is under test

    await primary.write([rev(a, 2n, 1n, null)], [idxDel(INDEX_ID_T1, ka, 2n)], "Error");
    await bumpFrontier(client, 2n); // D5: reveal it to the already-running poll loop
    await waitUntil(() => invalidations.length > 0);
    expect(invalidations).toHaveLength(1);

    const inv = invalidations[0]!;
    expect(inv.newMaxTs).toBe(2n);
    expect(inv.writtenTables).toEqual([]); // Deleted index row carries NULL table_id
    expect(inv.writtenKeys).toEqual([{ indexId: INDEX_ID_T1, key: ka }]);
    expect(inv.writtenDocs).toEqual([{ tableId: encodeStorageTableId(T1), internalId: a.internalId }]);

    expect(await replica.get(a)).toBeNull(); // tombstone applied on the replica
  });

  it(
    "(e) bootstrap gate: start() on 2500 pre-existing entries resolves only after full catch-up, batch capping exercised",
    async () => {
      const entries: DocumentLogEntry[] = [];
      for (let n = 1; n <= 2500; n++) {
        const id: InternalDocumentId = { tableNumber: T1, internalId: new Uint8Array([n & 0xff, (n >> 8) & 0xff]) };
        entries.push({ ts: BigInt(n), id, prev_ts: null, value: { id, value: { n } } });
      }
      await primary.write(entries, [], "Overwrite");
      await bumpFrontier(client, 2500n); // D5: reveal the whole range to the bootstrap catch-up below
      expect(await primary.maxTimestamp()).toBe(2500n);
      expect(await replica.maxTimestamp()).toBe(0n); // fresh replica

      const invalidations: AppliedInvalidation[] = [];
      tailer = new ReplicaTailer(client, primary, replica, {
        pollMs: 20,
        // batchSize left at its default (1000) — 2500 entries forces at least 3 capped batches.
        onInvalidation: async (inv) => {
          invalidations.push(inv);
        },
      });
      await tailer.start(); // must not resolve until fully caught up

      expect(await replica.maxTimestamp()).toBe(2500n);
      expect(invalidations.length).toBeGreaterThanOrEqual(3);
      expect(invalidations.at(-1)!.newMaxTs).toBe(2500n);
    },
    { timeout: 30_000 },
  );

  it("(f) waitFor resolves reached on advance, timeout after a short bound, and released after release()", async () => {
    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20, onInvalidation: async () => {} });
    await tailer.start(); // empty primary — resolves immediately, watermark 0

    // Already-reached: ts <= current watermark resolves immediately.
    await expect(tailer.waitFor(0n, 1000)).resolves.toBe("reached");

    // Timeout: nothing will ever reach ts=100 within this short window.
    await expect(tailer.waitFor(100n, 150)).resolves.toBe("timeout");

    // Reached-on-advance: a write pushes the watermark past 1, waiter resolves on the next tick.
    const reachedPromise = tailer.waitFor(1n, 5000);
    const a = newDocumentId(T1);
    await primary.write([rev(a, 1n, null, "A1")], [], "Error");
    await bumpFrontier(client, 1n); // D5: reveal it to the already-running poll loop
    await expect(reachedPromise).resolves.toBe("reached");

    // Released: release() resolves ALL pending waiters, even ones far in the future.
    const releasedPromise = tailer.waitFor(999_999n, 5000);
    tailer.release();
    await expect(releasedPromise).resolves.toBe("released");
  });

  it("(g) stop() mid-bootstrap halts the walk without arming LISTEN or the poll timer (C6)", async () => {
    // 5 pre-existing entries + batchSize 1 forces >= 2 bootstrap ticks before catch-up would
    // otherwise complete — stop() lands after the FIRST tick's onInvalidation, well before the
    // bootstrap while-loop's condition would naturally exit.
    for (let n = 1; n <= 5; n++) {
      const id = newDocumentId(T1);
      await primary.write([rev(id, BigInt(n), null, `V${n}`)], [], "Error");
    }
    await bumpFrontier(client, 5n); // D5: reveal all 5 to the (about to be interrupted) bootstrap
    const listenSpy = vi.spyOn(client, "listen");

    const invalidations: AppliedInvalidation[] = [];
    tailer = new ReplicaTailer(client, primary, replica, {
      pollMs: 20,
      batchSize: 1,
      onInvalidation: async (inv) => {
        invalidations.push(inv);
        if (invalidations.length === 1) await tailer!.stop();
      },
    });
    await tailer.start(); // must return early (stopped), NOT run all 5 ticks to completion

    expect(invalidations).toHaveLength(1); // only the first tick ever ran
    expect(await replica.maxTimestamp()).toBeLessThan(await primary.maxTimestamp()); // catch-up incomplete
    expect(listenSpy).not.toHaveBeenCalled(); // stop() landed before LISTEN was ever armed

    // If a poll timer HAD leaked, it would eventually pick up a write landing after stop() — give
    // it several poll intervals' worth of real time and confirm nothing further ever fires.
    // Deliberately NOT bumped past F=5 here: this write is a plain "does a leaked timer wake at
    // all" probe, orthogonal to F-targeting (D5) — even if it were bumped, a leaked-but-STOPPED
    // tailer must still never observe it.
    const a = newDocumentId(T1);
    await primary.write([rev(a, 6n, null, "after-stop")], [], "Error");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(invalidations).toHaveLength(1); // no further tick ran — no timer, no LISTEN wake
  });
});

/** A `commitWrite`-shaped entry with the `ts: 0n` placeholder (the store overwrites it) — mirrors
 *  `fence.test.ts`'s `doc()` helper, reused here since Task 5's new tests drive the primary
 *  through REAL guarded commits (via `installCommitGuard`) rather than raw caller-supplied-ts
 *  `write()`, so `shard_leases.frontier_ts` advances exactly like production. */
function guardedDoc(id: InternalDocumentId, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body } } };
}

describe("Fenced Frontier B1 (Task 5): tailer targets F, density assertions, StablePrefixTs", () => {
  const T = 10003;

  let client: PgliteClient;
  let primary: PostgresDocStore;
  let replica: SqliteDocStore;
  let lease: LeaseManager;
  let tailer: ReplicaTailer | undefined;

  beforeEach(async () => {
    client = new PgliteClient();
    primary = new PostgresDocStore(client);
    await primary.setupSchema();
    replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
    lease = new LeaseManager(client, { advertiseUrl: "http://fenced-frontier-test:0" });
    await lease.setup();
    await lease.tryAcquire(); // epoch 1
    installCommitGuard(primary, lease, () => {}); // every commitWrite below advances F for real
  });

  afterEach(async () => {
    if (tailer) await tailer.stop();
    tailer = undefined;
    await primary.close();
    await replica.close();
  });

  it("F-boundary: the tailer pulls exactly (wm, F] — a raw write staged ABOVE F is held back until a guarded commit advances F past it", async () => {
    const a = newDocumentId(T);
    const b = newDocumentId(T);
    const c = newDocumentId(T);

    // Guarded commit #1 — advances shard_leases.frontier_ts to its OWN commitTs (the real D3 path).
    const commit1 = await primary.commitWrite([guardedDoc(a, null, "A1")], []);
    expect((await lease.read())?.frontierTs).toBe(commit1);

    // A raw write staged strictly ABOVE the current frontier — e.g. a straggler that landed in the
    // log but was never fenced/counted. `commitWrite`'s allocator is `GREATEST(nextval, MAX(ts)+1)`
    // (postgres-docstore.ts), so it always allocates strictly above this too.
    const aboveFrontierTs = commit1 + 100n;
    await primary.write([rev(b, aboveFrontierTs, null, "STRADDLER")], [], "Error");

    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20, onInvalidation: async () => {} });
    await tailer.start();

    expect(tailer.watermark()).toBe(commit1); // caught up to F — NOT to the straddler's ts
    expect(await replica.get(b)).toBeNull(); // the above-F row was never pulled

    // A second guarded commit — F advances past the straddler's ts (commitWrite's allocator lands
    // strictly above the log's actual max, which the raw write above already bumped).
    const commit2 = await primary.commitWrite([guardedDoc(c, null, "C1")], []);
    expect(commit2).toBeGreaterThan(aboveFrontierTs);

    await waitUntil(() => tailer!.watermark() >= commit2);
    expect(tailer.watermark()).toBe(commit2);
    expect(await replica.get(b)).not.toBeNull(); // NOW pulled — F passed it
    expect((await replica.get(b))?.value.value.body).toBe("STRADDLER");
    expect(await replica.get(c)).not.toBeNull();
  });

  it("density violation: hand-tampering the replica's head HALTS the tailer, logging the doc + remedy once", async () => {
    const a = newDocumentId(T);
    const commit1 = await primary.commitWrite([guardedDoc(a, null, "A1")], []);

    // A large pollMs keeps the background setInterval from also racing this same violation while we
    // drive the tick deterministically below.
    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20_000, onInvalidation: async () => {} });
    await tailer.start(); // bootstrap applies commit1 cleanly
    expect((await replica.get(a))?.ts).toBe(commit1);

    // Hand-tamper the replica's head directly, bypassing the tailer entirely — a live head at a ts
    // the primary never produced for this doc (simulates a replica that silently diverged). Staged
    // WAY above commit1 (not just +1) so it can never coincidentally collide with whatever ts the
    // real next commit below allocates (which would make the density check's own idempotent-
    // re-apply exception — see `assertDensity` — mask this deliberately-injected violation).
    const tamperedTs = commit1 + 1000n;
    await replica.write(
      [{ ts: tamperedTs, id: a, prev_ts: commit1, value: { id: a, value: { body: "TAMPERED" } } }],
      [],
      "Overwrite",
    );

    // A real update lands on the primary, chained from the ORIGINAL (pre-tamper) revision — its
    // prev_ts (commit1) no longer matches the replica's (now tampered) head ts. Only the PRIMARY's
    // own log feeds commitWrite's ts allocator, so this lands at commit1+1 regardless of the
    // replica-only tamper above — nowhere near tamperedTs.
    const commit2 = await primary.commitWrite([guardedDoc(a, commit1, "A2")], []);
    expect(commit2).not.toBe(tamperedTs);

    // The tick now catches the DensityViolationError, HALTS the tailer, and logs the message ONCE
    // (rather than rejecting and letting the fire-and-forget caller re-hit it forever). forceTick
    // therefore RESOLVES — the violation is handled terminally, not propagated.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await forceTick(tailer); // resolves — no throw
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const message = String(errorSpy.mock.calls[0]?.[0]);
      expect(message).toContain(encodeStorageTableId(T)); // names the doc (table half)
      expect(message).toContain(String(tamperedTs)); // names the actual (wrong) head ts
      expect(message).toContain(String(commit1)); // names the expected prev_ts
      expect(message).toContain("delete <replica path>/fleet-replica.db to re-bootstrap"); // the remedy

      // HALTED: the tailer is stopped, so a further tick is a no-op — the watermark never advances
      // and nothing is re-logged (the error loop the fix eliminates would re-fire here).
      expect(tailer.watermark()).toBe(commit1); // frozen at the last clean apply, never commit2
      await forceTick(tailer);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(tailer.watermark()).toBe(commit1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("density violation (insert case): an entry with prev_ts=null but a live replica head halts the tailer", async () => {
    const a = newDocumentId(T);
    const commit1 = await primary.commitWrite([guardedDoc(a, null, "A1")], []);

    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20_000, onInvalidation: async () => {} });
    await tailer.start();
    expect(await replica.get(a)).not.toBeNull(); // `a` has a live head on the replica

    // A raw row claiming to be a FRESH INSERT (prev_ts=null) for a doc that already has a live
    // head — the insert-case violation. Bump the frontier by hand (raw write, not a guarded
    // commit) so the tailer's pull target actually reaches it.
    const bogusTs = commit1 + 1n;
    await bumpFrontier(client, bogusTs);
    await primary.write([{ ts: bogusTs, id: a, prev_ts: null, value: { id: a, value: { body: "BOGUS" } } }], [], "Error");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await forceTick(tailer); // resolves — the insert-case violation is caught + halts the tailer
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain("re-bootstrap");
      expect(tailer.watermark()).toBe(commit1); // never advanced past the bogus insert
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("density violation HALTS the fire-and-forget poll loop — the error is logged once, not every pollMs", async () => {
    const a = newDocumentId(T);
    const commit1 = await primary.commitWrite([guardedDoc(a, null, "A1")], []);

    // Small pollMs: the natural setInterval (not forceTick) must be the one that hits the violation,
    // proving the real fire-and-forget path halts rather than looping.
    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20, onInvalidation: async () => {} });
    await tailer.start(); // bootstrap applies commit1 cleanly
    expect((await replica.get(a))?.ts).toBe(commit1);

    // Diverge the replica, then land a real chained update on the primary the poll loop will pull.
    const tamperedTs = commit1 + 1000n;
    await replica.write(
      [{ ts: tamperedTs, id: a, prev_ts: commit1, value: { id: a, value: { body: "TAMPERED" } } }],
      [],
      "Overwrite",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await primary.commitWrite([guardedDoc(a, commit1, "A2")], []);

      // The background poll tick hits the violation and halts. Wait for the first (and only) log.
      await waitUntil(() => errorSpy.mock.calls.length >= 1);
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // Wait out MANY more poll intervals — a non-halting tailer would re-log ~dozens of times; a
      // halted one (interval cleared) stays at exactly one. The watermark stays frozen at commit1.
      await new Promise((r) => setTimeout(r, 500)); // ~25 pollMs periods
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(tailer.watermark()).toBe(commit1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("F-regression: a lease row whose frontier goes backward throws — F must never regress", async () => {
    const a = newDocumentId(T);
    const commit1 = await primary.commitWrite([guardedDoc(a, null, "A1")], []);
    void commit1;

    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20_000, onInvalidation: async () => {} });
    await tailer.start(); // establishes the tailer's internal lastF baseline

    // Hand-lower the lease row's frontier directly — simulates shard_leases corruption/tampering
    // (never a real code path: D3's guard only ever advances it, and D4's eviction only ever
    // GREATEST()s it).
    await client.query(`UPDATE shard_leases SET frontier_ts = 0 WHERE shard_id = 'default'`);

    await expect(forceTick(tailer)).rejects.toThrow(/frontier regression/i);
  });

  it("RYOW: waitFor(commitTs) resolves as soon as the frontier-carrying batch applies — F advances exactly WITH the commit, at one shard", async () => {
    tailer = new ReplicaTailer(client, primary, replica, { pollMs: 20, onInvalidation: async () => {} });
    await tailer.start(); // empty log

    const a = newDocumentId(T);
    const before = Date.now();
    const commitTs = await primary.commitWrite([guardedDoc(a, null, "A1")], []);
    // The commit's OWN frontier bump (D3, inside the SAME transaction) makes F >= commitTs
    // immediately — waitFor only has to wait out the tailer's next poll tick, the identical
    // latency envelope the old primary.maxTimestamp() target had. No RYOW-specific extra delay.
    const outcome = await tailer.waitFor(commitTs, 5000);
    const elapsedMs = Date.now() - before;

    expect(outcome).toBe("reached");
    expect(elapsedMs).toBeLessThan(1000); // a couple of 20ms poll ticks, nowhere near the 5s bound
    expect(await replica.get(a)).not.toBeNull();
  });

  it("StablePrefixTs brand: a raw bigint (even primary.maxTimestamp()'s) is not assignable where the brand is required — only stablePrefixFromFrontier produces one", async () => {
    const raw: bigint = await primary.maxTimestamp();

    // @ts-expect-error — StablePrefixTs can only be produced by stablePrefixFromFrontier; assigning
    // a raw, un-branded bigint (including primary.maxTimestamp()'s return value) must fail to compile.
    const bad: StablePrefixTs = raw;
    void bad;

    // The sole constructor IS how you legitimately produce one — same runtime value, just branded.
    const ok: StablePrefixTs = stablePrefixFromFrontier(raw);
    expect(ok).toBe(raw);
  });
});
