# Streaming `index_scan` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Make `PostgresDocStore.index_scan` stream rows via a cursor and stop fetching when the consumer breaks early, so paginated/limited reads over large index ranges no longer materialize the whole range — behind the seam, no engine change, results identical.

**Architecture:** Add an optional `queryStream?` to the `PgQuerier` seam. `index_scan` uses it when present (buffered `query` fallback otherwise). `NodePgClient` implements it via `pg-cursor` (production, bound params); `PgliteClient` via `DECLARE/FETCH` with typed-literal param inlining (test/bench substrate). Early `break` unwinds the async generator → closes the cursor. The reactive read-set is unchanged (it already tracks loop consumption).

**Tech Stack:** TypeScript, `pg` + `pg-cursor`, PGlite (`@electric-sql/pglite`) for tests/bench, vitest.

## Global Constraints

- All changes inside `packages/docstore-postgres`; no engine change; `DocStore.index_scan` signature + results identical.
- Streaming and buffered paths MUST produce identical results (shared SQL-build + row-map helpers; conformance proves it).
- Early `break` / error MUST close the cursor and release its connection (no leak).
- Reactivity untouched: read-set records loop consumption, which streaming does not change.
- `queryStream` is OPTIONAL — a client without it falls back to buffered `query` (backward compatible).
- Scope is `index_scan` ONLY. Do NOT touch `scan`/`get`/`count`/`load_documents`/`previous_revisions`/`dumpCurrentState`.
- tsconfig has `noUncheckedIndexedAccess` → use `rows[i]!` non-null assertions.
- Tests run under Node/vitest on PGlite; `embedded-postgres` CANNOT boot here (libicudata) so real-PG (`NodePgClient`) streaming is unvalidated in-env — implement carefully to the `pg-cursor` contract and flag for a later real-PG smoke.
- `STREAM_BATCH = 100`.

---

### Task 1: Seam method + extract index_scan helpers (refactor, no behavior change)

**Files:** `packages/docstore-postgres/src/pg-client.ts`, `src/postgres-docstore.ts`; test `test/index-scan.test.ts` (existing, must stay green).

**Interfaces produced:** `PgQuerier.queryStream?(sql, params?): AsyncIterable<PgRow>`; exported `STREAM_BATCH = 100`; private `buildIndexScanSql(indexId, tableId, readTimestamp, interval, order, limit?): {sql, params}` and `mapIndexRow(row): readonly [Uint8Array, LatestDocument]` on `PostgresDocStore`.

- [ ] **Step 1: Add the optional seam method + const.** In `pg-client.ts`, add to the `PgQuerier` interface:
```ts
  /** Optional streaming query — yields rows lazily from a server-side cursor. Closing the returned
   *  iterator early (consumer break) MUST stop fetching and release the cursor/connection. A client
   *  that omits this simply doesn't stream; callers fall back to buffered `query`. */
  queryStream?(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow>;
```
and export `export const STREAM_BATCH = 100;`
- [ ] **Step 2: Extract helpers in `index_scan`** without changing behavior — move the SQL-string+params construction into `private buildIndexScanSql(...)` and the row→`[key, LatestDocument]` mapping into `private mapIndexRow(row: PgRow)`, then have `index_scan` call `const {sql, params} = this.buildIndexScanSql(...); const rows = await this.db.query(sql, params); for (const row of rows) yield this.mapIndexRow(row);`
- [ ] **Step 3: Run existing index_scan + conformance to prove the refactor is inert.** Run: `cd packages/docstore-postgres && bunx vitest run test/index-scan.test.ts test/docstore.test.ts`. Expected: all green (same as baseline 50/50 + index-scan suite).
- [ ] **Step 4: Commit.** `git commit -am "refactor(pg): extract index_scan SQL/row helpers + add optional queryStream seam"`

---

### Task 2: `PgliteClient.queryStream` (cursor + typed-literal param inlining)

**Files:** `packages/docstore-postgres/test/pglite-client.ts`; test `test/projection-stream.test.ts` (create — note: name is generic "stream", it tests the pglite client streaming).

**Interfaces produced:** `PgliteClient.queryStream` yielding the same rows as `query` for the same SQL; a private `inlineParams(sql, params)` encoding `$n` as typed SQL literals.

