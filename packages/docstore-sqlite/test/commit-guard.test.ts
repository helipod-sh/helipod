/**
 * `SqliteDocStore` commit guard chain (Receipted Outbox decision 2): the guard slot→chain
 * migration on the SQLite side. Unlike Postgres, SQLite's commit runs inside ONE synchronous
 * `db.transaction(() => {...})` — guards here are handed a synchronous `SqliteGuardQuerier` and
 * MUST themselves be synchronous; a guard that returns a thenable (i.e. is declared `async`) is a
 * documented dev-time error (it can't be awaited inside the synchronous commit), proven below.
 * Mirrors `packages/docstore-postgres/test/commit-guard.test.ts`'s chain-order/abort/unregister
 * coverage — the store-agnostic slice of that behavior also lives in the shared conformance suite
 * (`packages/docstore/test-support/conformance.ts`).
 */
import { describe, it, expect } from "vitest";
import { newDocumentId, type InternalDocumentId } from "@helipod/id-codec";
import type { DocumentLogEntry } from "@helipod/docstore";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

const TABLE = 20010;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}

function makeStore(): SqliteDocStore {
  return new SqliteDocStore(new NodeSqliteAdapter()); // in-memory
}

describe("SqliteDocStore addCommitGuard (the chain, synchronous)", () => {
  it("runs guards in REGISTRATION order, synchronously, inside the one-transaction commit", async () => {
    const store = makeStore();
    await store.setupSchema();
    const order: string[] = [];
    store.addCommitGuard(() => {
      order.push("first");
    });
    store.addCommitGuard(() => {
      order.push("second");
    });

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(order).toEqual(["first", "second"]);
    store.close();
  });

  it("ANY guard throwing aborts the WHOLE synchronous transaction — zero rows land", async () => {
    const store = makeStore();
    await store.setupSchema();
    const ran: string[] = [];
    store.addCommitGuard(() => {
      ran.push("first");
    });
    store.addCommitGuard(() => {
      ran.push("second");
      throw new Error("second rejects");
    });
    store.addCommitGuard(() => {
      ran.push("third"); // must never run
    });

    const id = newDocumentId(TABLE);
    await expect(store.commitWrite([doc(id, "x")], [])).rejects.toThrow("second rejects");
    expect(ran).toEqual(["first", "second"]);
    expect(await store.get(id)).toBeNull(); // rolled back with the rest of the synchronous txn
    store.close();
  });

  it("the returned unregister function removes exactly that guard — a no-op if called again", async () => {
    const store = makeStore();
    await store.setupSchema();
    const order: string[] = [];
    const unregisterA = store.addCommitGuard(() => {
      order.push("A");
    });
    store.addCommitGuard(() => {
      order.push("B");
    });

    unregisterA();
    unregisterA(); // second call — a no-op

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(order).toEqual(["B"]);
    store.close();
  });

  it("a guard returning a thenable (an `async` guard) is a documented dev-time error", async () => {
    const store = makeStore();
    await store.setupSchema();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately violating the sync contract
    store.addCommitGuard((async () => {}) as any);

    const id = newDocumentId(TABLE);
    await expect(store.commitWrite([doc(id, "x")], [])).rejects.toThrow(
      /synchronous/i,
    );
    // The dev-throw aborts the transaction like any other guard error — nothing lands.
    expect(await store.get(id)).toBeNull();
    store.close();
  });

  it("guards see the per-unit `meta` threaded from commitWrite's opts", async () => {
    const store = makeStore();
    await store.setupSchema();
    const seenMeta: (Record<string, string> | undefined)[] = [];
    store.addCommitGuard((_q, units) => {
      seenMeta.push(...units.map((u) => u.meta));
    });

    const id1 = newDocumentId(TABLE);
    await store.commitWrite([doc(id1, "with-meta")], [], undefined, { meta: { clientId: "c1" } });
    const id2 = newDocumentId(TABLE);
    await store.commitWrite([doc(id2, "no-meta")], []);

    expect(seenMeta).toEqual([{ clientId: "c1" }, undefined]);
    store.close();
  });

  it("a guard is skipped entirely on an empty batch — nothing to commit, nothing to guard", async () => {
    const store = makeStore();
    await store.setupSchema();
    let ran = false;
    store.addCommitGuard(() => {
      ran = true;
    });

    const tss = await store.commitWriteBatch([]);
    expect(tss).toEqual([]);
    expect(ran).toBe(false);
    store.close();
  });
});
