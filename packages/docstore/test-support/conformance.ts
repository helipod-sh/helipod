import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DocStore, DocumentLogEntry, InternalDocumentId, IndexWrite } from "../src/types";
import { getPrevRevQueryKey } from "../src/types";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return {
    ts,
    id,
    prev_ts: prevTs,
    value: body === null ? null : { id, value: { body, n: ts } },
  };
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

/** The DocStore behavioral contract. Every backend must pass this identically. */
export function runDocStoreConformance(
  label: string,
  makeStore: () => Promise<DocStore>,
  teardown?: (store: DocStore) => Promise<void>,
): void {
  describe(label, () => {
    let store: DocStore;
    beforeEach(async () => {
      store = await makeStore();
    });
    afterEach(async () => {
      if (teardown) await teardown(store);
    });

    describe("MVCC document revisions", () => {
      it("reads the newest revision visible at a read timestamp", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

        expect(await store.get(id, 0n)).toBeNull(); // nothing visible before ts 1
        expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
        expect((await store.get(id, 2n))!.value.value.body).toBe("v2");
        const latest = (await store.get(id))!;
        expect(latest.value.value.body).toBe("v2");
        expect(latest.ts).toBe(2n);
        expect(latest.prev_ts).toBe(1n); // chain back to v1
      });

      it("hides a tombstoned document while preserving its history", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await store.write([rev(id, 2n, 1n, "v2")], [], "Error");
        await store.write([rev(id, 3n, 2n, null)], [], "Error"); // delete

        expect(await store.get(id)).toBeNull(); // deleted as of latest
        expect((await store.get(id, 2n))!.value.value.body).toBe("v2"); // history intact
        expect(await store.count(TABLE_ID)).toBe(0);
      });

      it("round-trips bigint and preserves value fidelity", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 5n, null, "x")], [], "Error");
        expect((await store.get(id))!.value.value.n).toBe(5n);
      });
    });

    describe("MVCC index scans", () => {
      function indexUpdate(indexId: string, ts: bigint, key: Uint8Array, docId: InternalDocumentId | null): IndexWrite {
        return {
          ts,
          update: {
            indexId,
            key,
            value: docId === null ? { type: "Deleted" } : { type: "NonClustered", docId },
          },
        };
      }

      it("resolves index entries to documents at a point in time", async () => {
        const indexId = encodeStorageIndexId(TABLE, "by_body");
        const a = newDocumentId(TABLE);
        const b = newDocumentId(TABLE);
        const keyA = encodeIndexKey(["apple"]);
        const keyB = encodeIndexKey(["banana"]);

        await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, keyA, a)], "Error");
        await store.write([rev(b, 2n, null, "banana")], [indexUpdate(indexId, 2n, keyB, b)], "Error");

        const all = await collect(
          store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "asc"),
        );
        expect(all.map(([, doc]) => doc.value.value.body)).toEqual(["apple", "banana"]); // key order

        const desc = await collect(
          store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "desc"),
        );
        expect(desc.map(([, doc]) => doc.value.value.body)).toEqual(["banana", "apple"]);
      });

      it("honors index deletions at the right timestamp", async () => {
        const indexId = encodeStorageIndexId(TABLE, "by_body");
        const a = newDocumentId(TABLE);
        const keyA = encodeIndexKey(["apple"]);

        await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, keyA, a)], "Error");
        // delete the index entry (and tombstone the doc) at ts 2
        await store.write([rev(a, 2n, 1n, null)], [indexUpdate(indexId, 2n, keyA, null)], "Error");

        const atOne = await collect(store.index_scan(indexId, TABLE_ID, 1n, { start: encodeIndexKey([]), end: null }, "asc"));
        expect(atOne).toHaveLength(1);
        const atTwo = await collect(store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "asc"));
        expect(atTwo).toHaveLength(0);
      });

      it("restricts to the requested key interval", async () => {
        const indexId = encodeStorageIndexId(TABLE, "by_body");
        const a = newDocumentId(TABLE);
        const b = newDocumentId(TABLE);
        await store.write([rev(a, 1n, null, "apple")], [indexUpdate(indexId, 1n, encodeIndexKey(["apple"]), a)], "Error");
        await store.write([rev(b, 2n, null, "cherry")], [indexUpdate(indexId, 2n, encodeIndexKey(["cherry"]), b)], "Error");

        const onlyApple = await collect(
          store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey(["a"]), end: encodeIndexKey(["b"]) }, "asc"),
        );
        expect(onlyApple.map(([, d]) => d.value.value.body)).toEqual(["apple"]);
      });
    });

    describe("log tailing", () => {
      it("returns revisions in timestamp order, including tombstones", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await store.write([rev(id, 2n, 1n, "v2")], [], "Error");
        await store.write([rev(id, 3n, 2n, null)], [], "Error");

        const entries = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 4n }, "asc"));
        expect(entries.map((e) => e.ts)).toEqual([1n, 2n, 3n]);
        expect(entries.map((e) => (e.value === null ? null : e.value.value.body))).toEqual(["v1", "v2", null]);
      });

      it("bounds the scan by `limit`, returning the N lowest-ts revisions, and resumes", async () => {
        // Five commits across two docs, one revision per ts (1..5).
        const a = newDocumentId(TABLE);
        const b = newDocumentId(TABLE);
        await store.write([rev(a, 1n, null, "a1")], [], "Error");
        await store.write([rev(b, 2n, null, "b1")], [], "Error");
        await store.write([rev(a, 3n, 1n, "a2")], [], "Error");
        await store.write([rev(b, 4n, 2n, "b2")], [], "Error");
        await store.write([rev(a, 5n, 3n, "a3")], [], "Error");

        // limit=2 → exactly the two lowest-ts revisions from minInclusive.
        const page1 = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 100n }, "asc", 2));
        expect(page1.map((e) => e.ts)).toEqual([1n, 2n]);

        // Resume strictly after the last returned ts → the next two.
        const page2 = await collect(store.load_documents({ minInclusive: 3n, maxExclusive: 100n }, "asc", 2));
        expect(page2.map((e) => e.ts)).toEqual([3n, 4n]);

        // A limit larger than the remaining range returns just what's left (no padding, no error).
        const page3 = await collect(store.load_documents({ minInclusive: 5n, maxExclusive: 100n }, "asc", 2));
        expect(page3.map((e) => e.ts)).toEqual([5n]);
      });

      it("counts every revision (including tombstones) toward `limit`", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await store.write([rev(id, 2n, 1n, null)], [], "Error"); // tombstone
        await store.write([rev(id, 3n, 2n, "v3")], [], "Error");

        // limit=2 must include the tombstone at ts 2 (a raw LIMIT that skipped it would be a bug).
        const page = await collect(store.load_documents({ minInclusive: 1n, maxExclusive: 100n }, "asc", 2));
        expect(page.map((e) => e.ts)).toEqual([1n, 2n]);
        expect(page[1]!.value).toBeNull();
      });
    });

    describe("previous_revisions (OCC support)", () => {
      it("returns the revision visible at each queried timestamp", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await store.write([rev(id, 2n, 1n, "v2")], [], "Error");

        const result = await store.previous_revisions([
          { id, ts: 1n },
          { id, ts: 2n },
        ]);
        expect(result.get(getPrevRevQueryKey(id, 1n))!.ts).toBe(1n);
        expect(result.get(getPrevRevQueryKey(id, 2n))!.value!.value.body).toBe("v2");
      });
    });

    describe("globals", () => {
      it("round-trips and supports if-absent semantics", async () => {
        expect(await store.getGlobal("schema_version")).toBeNull();
        await store.writeGlobal("schema_version", 3);
        expect(await store.getGlobal("schema_version")).toBe(3);

        expect(await store.writeGlobalIfAbsent("once", "a")).toBe(true);
        expect(await store.writeGlobalIfAbsent("once", "b")).toBe(false);
        expect(await store.getGlobal("once")).toBe("a");
      });
    });

    describe("conflict strategy", () => {
      it("rejects a duplicate (id, ts) under Error but replaces under Overwrite", async () => {
        const id = newDocumentId(TABLE);
        await store.write([rev(id, 1n, null, "v1")], [], "Error");
        await expect(store.write([rev(id, 1n, null, "dup")], [], "Error")).rejects.toThrow();
        await store.write([rev(id, 1n, null, "replaced")], [], "Overwrite");
        expect((await store.get(id, 1n))!.value.value.body).toBe("replaced");
      });
    });

    describe("scan", () => {
      it("returns live documents in a table at a timestamp", async () => {
        const a = newDocumentId(TABLE);
        const b = newDocumentId(TABLE);
        await store.write([rev(a, 1n, null, "a")], [], "Error");
        await store.write([rev(b, 2n, null, "b")], [], "Error");
        expect((await store.scan(TABLE_ID)).length).toBe(2);
        await store.write([rev(a, 3n, 1n, null)], [], "Error"); // delete a
        const live = await store.scan(TABLE_ID);
        expect(live.map((d) => d.value.value.body)).toEqual(["b"]);
      });
    });

    // The store-allocated commit-timestamp contract (Fenced Frontier B1, D1). Entries arrive with
    // placeholder ts (0n); the store stamps every document + index row with a freshly-allocated ts
    // inside its own atomicity domain and returns it. Raw shard_id column assertions (case (e)) need
    // storage-specific SQL that the suite's vocabulary can't reach, so they live in each store's own
    // test file (docstore-sqlite/test/commit-write.test.ts, docstore-postgres/test/commit-guard.test.ts).
    describe("commitWrite (store-allocated timestamps)", () => {
      function indexUpdate(indexId: string, key: Uint8Array, docId: InternalDocumentId): IndexWrite {
        return { ts: 0n, update: { indexId, key, value: { type: "NonClustered", docId } } };
      }

      // (a) strictly increasing across calls, and greater than any prior write()'s ts.
      it("allocates strictly increasing timestamps greater than any prior write()", async () => {
        const w = newDocumentId(TABLE);
        await store.write([rev(w, 5n, null, "prior")], [], "Error"); // prior write() at ts 5

        const a = newDocumentId(TABLE);
        const t1 = await store.commitWrite([rev(a, 0n, null, "c1")], []);
        expect(t1).toBeGreaterThan(5n);

        const b = newDocumentId(TABLE);
        const t2 = await store.commitWrite([rev(b, 0n, null, "c2")], []);
        expect(t2).toBeGreaterThan(t1);
      });

      // (b) every row of one commit shares the returned ts (verified via get AND index_scan).
      it("stamps every document and index row of a commit with the returned ts", async () => {
        const id = newDocumentId(TABLE);
        const indexId = encodeStorageIndexId(TABLE, "by_body");
        const key = encodeIndexKey(["apple"]);
        const commitTs = await store.commitWrite([rev(id, 0n, null, "apple")], [indexUpdate(indexId, key, id)]);

        expect((await store.get(id))!.ts).toBe(commitTs);
        const scanned = await collect(
          store.index_scan(indexId, TABLE_ID, commitTs, { start: encodeIndexKey([]), end: null }, "asc"),
        );
        expect(scanned).toHaveLength(1);
        expect(scanned[0]![1].ts).toBe(commitTs);
      });

      // (c) the 0n placeholder is never persisted.
      it("never persists the 0n placeholder timestamp", async () => {
        const id = newDocumentId(TABLE);
        await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect(await store.get(id, 0n)).toBeNull(); // nothing visible at ts 0
        const atZero = await collect(store.load_documents({ minInclusive: 0n, maxExclusive: 1n }, "asc"));
        expect(atZero).toHaveLength(0); // no log entry at ts 0
      });

      // (d) maxTimestamp() reflects the returned ts immediately after commit.
      it("makes the committed ts the new maxTimestamp()", async () => {
        const id = newDocumentId(TABLE);
        const commitTs = await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect(await store.maxTimestamp()).toBe(commitTs);
      });

      // Seeding: a fresh store allocates from 1 (or greater, per the store's seeding policy).
      it("allocates 1n or greater on a fresh store", async () => {
        const id = newDocumentId(TABLE);
        const commitTs = await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect(commitTs).toBeGreaterThanOrEqual(1n);
      });
    });

    // Group commit (Fleet B4, D1): `commitWriteBatch` commits N units as ONE store transaction, each
    // unit stamped with its own strictly-increasing ts (in unit order), all-or-nothing on any error.
    // These are the store-agnostic behaviors both backends must satisfy identically; the Postgres
    // batch-shaped guard (fence-once, frontier at ts_N, per-unit idempotency) lives in the fleet suite.
    describe("commitWriteBatch (group commit — Fleet B4)", () => {
      // (a) unit order = ts order, strictly increasing; each unit's rows visible at its own ts.
      it("stamps each unit its own strictly-increasing ts in unit order", async () => {
        const [a, b, c] = [newDocumentId(TABLE), newDocumentId(TABLE), newDocumentId(TABLE)];
        const tss = await store.commitWriteBatch([
          { documents: [rev(a, 0n, null, "a")], indexUpdates: [] },
          { documents: [rev(b, 0n, null, "b")], indexUpdates: [] },
          { documents: [rev(c, 0n, null, "c")], indexUpdates: [] },
        ]);

        expect(tss).toHaveLength(3);
        expect(tss[0]! < tss[1]! && tss[1]! < tss[2]!).toBe(true); // strictly increasing, in unit order
        // Each unit's doc is the one stamped with THAT unit's returned ts.
        expect((await store.get(a))!.ts).toBe(tss[0]);
        expect((await store.get(b))!.ts).toBe(tss[1]);
        expect((await store.get(c))!.ts).toBe(tss[2]);
        expect(await store.maxTimestamp()).toBe(tss[2]); // batch high-water mark
      });

      // (b) single ≡ one-unit batch: commitWrite delegates to a one-unit commitWriteBatch, so the two
      // paths allocate + land identically (the store never distinguishes them).
      it("commitWrite is byte-identical to a one-unit commitWriteBatch", async () => {
        const single = newDocumentId(TABLE);
        const t1 = await store.commitWrite([rev(single, 0n, null, "via-single")], []);

        const batched = newDocumentId(TABLE);
        const [t2] = await store.commitWriteBatch([{ documents: [rev(batched, 0n, null, "via-batch")], indexUpdates: [] }]);

        expect(t2).toBe(t1 + 1n); // consecutive: the one-unit batch is just the next commit
        expect((await store.get(single))!.value.value.body).toBe("via-single");
        expect((await store.get(batched))!.value.value.body).toBe("via-batch");
      });

      // (c) atomicity: a failure on a later unit aborts ALL units — nothing lands (D1). Portable poison:
      // a `value` that fails serialization on both stores (an `undefined` field), thrown mid-batch AFTER
      // unit 1 has already inserted — proving unit 1 rolls back with the transaction.
      it("aborts the WHOLE batch when a later unit fails — zero rows land", async () => {
        const good = newDocumentId(TABLE);
        const bad = newDocumentId(TABLE);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const poison = { ts: 0n, id: bad, prev_ts: null, value: { id: bad, value: { body: undefined } } } as any;

        await expect(
          store.commitWriteBatch([
            { documents: [rev(good, 0n, null, "unit-1")], indexUpdates: [] },
            { documents: [poison], indexUpdates: [] },
          ]),
        ).rejects.toThrow();

        // Unit 1 rolled back together with the failing unit 2 — neither doc exists.
        expect(await store.get(good)).toBeNull();
        expect(await store.get(bad)).toBeNull();
      });

      // (d) cross-unit density: two units writing DIFFERENT docs chain their own per-doc prev_ts
      // revisions correctly and independently. (The batch-cut rule means the SAME doc never appears in
      // two units of one batch — the store need not, and does not, handle that; documented on `CommitUnit`.)
      it("chains per-doc prev_ts revisions across units writing different docs", async () => {
        const x = newDocumentId(TABLE);
        const y = newDocumentId(TABLE);
        const [tx0, ty0] = await store.commitWriteBatch([
          { documents: [rev(x, 0n, null, "x0")], indexUpdates: [] },
          { documents: [rev(y, 0n, null, "y0")], indexUpdates: [] },
        ]);

        // A second batch updates each doc, chaining prev_ts back to that doc's own first revision.
        const [tx1, ty1] = await store.commitWriteBatch([
          { documents: [rev(x, 0n, tx0!, "x1")], indexUpdates: [] },
          { documents: [rev(y, 0n, ty0!, "y1")], indexUpdates: [] },
        ]);

        expect(tx0! < ty0! && ty0! < tx1! && tx1! < ty1!).toBe(true); // all four strictly increasing
        const latestX = (await store.get(x))!;
        const latestY = (await store.get(y))!;
        expect(latestX.value.value.body).toBe("x1");
        expect(latestX.prev_ts).toBe(tx0); // X's chain points back to X's first rev, not Y's
        expect(latestY.value.value.body).toBe("y1");
        expect(latestY.prev_ts).toBe(ty0); // Y's chain is independent
        // The historical revisions are still visible at their own ts.
        expect((await store.get(x, tx0!))!.value.value.body).toBe("x0");
        expect((await store.get(y, ty0!))!.value.value.body).toBe("y0");
      });
    });

    // The commit-guard chain (Receipted Outbox decision 2 — `addCommitGuard(guard): () => void`,
    // generalizing the old single-slot `setCommitGuard`). This slice of the guard contract is
    // store-agnostic (never touches the store-specific `q` querier), so it belongs here rather
    // than duplicated per-store; each store's OWN test file covers what it does with `q` (the
    // async `PgQuerier` for Postgres, the synchronous `SqliteGuardQuerier` — incl. SQLite's
    // thenable dev-throw — for SQLite).
    describe("commit guard chain (addCommitGuard)", () => {
      it("runs guards in REGISTRATION order", async () => {
        const order: string[] = [];
        store.addCommitGuard(() => {
          order.push("first");
        });
        store.addCommitGuard(() => {
          order.push("second");
        });

        const id = newDocumentId(TABLE);
        await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect(order).toEqual(["first", "second"]);
      });

      it("ANY guard throwing aborts the WHOLE commit — zero rows land, later guards never run", async () => {
        const ran: string[] = [];
        store.addCommitGuard(() => {
          ran.push("first");
        });
        store.addCommitGuard(() => {
          ran.push("second");
          throw new Error("guard rejects");
        });
        store.addCommitGuard(() => {
          ran.push("third"); // must never run
        });

        const id = newDocumentId(TABLE);
        await expect(store.commitWrite([rev(id, 0n, null, "x")], [])).rejects.toThrow("guard rejects");
        expect(ran).toEqual(["first", "second"]);
        expect(await store.get(id)).toBeNull(); // nothing landed
      });

      it("the returned unregister function removes exactly that guard — a no-op if called again", async () => {
        const order: string[] = [];
        const unregisterA = store.addCommitGuard(() => {
          order.push("A");
        });
        store.addCommitGuard(() => {
          order.push("B");
        });

        unregisterA();
        unregisterA(); // second call — a no-op, not a throw

        const id = newDocumentId(TABLE);
        await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect(order).toEqual(["B"]);
      });

      it("commits normally when no guard is registered (Tier 0 — the common case)", async () => {
        const id = newDocumentId(TABLE);
        const commitTs = await store.commitWrite([rev(id, 0n, null, "x")], []);
        expect((await store.get(id))!.ts).toBe(commitTs);
      });
    });
  });
}