- [ ] **Step 1: Write the failing test** (create `test/stream-client.test.ts`):
```ts
import { describe, it, expect } from "vitest";
import { PgliteClient } from "./pglite-client";

async function drain<T>(it: AsyncIterable<T>, n?: number): Promise<T[]> {
  const out: T[] = []; for await (const x of it) { out.push(x); if (n !== undefined && out.length >= n) break; } return out;
}

describe("PgliteClient.queryStream", () => {
  it("streams the same rows as query(), honoring params", async () => {
    const c = new PgliteClient();
    await c.query(`CREATE TABLE t (id BYTEA, n BIGINT)`);
    for (let i = 1; i <= 20; i++) await c.query(`INSERT INTO t VALUES (decode(lpad(to_hex($1),4,'0'),'hex'), $1)`, [i]);
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
});
```
- [ ] **Step 2: Run it, expect fail** (`queryStream` undefined). Run: `cd packages/docstore-postgres && bunx vitest run test/stream-client.test.ts`
- [ ] **Step 3: Implement `queryStream` + `inlineParams`** on `PgliteClient`:
```ts
async *queryStream(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow> {
  await this.query("BEGIN");
  try {
    await this.query(`DECLARE sbc NO SCROLL CURSOR FOR ${inlineParams(sql, params ?? [])}`);
    for (;;) {
      const rows = await this.query(`FETCH ${STREAM_BATCH} FROM sbc`);
      if (rows.length === 0) break;
      for (const r of rows) yield r;
    }
  } finally {
    await this.query("CLOSE sbc").catch(() => {});
    await this.query("COMMIT").catch(() => {});
  }
}
```
`inlineParams` replaces each `$k` with a typed literal: `Uint8Array`/Buffer → `'\\x<hex>'::bytea`; `bigint`/`number` → the decimal literal; `boolean` → `TRUE`/`FALSE`; `null`/`undefined` → `NULL`; `string` → `$$` + value + `$$` (dollar-quoted; throw if the value contains `$$`); anything else → throw `Error("inlineParams: unsupported param type")`. Replace by scanning for `$1..$9`/`$10..` longest-match-first so `$1` doesn't partial-match `$10`.
- [ ] **Step 4: Run test, expect pass.** Run: `cd packages/docstore-postgres && bunx vitest run test/stream-client.test.ts`
- [ ] **Step 5: Commit.** `git commit -am "feat(pg): PgliteClient.queryStream via DECLARE/FETCH + typed-literal param inlining"`

---

### Task 3: Stream `index_scan` when `queryStream` is available + prove fewer rows fetched

**Files:** `src/postgres-docstore.ts`; test `test/stream-client.test.ts` (extend) or `test/index-scan.test.ts`.

**Interfaces produced:** `index_scan` yields via `queryStream` when present; identical results to buffered.

- [ ] **Step 1: Write the failing test** — assert that with a spy PGlite client counting FETCHed rows, an `index_scan` consumer that breaks after 3 rows fetches far fewer than the full range, and that results equal the buffered path. Add to `test/stream-client.test.ts`:
```ts
// Seed via the store, open index_scan, break after 3, assert rows-fetched << total.
// (Use a SpyPglite subclass counting rows returned by `FETCH` queries.)
```
Write a concrete `SpyPglite extends PgliteClient` overriding `query` to sum `rowCount` of `FETCH` results; seed ~500 index entries via `PostgresDocStore.write`; consume 3 from `index_scan` then break; assert the spy's fetched-count ≤ `STREAM_BATCH * 1` and the 3 keys equal the first 3 of a full buffered `index_scan`.
- [ ] **Step 2: Run it, expect fail** (index_scan still buffered → fetches all).
- [ ] **Step 3: Implement** — change `index_scan` to:
```ts
const { sql, params } = this.buildIndexScanSql(indexId, tableId, readTimestamp, interval, order, limit);
if (this.db.queryStream) { for await (const row of this.db.queryStream(sql, params)) yield this.mapIndexRow(row); return; }
const rows = await this.db.query(sql, params);
for (const row of rows) yield this.mapIndexRow(row);
```
- [ ] **Step 4: Run test + full conformance, expect pass + no regression.** Run: `cd packages/docstore-postgres && bunx vitest run test/stream-client.test.ts test/docstore.test.ts test/index-scan.test.ts`
- [ ] **Step 5: Commit.** `git commit -am "feat(pg): index_scan streams via queryStream, stops fetching on early break"`

---

### Task 4: `NodePgClient.queryStream` via `pg-cursor` + connection lifecycle

**Files:** `src/node-pg-client.ts`; `package.json` (pg-cursor dep already added).

**Interfaces produced:** `NodePgClient.queryStream` streaming via a pinned read connection, closed on early break/error.

