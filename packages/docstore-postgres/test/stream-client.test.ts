import { describe, it, expect } from "vitest";
import { PgliteClient } from "./pglite-client";
import { PostgresDocStore } from "../src/postgres-docstore";
import { STREAM_BATCH } from "../src/pg-client";
import type { PgRow, PgValue } from "../src/pg-client";
import { newDocumentId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@stackbase/docstore";

async function drain<T>(it: AsyncIterable<T>, n?: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) {
    out.push(x);
    if (n !== undefined && out.length >= n) break;
  }
  return out;
}

describe("PgliteClient.queryStream", () => {
  it("streams the same rows as query(), honoring params", async () => {
    const c = new PgliteClient();
    await c.query(`CREATE TABLE t (id BYTEA, n BIGINT)`);
    for (let i = 1; i <= 20; i++) await c.query(`INSERT INTO t VALUES (decode(lpad(to_hex($1::int),4,'0'),'hex'), $1)`, [i]);
    const buffered = await c.query(`SELECT n FROM t WHERE n >= $1 ORDER BY n`, [5]);
    const streamed = await drain(c.queryStream!(`SELECT n FROM t WHERE n >= $1 ORDER BY n`, [5]));
    expect(streamed.map((r) => Number(r.n))).toEqual(buffered.map((r) => Number(r.n)));
    // early break must leave the client usable (cursor closed, txn ended)
    const partial = await drain(c.queryStream!(`SELECT n FROM t ORDER BY n`, []), 3);
    expect(partial.map((r) => Number(r.n))).toEqual([1, 2, 3]);
    const after = await c.query(`SELECT COUNT(*)::int AS c FROM t`);
    expect(after[0]!.c).toBe(20); // client still works after an early-broken stream
    await c.close();
  });

  it("inlineParams handles string params containing digit sequences (no placeholder corruption)", async () => {
    const c = new PgliteClient();
    await c.query(`CREATE TABLE s (a INT, b TEXT)`);
    await c.query(`INSERT INTO s VALUES ($1, $2)`, [42, "1abc"]);
    await c.query(`INSERT INTO s VALUES ($1, $2)`, [7, "123-path"]);
    const buffered = await c.query(`SELECT b FROM s WHERE a = $1 AND b = $2 ORDER BY b`, [42, "1abc"]);
    const streamed: unknown[] = [];
    for await (const r of c.queryStream!(`SELECT b FROM s WHERE a = $1 AND b = $2 ORDER BY b`, [42, "1abc"])) {
      streamed.push(r);
    }
    expect((streamed as { b: string }[]).map((r) => r.b)).toEqual((buffered as { b: string }[]).map((r) => r.b));
    expect((streamed as { b: string }[]).map((r) => r.b)).toEqual(["1abc"]);
    await c.close();
  });
});

/** Counts rows returned by `FETCH ...` cursor round trips — proves how much a consumer's early
 *  `break` actually stopped `queryStream` from pulling out of the cursor, as opposed to just
 *  stopping the caller from CONSUMING an already-fully-buffered result. */
class SpyPglite extends PgliteClient {
  fetchedRows = 0;
  override async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const rows = await super.query(text, params);
    if (text.trimStart().startsWith("FETCH")) this.fetchedRows += rows.length;
    return rows;
  }
}

describe("PostgresDocStore.index_scan streaming", () => {
  const TABLE = 20001;
  const INDEX_ID = encodeStorageIndexId(TABLE, "by_key");
  const FULL: Interval = { start: new Uint8Array(), end: null };
  const TOTAL = 500;

  function seedIndexEntries(): { documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] } {
    const documents: DocumentLogEntry[] = [];
    const indexUpdates: IndexWrite[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const id: InternalDocumentId = newDocumentId(TABLE);
      const key = encodeIndexKey([i]);
      documents.push({ ts: 1n, id, prev_ts: null, value: { id, value: { n: i } } });
      indexUpdates.push({ ts: 1n, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } });
    }
    return { documents, indexUpdates };
  }

  async function collect<T>(g: AsyncGenerator<T>, n?: number): Promise<T[]> {
    const out: T[] = [];
    for await (const x of g) {
      out.push(x);
      if (n !== undefined && out.length >= n) break;
    }
    return out;
  }

  it("streams via a cursor and stops fetching on an early break, matching the buffered result", async () => {
    const { documents, indexUpdates } = seedIndexEntries();

    // Reference: a full buffered scan on a plain (non-streaming-instrumented) store.
    const refStore = new PostgresDocStore(new PgliteClient());
    await refStore.setupSchema();
    await refStore.write(documents, indexUpdates, "Error");
    const full = await collect(refStore.index_scan(INDEX_ID, "", 5n, FULL, "asc"));
    expect(full.length).toBe(TOTAL);

    // Subject: the spy-instrumented store, broken after 3 rows.
    const spy = new SpyPglite();
    const store = new PostgresDocStore(spy);
    await store.setupSchema();
    await store.write(documents, indexUpdates, "Error");

    const partial = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc"), 3);
    expect(partial.map(([key]) => key)).toEqual(full.slice(0, 3).map(([key]) => key));

    // Proof: an early break must fetch far fewer rows than the full 500-row range — at most one
    // cursor batch, not the whole scan.
    expect(spy.fetchedRows).toBeGreaterThan(0);
    expect(spy.fetchedRows).toBeLessThanOrEqual(STREAM_BATCH);
    expect(spy.fetchedRows).toBeLessThan(TOTAL);

    // The store must still be usable after the early break (cursor closed, txn ended).
    const again = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc"));
    expect(again.length).toBe(TOTAL);
  });
});
