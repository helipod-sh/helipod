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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { CommitTailer, type DerivedInvalidation } from "../src/commit-notifier";

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
  close() {
    return this.real.close();
  }
}

describe("ReplicaTailer", () => {
  let client: PgliteClient;
  let primary: PostgresDocStore;
  let replica: SqliteDocStore;
  let tailer: ReplicaTailer | undefined;
  let tailer2: ReplicaTailer | undefined;
  let commitTailer: CommitTailer | undefined;

  beforeEach(async () => {
    client = new PgliteClient();
    primary = new PostgresDocStore(client);
    await primary.setupSchema();
    replica = new SqliteDocStore(new NodeSqliteAdapter());
    await replica.setupSchema();
  });

  afterEach(async () => {
    if (tailer) await tailer.stop();
    if (tailer2) await tailer2.stop();
    if (commitTailer) await commitTailer.stop();
    tailer = undefined;
    tailer2 = undefined;
    commitTailer = undefined;
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

  it("(c) invalidation parity vs slice 1's CommitTailer for identical writes (regression bridge)", async () => {
    const commitInvs: DerivedInvalidation[] = [];
    commitTailer = new CommitTailer(client, primary, {
      pollMs: 20,
      onInvalidation: async (inv) => {
        commitInvs.push(inv);
      },
    });
    await commitTailer.start();

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

    await waitUntil(() => commitInvs.length > 0 && replicaInvs.length > 0);
    expect(commitInvs).toHaveLength(1);
    expect(replicaInvs).toHaveLength(1);

    const c = commitInvs[0]!;
    const r = replicaInvs[0]!;
    expect(r.newMaxTs).toBe(c.newMaxTs);
    expect(r.writtenTables).toEqual(c.writtenTables);
    expect(r.writtenKeys).toEqual(c.writtenKeys);
    expect(r.writtenDocs).toEqual(c.writtenDocs);
  });

  it("(d) tombstone-only batch: doc-keyspace ranges + tombstone applied even with no NonClustered index row", async () => {
    const a = newDocumentId(T1);
    const ka = encodeIndexKey(["a"]);
    await primary.write([rev(a, 1n, null, "A1")], [idxPut(INDEX_ID_T1, a, ka, 1n)], "Error");

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
    await expect(reachedPromise).resolves.toBe("reached");

    // Released: release() resolves ALL pending waiters, even ones far in the future.
    const releasedPromise = tailer.waitFor(999_999n, 5000);
    tailer.release();
    await expect(releasedPromise).resolves.toBe("released");
  });
});