- [ ] **Step 1: Inspect the connection model.** Read `node-pg-client.ts` and determine how reads get a connection (pool vs single pinned writer). A cursor MUST hold one connection for its lifetime and MUST NOT be the writer connection mid-transaction. Document the chosen approach in the commit message.
- [ ] **Step 2: Implement `queryStream`** using `pg-cursor`:
```ts
import Cursor from "pg-cursor";
async *queryStream(sql: string, params?: readonly PgValue[]): AsyncIterable<PgRow> {
  const conn = await this.acquireReadConnection();
  const cursor = conn.query(new Cursor(sql, (params as unknown[]) ?? []));
  try {
    for (;;) {
      const rows: PgRow[] = await cursor.read(STREAM_BATCH);
      if (rows.length === 0) break;
      for (const r of rows) yield r;
    }
  } finally {
    await cursor.close().catch(() => {});
    this.releaseReadConnection(conn);
  }
}
```
Wire `acquireReadConnection`/`releaseReadConnection` to the existing pool (or a dedicated read pool) — reuse the current read path's connection source; do not create a second driver.
- [ ] **Step 3: Typecheck + build.** Run: `cd packages/docstore-postgres && bunx tsc --noEmit && bunx tsup`. (Real-PG behavior is unvalidatable here — embedded-PG can't boot; correctness rides on the shared conformance via PGlite + the `pg-cursor` contract. State this in the commit + report.)
- [ ] **Step 4: Commit.** `git commit -am "feat(pg): NodePgClient.queryStream via pg-cursor + read-connection lifecycle (real-PG smoke TODO)"`

---

### Task 5: Conformance with streaming active + early-break/leak case

**Files:** `test/docstore.test.ts`.

- [ ] **Step 1: Add a streaming conformance run.** The existing `runDocStoreConformance("postgres (pglite)", …)` uses a `PgliteClient` — which now HAS `queryStream`, so `index_scan` already streams in that run. Confirm by reading the code; if the store only streams when `this.db.queryStream` is truthy and `PgliteClient` now defines it, the existing PGlite conformance run ALREADY exercises streaming. Add an explicit assertion-comment and a **buffered-path** conformance run using a `PgliteClient` subclass with `queryStream` deleted/undefined, to keep the fallback covered:
```ts
class BufferedPglite extends PgliteClient { queryStream = undefined as any; }
runDocStoreConformance("postgres (pglite, buffered index_scan)", async () => { const s = new PostgresDocStore(new BufferedPglite()); await s.setupSchema(); return s; }, async (s) => (s as PostgresDocStore).close());
```
- [ ] **Step 2: Add the early-break/no-leak case** to `test/stream-client.test.ts` (or docstore test): consume 2 rows of a large `index_scan`, break, then run another `index_scan`/`get` on the same store and assert it succeeds (cursor+txn cleaned up).
- [ ] **Step 3: Run both conformance runs + the leak case.** Run: `cd packages/docstore-postgres && bunx vitest run test/docstore.test.ts test/stream-client.test.ts`. Both `postgres (pglite)` (streaming) and `postgres (pglite, buffered index_scan)` must pass.
- [ ] **Step 4: Commit.** `git commit -am "test(pg): conformance covers streaming AND buffered index_scan + early-break leak guard"`

---

### Task 6: Benchmark — buffered vs streaming (rows-fetched + wall-clock)

**Files:** `packages/docstore-postgres/bench/index-scan-stream-bench.ts`; root `package.json` script `bench:pgstream`.

- [ ] **Step 1: Write the benchmark.** PGlite substrate. Seed N live docs + index entries (chunk writes ≤4000/call — PG bind-param ceiling is 32767, docs=6/idx=7 params per row). For N=1 000 and N=100 000, measure `index_scan` consumed with an early `break` at pageSize=50 (matching `paginate()`), buffered client vs streaming client:
  - **Primary:** rows fetched from the DB (instrument a counting client subclass). Buffered ≈ N; streaming ≈ `STREAM_BATCH` (~100). Report the ratio.
  - **Secondary:** wall-clock p50/p95 (~200 reps).
  Also measure a **full-drain** `index_scan` (no break) buffered vs streaming to confirm no regression when everything is consumed.
- [ ] **Step 2: Add root script** `"bench:pgstream": "bun packages/docstore-postgres/bench/index-scan-stream-bench.ts"`.
- [ ] **Step 3: Run it** (`bun run bench:pgstream` from worktree root) and capture the table.
- [ ] **Step 4: Evaluate the gate.** Streaming must fetch drastically fewer rows for the paginated shape, wall-clock beats buffered past −3% at N=100k, and full-drain shows no regression (±3%). Report honestly; if PGlite's in-process wall-clock doesn't move much, the rows-fetched proof is the headline (note the round-trip savings land harder on a networked PG). If streaming does NOT reduce rows fetched, that's a real bug — investigate, don't ship.
- [ ] **Step 5: Commit.** `git commit -am "bench(pg): buffered-vs-streaming index_scan A/B (rows-fetched + wall-clock)"`

---

## Self-Review

- **Spec coverage:** §3 seam → T1; §5 NodePgClient → T4; §6 PgliteClient → T2; §4 index_scan rewrite → T1(helpers)+T3(stream); §7 conformance → T5; §8 benchmark → T6. ✅
- **Placeholders:** none — each code step shows the code; T4's real-PG-unvalidatable gap is explicit, not a placeholder.
- **Type consistency:** `queryStream`, `STREAM_BATCH`, `buildIndexScanSql`, `mapIndexRow`, `inlineParams` used identically across tasks.
