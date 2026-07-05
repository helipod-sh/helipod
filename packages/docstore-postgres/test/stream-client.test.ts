import { describe, it, expect } from "vitest";
import { PgliteClient } from "./pglite-client";
import { PostgresDocStore } from "../src/postgres-docstore";
import { STREAM_BATCH_INITIAL } from "../src/pg-client";
import type { PgRow, PgValue } from "../src/pg-client";
import { newDocumentId, encodeStorageIndexId } from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@helipod/docstore";

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

    // Proof: an early break must fetch far fewer rows than the full 500-row range — at most the
    // FIRST (smallest) adaptive batch, not the whole scan. This metric is only meaningful because
    // `queryStream`'s cursor is non-holdable (lazy): the executor genuinely produces only the rows
    // FETCHed before CLOSE, so `fetchedRows` reflects server compute avoided, not just client-side
    // transfer. A `WITH HOLD` cursor would materialize the ENTIRE 500-row result into a tuplestore
    // at COMMIT time regardless of how few rows get FETCHed — this assertion would still pass
    // (client only transfers `STREAM_BATCH_INITIAL` rows) while the server did all 500 rows of
    // work, making the metric meaningless as a work-avoidance proof.
    expect(spy.fetchedRows).toBeGreaterThan(0);
    expect(spy.fetchedRows).toBeLessThanOrEqual(STREAM_BATCH_INITIAL);
    expect(spy.fetchedRows).toBeLessThan(TOTAL);

    // The store must still be usable after the early break (cursor closed, txn ended).
    const again = await collect(store.index_scan(INDEX_ID, "", 5n, FULL, "asc"));
    expect(again.length).toBe(TOTAL);
  });
});

/**
 * Pins the `streamLock` serialization documented on `PgliteClient.queryStream`: two `index_scan`
 * streams initiated concurrently on ONE store (one shared PGlite connection) must never collide on
 * a cursor name or corrupt each other's transaction — the root cause of a real ryow-runtime
 * regression fixed earlier. Both streams must still complete with the correct, complete, mutually
 * uncontaminated result sets, with no "cursor already exists"/"cursor does not exist"/transaction
 * error thrown.
 */
describe("PostgresDocStore.index_scan concurrent streams (single store, single PGlite connection)", () => {
  const TABLE_A = 20101;
  const TABLE_B = 20102;
  const INDEX_A = encodeStorageIndexId(TABLE_A, "by_key");
  const INDEX_B = encodeStorageIndexId(TABLE_B, "by_key");
  const FULL: Interval = { start: new Uint8Array(), end: null };
  const TOTAL = 200; // large enough to span multiple adaptive FETCH batches

  function seedIndexEntries(
    table: number,
    indexId: string,
  ): { documents: DocumentLogEntry[]; indexUpdates: IndexWrite[] } {
    const documents: DocumentLogEntry[] = [];
    const indexUpdates: IndexWrite[] = [];
    for (let i = 0; i < TOTAL; i++) {
      const id: InternalDocumentId = newDocumentId(table);
      const key = encodeIndexKey([i]);
      documents.push({ ts: 1n, id, prev_ts: null, value: { id, value: { n: i } } });
      indexUpdates.push({ ts: 1n, update: { indexId, key, value: { type: "NonClustered", docId: id } } });
    }
    return { documents, indexUpdates };
  }

  /** Logs the first SQL keyword of every `query()` call on the shared connection, so the test can
   *  assert the two concurrent streams' BEGIN..COMMIT blocks never interleave on the single PGlite
   *  session — i.e. that `streamLock` genuinely serializes them — rather than merely asserting the
   *  end result happens to be correct. `PgliteClient.transaction()` (used by `store.write`) calls
   *  the underlying `this.pg.query` directly, bypassing this override, so only `queryStream`'s own
   *  BEGIN/DECLARE/FETCH/CLOSE/COMMIT calls (which go through `this.query`) are captured. */
  class LoggingPglite extends PgliteClient {
    log: string[] = [];
    override async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
      const trimmed = text.trimStart();
      const tag = trimmed.startsWith("DECLARE")
        ? "DECLARE"
        : trimmed.startsWith("FETCH")
          ? "FETCH"
          : trimmed.startsWith("CLOSE")
            ? "CLOSE"
            : trimmed.split(/\s+/)[0]!;
      this.log.push(tag);
      return super.query(text, params);
    }
  }

  it("two concurrently-initiated index_scan streams on one store both complete correctly, with no cursor collision or transaction corruption", async () => {
    const a = seedIndexEntries(TABLE_A, INDEX_A);
    const b = seedIndexEntries(TABLE_B, INDEX_B);

    const client = new LoggingPglite();
    const store = new PostgresDocStore(client);
    await store.setupSchema();
    await store.write(a.documents, a.indexUpdates, "Error");
    await store.write(b.documents, b.indexUpdates, "Error");

    // Sequential ground truth, computed before the concurrent run so the assertions below don't
    // just compare the two concurrent streams against each other.
    const refA = await drain(store.index_scan(INDEX_A, "", 5n, FULL, "asc"));
    const refB = await drain(store.index_scan(INDEX_B, "", 5n, FULL, "asc"));
    expect(refA.length).toBe(TOTAL);
    expect(refB.length).toBe(TOTAL);
    client.log.length = 0; // reset: only the concurrent run below is under test

    // Concurrent initiation: both generators are created and their drains kicked off together
    // (neither `await`ed before the other starts), so their first `.next()` calls race for
    // `streamLock` and genuinely overlap in initiation order from the caller's perspective — the
    // mutex may still fully serialize the actual DB work underneath; that's the behavior being
    // pinned here, not defeated.
    const genA = store.index_scan(INDEX_A, "", 5n, FULL, "asc");
    const genB = store.index_scan(INDEX_B, "", 5n, FULL, "asc");
    const [resultsA, resultsB] = await Promise.all([drain(genA), drain(genB)]);

    // Correct + complete: both streams got their full, independent result set back.
    expect(resultsA.length).toBe(TOTAL);
    expect(resultsB.length).toBe(TOTAL);
    expect(resultsA.map(([key]) => key)).toEqual(refA.map(([key]) => key));
    expect(resultsB.map(([key]) => key)).toEqual(refB.map(([key]) => key));

    // No cross-contamination: every row A yielded really belongs to TABLE_A, and likewise for B —
    // a corrupted shared cursor/transaction would be the way rows from one stream leak into, or
    // are lost from, the other.
    for (const [, doc] of resultsA) expect(doc.value.id.tableNumber).toBe(TABLE_A);
    for (const [, doc] of resultsB) expect(doc.value.id.tableNumber).toBe(TABLE_B);

    // Serialization proof: the two streams' BEGIN..COMMIT blocks never interleave on the shared
    // PGlite session — one fully completes (BEGIN, DECLARE, FETCH*, CLOSE, COMMIT) before the
    // other's BEGIN, even though both were initiated concurrently above.
    const beginIdx = client.log.reduce<number[]>((acc, tag, i) => (tag === "BEGIN" ? [...acc, i] : acc), []);
    const commitIdx = client.log.reduce<number[]>((acc, tag, i) => (tag === "COMMIT" ? [...acc, i] : acc), []);
    expect(beginIdx.length).toBe(2);
    expect(commitIdx.length).toBe(2);
    expect(beginIdx[1]!).toBeGreaterThan(commitIdx[0]!); // second txn starts only after the first ends
  });
});
