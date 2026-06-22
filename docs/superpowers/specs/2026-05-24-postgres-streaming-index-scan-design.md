# Streaming `index_scan` for the Postgres adapter — design

- **Date:** 2026-05-24
- **Status:** Design — awaiting review before an implementation plan
- **Package:** `@stackbase/docstore-postgres` (seam + two client adapters)
- **Type:** Performance optimization, fully behind the `DocStore`/`PgClient` seam

## 1. Motivation & validated hypothesis

`PostgresDocStore.index_scan` currently does `const rows = await this.db.query(sql); for (row of rows) yield` — it **materializes the entire matching range** before yielding the first row. But the query-engine consumers break early:

- `collect()` (`query-runtime.ts:135`) breaks the `for await` when `query.limit` is reached.
- `paginate()` (`query-runtime.ts:211`) breaks at `pageSize` / `maxScan`.

So a paginated query that wants 50 rows over a 50 000-row index still pays to fetch and resolve all 50 000.

**A streaming probe (2026-05-24, `EXPLAIN ANALYZE` on real PG via PGlite) confirmed the plans are non-blocking:** `index_scan` compiles to a `Nested Loop` with a per-row `LATERAL`, fed by `Unique` over an **Incremental Sort** (the index presorts the leading key). Both operators emit rows incrementally. The 128ms/50k cost is dominated by 50 000 per-row LATERAL lookups (150k buffer hits) — paid *as rows are pulled*, so a 50-row page costs ~50 lookups (<1ms). A cursor that stops after the caller's early `break` avoids the rest.

**This is reactivity-safe by construction:** the read-set already records `consumedRange(lastScanned)` — what the loop *consumed*, not what was *fetched* (`query-runtime.ts` collect/paginate). Streaming changes only the fetch; the recorded read-set (and therefore invalidation) is identical.

**Where it helps:** bounded/paginated reads over large index ranges (`paginate()`, `.take(N)`, `.first()`, filtered scans whose matches appear early). **Where it won't:** an unbounded `.collect()` that drains every row (both paths read everything anyway — no regression, no gain).

## 2. Scope & non-goals

- **In scope:** `index_scan` only — it is the `AsyncGenerator` the paginated consumers drive with an early `break`.
- **Not `scan`:** `scan(tableId)` returns `LatestDocument[]` (a fully-materialized array by contract) — no early-break is possible, so streaming cannot help it. Unchanged.
- **Not** `get`/`count`/`load_documents`/`previous_revisions`/`dumpCurrentState` — untouched.
- **Not** the shelved current-state projection — orthogonal, different branch.
- **No engine changes.** The query-engine consumers already break early; we only make the adapter honor that.
- **No seam-contract change visible to the engine** — same `DocStore.index_scan` signature and results.

## 3. Seam change: an optional streaming query

Add an **optional** method to the `PgQuerier` interface (the query/transaction seam in `pg-client.ts`):

```ts
queryStream?(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow>;
```

Optional so it is **backward-compatible**: a client that doesn't implement it (or a future driver) simply doesn't stream, and the docstore falls back to buffered `query`. Closing the returned async iterator early (the consumer's `break` → the generator's `.return()`) MUST stop fetching and release the cursor/connection.

