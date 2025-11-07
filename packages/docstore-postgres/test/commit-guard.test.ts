import { describe, it, expect } from "vitest";
import { newDocumentId, encodeStorageIndexId, type InternalDocumentId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite } from "@stackbase/docstore";
import { PostgresDocStore } from "../src/postgres-docstore";
import type { PgClient, PgQuerier } from "../src/pg-client";
import { PgliteClient } from "./pglite-client";

const TABLE = 20001;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  // ts arrives as the 0n placeholder — commitWrite overwrites it.
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}
function idx(indexId: string, key: Uint8Array, id: InternalDocumentId): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "NonClustered", docId: id } } };
}

async function makeStore(): Promise<{ store: PostgresDocStore; client: PgClient }> {
  const client = new PgliteClient();
  const store = new PostgresDocStore(client);
  await store.setupSchema();
  return { store, client };
}

// The commit guard (Fenced Frontier B1, D3): a fleet-installed callback that runs inside every
// commitWrite transaction, after the row inserts and before COMMIT. Exercised on PGlite (real
// Postgres semantics, in-process). Also covers the raw shard_id stamping (conformance case (e),
// which needs storage-specific SQL the shared suite can't express).
describe("PostgresDocStore commit guard", () => {
  it("invokes the batch-shaped guard (querier, units[]) after inserts, before COMMIT — one unit for a single commitWrite", async () => {
    const { store, client } = await makeStore();
    const seen: { ts: bigint; docCount: number }[] = [];
    store.setCommitGuard(async (q: PgQuerier, units) => {
      // A single commitWrite reaches the guard as a ONE-unit array (Fleet B4). The staged rows are
      // visible inside the same transaction the guard runs in.
      expect(units).toHaveLength(1);
      const commitTs = units[0]!.ts;
      const rows = await q.query(`SELECT COUNT(*)::int AS n FROM documents WHERE ts = $1`, [commitTs]);
      seen.push({ ts: commitTs, docCount: Number(rows[0]!.n) });
    });

    const id = newDocumentId(TABLE);
    const returned = await store.commitWrite([doc(id, "x")], []);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ts).toBe(returned);
    expect(seen[0]!.docCount).toBe(1);
    await client.close();
  });

  it("aborts the entire commit when the guard throws — zero rows land", async () => {
    const { store, client } = await makeStore();
    store.setCommitGuard(async () => {
      throw new Error("fenced");
    });

    const id = newDocumentId(TABLE);
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    await expect(store.commitWrite([doc(id, "x")], [idx(indexId, encodeIndexKey(["x"]), id)])).rejects.toThrow(
      "fenced",
    );

    // Both the document and index inserts are rolled back — nothing landed. (The sequence may have
    // advanced; that is acceptable — Postgres sequences are non-transactional and ts gaps are legal.)
    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(0);
    const indexes = await client.query(`SELECT COUNT(*)::int AS n FROM indexes`);
    expect(Number(indexes[0]!.n)).toBe(0);
    await client.close();
  });

  it("setCommitGuard(null) clears a previously installed guard", async () => {
    const { store, client } = await makeStore();
    store.setCommitGuard(async () => {
      throw new Error("should not run");
    });
    store.setCommitGuard(null);

    const id = newDocumentId(TABLE);
    const returned = await store.commitWrite([doc(id, "x")], []);
    expect(returned).toBeGreaterThanOrEqual(1n);
    expect((await store.get(id))!.ts).toBe(returned);
    await client.close();
  });

  it("commits normally when no guard is installed (Tier 0)", async () => {
    const { store, client } = await makeStore();
    const id = newDocumentId(TABLE);
    const returned = await store.commitWrite([doc(id, "x")], []);
    expect((await store.get(id))!.ts).toBe(returned);
    await client.close();
  });

  // Fleet B3, D3 (batch-shaped since B4): opaque commit metadata threaded through `commitWrite`'s 4th
  // `opts` param to the guard's per-unit `meta` — the "opaque meta channel" the design spec's D3
  // describes. A single commitWrite → one unit, so the guard sees `units[0].meta`.
  it("threads RunOptions-shaped commitMeta through commitWrite's opts to the guard's per-unit meta", async () => {
    const { store, client } = await makeStore();
    const seenMeta: (Record<string, string> | undefined)[] = [];
    store.setCommitGuard(async (_q, units) => {
      expect(units).toHaveLength(1);
      seenMeta.push(units[0]!.meta);
    });

    const id1 = newDocumentId(TABLE);
    await store.commitWrite([doc(id1, "with-meta")], [], undefined, { meta: { idempotencyKey: "req-1" } });
    const id2 = newDocumentId(TABLE);
    await store.commitWrite([doc(id2, "no-opts")], []); // no opts at all → meta undefined
    const id3 = newDocumentId(TABLE);
    await store.commitWrite([doc(id3, "empty-meta")], [], undefined, {}); // opts, but no meta

    expect(seenMeta).toEqual([{ idempotencyKey: "req-1" }, undefined, undefined]);
    await client.close();
  });

  // The single-commit path is exactly a one-unit batch (Fleet B4, D1): commitWrite delegates to
  // commitWriteBatch, so the guard's invocation shape is byte-identical whether one or many units
  // commit — always a `readonly CommitGuardUnit[]`. Proven: the guard for a single commitWrite gets
  // an array of length 1 whose sole entry's ts is the returned commit ts.
  it("commitWrite reaches the guard as a one-unit batch (single ≡ one-unit-batch)", async () => {
    const { store, client } = await makeStore();
    const seen: bigint[][] = [];
    store.setCommitGuard(async (_q, units) => {
      seen.push(units.map((u) => u.ts));
    });

    const id = newDocumentId(TABLE);
    const commitTs = await store.commitWrite([doc(id, "x")], [], undefined, { meta: { idempotencyKey: "one" } });

    expect(seen).toEqual([[commitTs]]);
    await client.close();
  });

  // Fleet B4 (batch-shaped guard): a multi-unit commitWriteBatch invokes the guard ONCE with all N
  // units in strictly-increasing ts order, each unit's own staged rows already visible in the txn.
  it("invokes the guard ONCE per batch with all units in ts order (each unit's rows visible)", async () => {
    const { store, client } = await makeStore();
    const seen: { ts: bigint; docCount: number }[][] = [];
    store.setCommitGuard(async (q: PgQuerier, units) => {
      const snapshot: { ts: bigint; docCount: number }[] = [];
      for (const u of units) {
        const rows = await q.query(`SELECT COUNT(*)::int AS n FROM documents WHERE ts = $1`, [u.ts]);
        snapshot.push({ ts: u.ts, docCount: Number(rows[0]!.n) });
      }
      seen.push(snapshot);
    });

    const [a, b, c] = [newDocumentId(TABLE), newDocumentId(TABLE), newDocumentId(TABLE)];
    const tss = await store.commitWriteBatch([
      { documents: [doc(a, "a")], indexUpdates: [] },
      { documents: [doc(b, "b")], indexUpdates: [] },
      { documents: [doc(c, "c")], indexUpdates: [] },
    ]);

    expect(seen).toHaveLength(1); // the guard ran ONCE for the whole batch
    expect(seen[0]!.map((s) => s.ts)).toEqual(tss); // units in the returned ts order
    expect(tss[0]! < tss[1]! && tss[1]! < tss[2]!).toBe(true); // strictly increasing
    expect(seen[0]!.every((s) => s.docCount === 1)).toBe(true); // each unit's own row visible in-txn
    await client.close();
  });

  // Atomicity: a guard that throws on unit 2's meta aborts the WHOLE batch — zero rows land (D1).
  it("a guard throwing on a later unit aborts ALL units — zero rows land", async () => {
    const { store, client } = await makeStore();
    store.setCommitGuard(async (_q, units) => {
      if (units.some((u) => u.meta?.idempotencyKey === "poison")) throw new Error("unit-2 poisoned");
    });

    const [a, b] = [newDocumentId(TABLE), newDocumentId(TABLE)];
    await expect(
      store.commitWriteBatch([
        { documents: [doc(a, "a")], indexUpdates: [] },
        { documents: [doc(b, "b")], indexUpdates: [], meta: { idempotencyKey: "poison" } },
      ]),
    ).rejects.toThrow("unit-2 poisoned");

    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(0); // unit 1 rolled back too
    await client.close();
  });

  // Conformance case (e), raw-row form: commitWrite stamps shard_id='default' on doc + index rows.
  it("stamps shard_id='default' on committed document and index rows", async () => {
    const { store, client } = await makeStore();
    const id = newDocumentId(TABLE);
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    await store.commitWrite([doc(id, "x")], [idx(indexId, encodeIndexKey(["x"]), id)]);

    const drows = await client.query(`SELECT shard_id FROM documents`);
    expect(drows.length).toBeGreaterThan(0);
    expect(drows.every((r) => r.shard_id === "default")).toBe(true);
    const irows = await client.query(`SELECT shard_id FROM indexes`);
    expect(irows.length).toBeGreaterThan(0);
    expect(irows.every((r) => r.shard_id === "default")).toBe(true);
    await client.close();
  });
});

