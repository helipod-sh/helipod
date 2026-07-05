import { describe, it, expect } from "vitest";
import { newDocumentId, encodeStorageIndexId, type InternalDocumentId } from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry, IndexWrite } from "@helipod/docstore";
import { NodeSqliteAdapter, SqliteDocStore } from "../src/index";

const TABLE = 20002;

function doc(id: InternalDocumentId, body: string): DocumentLogEntry {
  return { ts: 0n, id, prev_ts: null, value: { id, value: { body } } };
}
function idx(indexId: string, key: Uint8Array, id: InternalDocumentId): IndexWrite {
  return { ts: 0n, update: { indexId, key, value: { type: "NonClustered", docId: id } } };
}

// Conformance case (e), raw-row form: needs storage-specific SQL that the shared suite cannot
// express, so it lives here (and in docstore-postgres/test/commit-guard.test.ts for Postgres).
describe("SqliteDocStore commitWrite shard_id", () => {
  it("stamps shard_id='default' on committed document and index rows", async () => {
    const adapter = new NodeSqliteAdapter(); // in-memory
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();

    const id = newDocumentId(TABLE);
    const indexId = encodeStorageIndexId(TABLE, "by_body");
    await store.commitWrite([doc(id, "x")], [idx(indexId, encodeIndexKey(["x"]), id)]);

    const drows = adapter.prepare(`SELECT shard_id FROM documents`).all();
    expect(drows.length).toBeGreaterThan(0);
    expect(drows.every((r) => r.shard_id === "default")).toBe(true);
    const irows = adapter.prepare(`SELECT shard_id FROM indexes`).all();
    expect(irows.length).toBeGreaterThan(0);
    expect(irows.every((r) => r.shard_id === "default")).toBe(true);

    store.close();
  });

  // Fleet B3, D3 (Receipted Outbox decision 2: SQLite has a commit-guard chain too now, but with
  // no guard REGISTERED — the common case — `opts.meta` still reaches no guard and is a pure
  // pass-through): the opts param exists for interface conformance with `DocStore.commitWrite`;
  // when the guard chain is empty (non-fleet / single-node SQLite, most deployments) it costs
  // nothing. See `commit-guard.test.ts` for the chain itself actually receiving this meta.
  it("accepts commitWrite's 4th `opts` param and is a no-op with no guard registered", async () => {
    const adapter = new NodeSqliteAdapter();
    const store = new SqliteDocStore(adapter);
    await store.setupSchema();

    const id = newDocumentId(TABLE);
    const commitTs = await store.commitWrite([doc(id, "with-meta")], [], undefined, {
      meta: { idempotencyKey: "abc-123" },
    });

    // Same result shape/behavior as a commitWrite with no opts at all.
    expect(commitTs).toBeGreaterThan(0n);
    expect((await store.get(id))!.ts).toBe(commitTs);
    const drows = adapter.prepare(`SELECT shard_id FROM documents WHERE internal_id = ?`).all(id.internalId);
    expect(drows.every((r) => r.shard_id === "default")).toBe(true);

    store.close();
  });
});
