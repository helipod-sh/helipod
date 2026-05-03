/**
 * §6.1 — the DO-SQLite adapter proven inside a REAL Durable Object (workerd), closing the gap Slice 2
 * named: its conformance ran only against a faithful in-process `node:sqlite` stand-in, not real
 * DO-SQLite. Here `DoSqliteAdapter` drives the ACTUAL `state.storage.sql` + `state.storage.transactionSync`
 * of a live DO (via `runInDurableObject`), exercising the MVCC document/index/tombstone contract plus
 * the adapter's DO-specific paths (ArrayBuffer→Uint8Array blob wrap, `transactionSync` atomicity,
 * `bigint`→`number` bind narrowing, multi-statement DDL).
 *
 * FIDELITY NOTE (honest): the shared `runDocStoreConformance` describe-block cannot be nested inside a
 * single `runInDurableObject` (its per-`it` `beforeEach` would need DO-storage access from the test
 * context, which workerd forbids outside a request). So this drives the SAME store contract with the
 * SAME primitives, in-DO. The full shared suite already passes at API-shape fidelity (Slice 2); this
 * adds the real-runtime proof for the DO-specific code paths.
 *
 * `SQLITE_FULL` (10 GB) is NOT inducible in a test — this asserts the classifier PASSES a real
 * constraint error through untouched (the property the conflict strategy relies on) and records that
 * the 10 GB message text remains inferred (§8.5). Do not claim it verified.
 */
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { DoSqliteAdapter, isDatabaseFullError } from "@stackbase/docstore-do-sqlite";
import type { DocStore, DocumentLogEntry, InternalDocumentId } from "@stackbase/docstore";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

/** Build a `SqliteDocStore` over the live DO's real SQLite. */
function storeOver(state: { storage: { sql: unknown; transactionSync: unknown } }): SqliteDocStore {
  const adapter = new DoSqliteAdapter({
    // Real DO surfaces — the whole point of this test.
    sql: state.storage.sql as never,
    transactionSync: (state.storage.transactionSync as (fn: () => unknown) => unknown).bind(state.storage) as never,
  });
  return new SqliteDocStore(adapter);
}

/** A fresh DO instance per test → isolated real DO-SQLite storage. */
function freshStub(name: string) {
  const ns = (env as { SQL_PROBE: { idFromName(n: string): unknown; get(id: unknown): unknown } }).SQL_PROBE;
  return ns.get(ns.idFromName(name)) as Parameters<typeof runInDurableObject>[0];
}

describe("DoSqliteAdapter — inside a REAL Durable Object (workerd)", () => {
  it("reads the newest MVCC revision visible at a read timestamp", async () => {
    await runInDurableObject(freshStub("mvcc"), async (_i, state) => {
      const store = storeOver(state);
      await store.setupSchema();
      const id = newDocumentId(TABLE);
      await store.write([rev(id, 1n, null, "v1")], [], "Error");
      await store.write([rev(id, 2n, 1n, "v2")], [], "Error");
      expect(await store.get(id, 0n)).toBeNull();
      expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
      const latest = (await store.get(id))!;
      expect(latest.value.value.body).toBe("v2");
      expect(latest.ts).toBe(2n); // bigint round-trip through DO-SQLite's number-only integers
      expect(latest.prev_ts).toBe(1n);
    });
  });

  it("hides a tombstoned document but preserves history, and counts live rows", async () => {
    await runInDurableObject(freshStub("tomb"), async (_i, state) => {
      const store = storeOver(state);
      await store.setupSchema();
      const id = newDocumentId(TABLE);
      await store.write([rev(id, 1n, null, "v1")], [], "Error");
      await store.write([rev(id, 2n, 1n, null)], [], "Error"); // delete
      expect(await store.get(id)).toBeNull();
      expect((await store.get(id, 1n))!.value.value.body).toBe("v1");
      expect(await store.count(TABLE_ID)).toBe(0);
    });
  });

  it("resolves index entries to documents in key order (asc + desc)", async () => {
    await runInDurableObject(freshStub("index"), async (_i, state) => {
      const store = storeOver(state);
      await store.setupSchema();
      const indexId = encodeStorageIndexId(TABLE, "by_body");
      const a = newDocumentId(TABLE);
      const b = newDocumentId(TABLE);
      await store.write(
        [rev(a, 1n, null, "apple")],
        [{ ts: 1n, update: { indexId, key: encodeIndexKey(["apple"]), value: { type: "NonClustered", docId: a } } }],
        "Error",
      );
      await store.write(
        [rev(b, 2n, null, "banana")],
        [{ ts: 2n, update: { indexId, key: encodeIndexKey(["banana"]), value: { type: "NonClustered", docId: b } } }],
        "Error",
      );
      const asc = await collect(store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "asc"));
      expect(asc.map(([, d]) => d.value.value.body)).toEqual(["apple", "banana"]);
      const desc = await collect(store.index_scan(indexId, TABLE_ID, 2n, { start: encodeIndexKey([]), end: null }, "desc"));
      expect(desc.map(([, d]) => d.value.value.body)).toEqual(["banana", "apple"]);
    });
  });

  it("makes transactionSync atomic — a throwing write rolls back with no partial state", async () => {
    await runInDurableObject(freshStub("txn"), async (_i, state) => {
      const store = storeOver(state);
      await store.setupSchema();
      const id = newDocumentId(TABLE);
      await store.write([rev(id, 1n, null, "committed")], [], "Error");
      // A duplicate (id, ts) under the "Error" conflict strategy must be REJECTED (real SQLITE_CONSTRAINT
      // through DO-SQLite) — proving the adapter's constraint error PASSES THROUGH (not swallowed as
      // DATABASE_FULL), the property the conflict strategy relies on.
      let threw = false;
      try {
        await store.write([rev(id, 1n, null, "dup")], [], "Error");
      } catch (e) {
        threw = true;
        expect(isDatabaseFullError(e)).toBe(false); // a constraint error is NOT misclassified as FULL
      }
      expect(threw).toBe(true);
      // The original row is intact; the rejected write left nothing partial.
      expect((await store.get(id))!.value.value.body).toBe("committed");
    });
  });

  it("classifies SQLITE_FULL from a synthetic error, but NOT an unrelated failure (10 GB not inducible)", () => {
    // The 10 GB limit can't be reached in a test; assert the classifier's discrimination directly on
    // the real error SHAPE it must recognize. The genuine workerd 10 GB message text remains inferred.
    expect(isDatabaseFullError(new Error("database or disk is full"))).toBe(true);
    expect(isDatabaseFullError(new Error("SQLITE_FULL: database or disk is full"))).toBe(true);
    expect(isDatabaseFullError(new Error("UNIQUE constraint failed"))).toBe(false);
  });
});