// Receipted Outbox decision 2: the single-slot `commitGuard` generalized to a chain via
// `addCommitGuard(guard): () => void`. `setCommitGuard` (above) is retained only as a deprecated
// alias — see its own describe block below for the clear-then-add semantics that makes it distinct
// from `addCommitGuard`.
describe("PostgresDocStore addCommitGuard (the chain)", () => {
  it("runs guards in REGISTRATION order", async () => {
    const { store, client } = await makeStore();
    const order: string[] = [];
    store.addCommitGuard(async () => {
      order.push("first");
    });
    store.addCommitGuard(async () => {
      order.push("second");
    });
    store.addCommitGuard(async () => {
      order.push("third");
    });

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(order).toEqual(["first", "second", "third"]);
    await client.close();
  });

  it("ANY guard throwing aborts the WHOLE transaction — zero rows land, and later guards never run", async () => {
    const { store, client } = await makeStore();
    const ran: string[] = [];
    store.addCommitGuard(async () => {
      ran.push("first");
    });
    store.addCommitGuard(async () => {
      ran.push("second");
      throw new Error("second rejects");
    });
    store.addCommitGuard(async () => {
      ran.push("third"); // must never run — the chain aborts at "second"
    });

    const id = newDocumentId(TABLE);
    await expect(store.commitWrite([doc(id, "x")], [])).rejects.toThrow("second rejects");
    expect(ran).toEqual(["first", "second"]);

    const docs = await client.query(`SELECT COUNT(*)::int AS n FROM documents`);
    expect(Number(docs[0]!.n)).toBe(0); // nothing landed, including "first"'s prior-ok state
    await client.close();
  });

  it("the returned unregister function removes exactly that guard — a no-op if called again", async () => {
    const { store, client } = await makeStore();
    const order: string[] = [];
    const unregisterA = store.addCommitGuard(async () => {
      order.push("A");
    });
    store.addCommitGuard(async () => {
      order.push("B");
    });

    unregisterA();
    unregisterA(); // second call — a no-op, not a throw

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(order).toEqual(["B"]); // A never ran — only B remains on the chain
    await client.close();
  });

  it("each guard sees the SAME (querier, units, shardId) triple already documented for a single guard", async () => {
    const { store, client } = await makeStore();
    const seenA: bigint[] = [];
    const seenB: bigint[] = [];
    store.addCommitGuard(async (_q, units) => {
      seenA.push(...units.map((u) => u.ts));
    });
    store.addCommitGuard(async (_q, units) => {
      seenB.push(...units.map((u) => u.ts));
    });

    const commitTs = await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(seenA).toEqual([commitTs]);
    expect(seenB).toEqual([commitTs]);
    await client.close();
  });
});

// `setCommitGuard` is a DEPRECATED alias, not a second independent registration mechanism — its
// contract is "clear the whole chain, then add this guard as its sole member". Mixing it with
// `addCommitGuard` on the same store therefore wipes out any other registered guard; these tests
// pin exactly that (surprising, documented) behavior so a future refactor can't silently change it.
describe("PostgresDocStore setCommitGuard (deprecated alias)", () => {
  it("CLEARS the whole chain before adding — an addCommitGuard registration does not survive it", async () => {
    const { store, client } = await makeStore();
    const order: string[] = [];
    store.addCommitGuard(async () => {
      order.push("chain-guard");
    });
    store.setCommitGuard(async () => {
      order.push("alias-guard");
    });

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(order).toEqual(["alias-guard"]); // "chain-guard" was wiped by setCommitGuard
    await client.close();
  });

  it("setCommitGuard(null) clears the chain entirely, including guards added via addCommitGuard", async () => {
    const { store, client } = await makeStore();
    const ran = { value: false };
    store.addCommitGuard(async () => {
      ran.value = true;
    });
    store.setCommitGuard(null);

    await store.commitWrite([doc(newDocumentId(TABLE), "x")], []);
    expect(ran.value).toBe(false);
    await client.close();
  });
});
