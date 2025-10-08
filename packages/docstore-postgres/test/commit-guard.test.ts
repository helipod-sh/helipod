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
  it("invokes the guard with (querier, allocatedTs) after inserts, before COMMIT", async () => {
    const { store, client } = await makeStore();
    const seen: { ts: bigint; docCount: number }[] = [];
    store.setCommitGuard(async (q: PgQuerier, commitTs: bigint) => {
      // The staged rows are visible inside the same transaction the guard runs in.
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

  // Fleet B3, D3: opaque commit metadata threaded through `commitWrite`'s 4th `opts` param to the
  // guard's 4th `meta` param — the "opaque meta channel" the design spec's D3 describes.
  it("threads RunOptions-shaped commitMeta through commitWrite's opts to the guard's 4th param", async () => {
    const { store, client } = await makeStore();
    const seenMeta: (Record<string, string> | undefined)[] = [];
    store.setCommitGuard(async (_q, _commitTs, _shardId, meta) => {
      seenMeta.push(meta);
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

  // Existing 3-arg guard installers (e.g. `ee/packages/fleet/src/node.ts`'s epoch fence, and the
  // 2/3-arg guards above in this file) stay valid unmodified against the new 4-param guard type —
  // TS function-type assignability allows a callback with fewer declared params than the type
  // requires, as long as it never references the extra ones. Proven here directly: a guard that
  // only destructures its first 3 params still installs and runs.
  it("a pre-existing 3-arg guard callback (ignoring the additive 4th `meta` param) still works", async () => {
    const { store, client } = await makeStore();
    const seen: bigint[] = [];
    store.setCommitGuard(async (_q, commitTs, _shardId) => {
      seen.push(commitTs);
    });

    const id = newDocumentId(TABLE);
    const commitTs = await store.commitWrite([doc(id, "x")], [], undefined, { meta: { idempotencyKey: "ignored" } });

    expect(seen).toEqual([commitTs]);
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