Batch size for cursor reads: `STREAM_BATCH = 100` rows/round-trip (balances round-trips against over-fetch past the caller's break; a 50-row page needs one batch).

## 4. `index_scan` rewrite

```ts
async *index_scan(...) {
  const { sql, params } = this.buildIndexScanSql(...);   // unchanged SQL
  if (this.db.queryStream) {
    for await (const row of this.db.queryStream(sql, params)) yield this.mapIndexRow(row);
    return;
  }
  const rows = await this.db.query(sql, params);          // buffered fallback (today's behavior)
  for (const row of rows) yield this.mapIndexRow(row);
}
```

The row-mapping and SQL-building are extracted to helpers so the streaming and buffered paths can never diverge. When the consumer breaks the outer generator, JS invokes this generator's `.return()`, which unwinds the `for await` and calls the inner iterator's `.return()` → the client closes its cursor.

## 5. `NodePgClient.queryStream` (production path)

Use `pg-cursor` (added dep). A cursor needs a **single pinned connection** for its lifetime:

```ts
async *queryStream(sql, params) {
  const conn = await this.acquireReadConnection();   // dedicated client/pool checkout
  const cursor = conn.query(new Cursor(sql, params as any[]));
  try {
    for (;;) {
      const rows = await cursor.read(STREAM_BATCH);
      if (rows.length === 0) break;
      for (const r of rows) yield r as PgRow;
    }
  } finally {
    await cursor.close().catch(() => {});
    this.releaseReadConnection(conn);
  }
}
```

**Connection-lifecycle requirement (implementation note):** reads today run on `this.db.query` (pooled/pinned). The cursor must hold one connection start→close; the `finally` releases it even on early `break` or error. Verify against `node-pg-client.ts`'s current connection model (pool vs single pinned) and use the same pool; do not contend with the writer connection.

## 6. `PgliteClient.queryStream` (test + benchmark substrate)

PGlite supports `DECLARE ... CURSOR` / `FETCH` (verified). PGlite is single-connection and in-process, so wrap the cursor in a transaction:

```ts
async *queryStream(sql, params) {
  await this.query("BEGIN");
  try {
    await this.query(`DECLARE sbc NO SCROLL CURSOR FOR ${inlineParams(sql, params)}`);
    for (;;) {
      const { rows } = await this.query(`FETCH ${STREAM_BATCH} FROM sbc`);
      if (rows.length === 0) break;
      for (const r of rows) yield r as PgRow;
    }
  } finally {
    await this.query("CLOSE sbc").catch(() => {});
    await this.query("COMMIT").catch(() => {});
  }
}
```

**Param-binding wrinkle (implementation note):** `DECLARE ... CURSOR FOR <sql>` cannot bind `$n` params via the simple protocol. For the PGlite adapter only, `inlineParams` encodes the engine-generated params as typed SQL literals — `bytea → '\xHEX'::bytea`, `bigint/number → literal`, `text → $$-quoted$$`, `null → NULL`, `boolean → TRUE/FALSE`. This is acceptable because (a) params are engine-generated, never user strings, and (b) this is the test/bench substrate; the production `NodePgClient` binds params properly via `pg-cursor`. The conformance suite (below) proves the inlined PGlite path returns identical results to the buffered path. Guard the encoder to throw on any unexpected param type rather than silently mis-encoding.

## 7. Conformance (correctness gate)

Run the full docstore conformance suite against a projection-**streaming** PGlite store — i.e. a `PgliteClient` whose `queryStream` is active — so `index_scan` is exercised through the streaming path across every behavior (pagination, ranges, tombstones, ordering asc/desc, limits, historical `readTimestamp`). Add explicit cases:

- **Early-break closes the cursor:** consume 3 of many rows from `index_scan`, `break`, and assert no error / connection leak (a follow-up read on the same store still works).
- **Streaming == buffered equivalence:** the existing conformance already asserts result equality; the streaming factory makes it cover the cursor path.
- **Fallback:** a client stub without `queryStream` still yields correct results (buffered path).

## 8. Benchmark (the win, honestly measured)

Extend the bench harness (co-located in the package, PGlite substrate — the projection precedent). Measure `index_scan` at N=1 000 / 100 000, **buffered vs streaming**, at the **production call shape (no SQL LIMIT — early `break` in JS)**:

- **Primary metric — rows actually fetched from the DB** (instrument the client): buffered = N; streaming = ~`pageSize`+batch. This is the work-avoided, substrate-independent proof.
- **Secondary — wall-clock p50/p95** for: fetch-first-page-then-break (pageSize=50), and a filtered scan whose matches are early. Ratios only.
- **Gate:** streaming fetches drastically fewer rows for the paginated shape AND wall-clock beats buffered past −3% at N=100k; a full-drain `.collect()` shows no regression (within ±3%). Report honestly; if wall-clock doesn't move on PGlite's in-process substrate, the rows-fetched proof still stands and is the headline (with a note that the round-trip savings land harder on a networked PG, which we can't boot here).

## 9. Backward compatibility

`queryStream` is optional; buffered `query` remains. `scan`/`get`/etc. unchanged. A deployment sees identical results — only fewer rows fetched for paginated `index_scan`. No schema, no migration, no engine change.

## 10. Files touched

- `packages/docstore-postgres/src/pg-client.ts` — add optional `queryStream?` to `PgQuerier`; export `STREAM_BATCH`.
- `packages/docstore-postgres/src/node-pg-client.ts` — `queryStream` via `pg-cursor` + read-connection lifecycle.
- `packages/docstore-postgres/test/pglite-client.ts` — `queryStream` via `DECLARE/FETCH` + `inlineParams`.
- `packages/docstore-postgres/src/postgres-docstore.ts` — `index_scan` streams when available; extract `buildIndexScanSql`/`mapIndexRow` helpers.
- `packages/docstore-postgres/package.json` — `pg-cursor` dependency.
- `packages/docstore-postgres/test/docstore.test.ts` — streaming-active conformance run + early-break/leak case.
- `packages/docstore-postgres/bench/index-scan-stream-bench.ts` — buffered-vs-streaming A/B (rows-fetched + wall-clock).
