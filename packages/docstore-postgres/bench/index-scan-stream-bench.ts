/**
 * `bun run bench:pgstream` — buffered vs streaming `index_scan` A/B, on PGlite (embedded-postgres
 * can't boot in this sandbox; see `test-support/embedded-pg.ts`'s availability gate).
 *
 * `PostgresDocStore.index_scan` streams via `db.queryStream` when the client provides one
 * (`PgliteClient` does — a non-holdable `DECLARE ... CURSOR` + an ADAPTIVE `FETCH` loop that
 * starts at `STREAM_BATCH_INITIAL` rows and doubles each round trip up to `STREAM_BATCH_MAX`, see
 * `test/pglite-client.ts`'s doc comment), else falls back to one buffered `db.query()` call that
 * returns the WHOLE matched range. `paginate()` (`packages/query-engine/src/query-runtime.ts`)
 * calls `index_scan` with NO SQL `LIMIT` and instead `break`s its consuming loop once it has
 * `pageSize` live rows — so on the buffered path, that early break happens AFTER the full range
 * was already computed and shipped into one JS array; on the streaming path, a non-holdable
 * cursor genuinely stops server-side computation at the FETCH boundary the caller stopped
 * consuming at. This bench reproduces exactly that shape (index_scan with no limit, JS-side break
 * at pageSize=50) and measures both (a) rows actually fetched from the DB, and (b) wall-clock.
 *
 * HONESTY NOTE (read before trusting the wall-clock numbers): PGlite is a single IN-PROCESS WASM
 * connection — there is no network hop, so any wall-clock delta here reflects compute/serialization
 * avoided, NOT round-trip latency avoided. The production `NodePgClient` path (real `pg` driver
 * against real Postgres) opens a FRESH connection per `index_scan` today (no pool yet) — its real
 * network-latency profile (TCP+TLS handshake cost vs. streaming's round-trip savings) is UNMEASURED
 * by this bench and this bench must not be read as a claim about it.
 *
 * Two clients, same seed, same reads — only the streaming flag differs:
 *   - `CountingPglite`  — a plain `PgliteClient` subclass that also sums rows returned by every
 *     `SELECT`/`FETCH` round trip (the "rows fetched from the DB" metric). Used as-is for the
 *     STREAMING cell (its inherited `queryStream` stays intact).
 *   - `BufferedClient`  — wraps a `CountingPglite` by composition and deliberately does NOT expose
 *     `queryStream`, so `PostgresDocStore.index_scan`'s `this.db.queryStream` check is false and it
 *     falls back to the buffered `query()` path. Used for the BUFFERED cell.
 *
 * Seeding is chunked at <=4000 rows/`write()` call — the PG bind-param ceiling is 32767 and each
 * `write()` issues one INSERT for the batch's documents (6 params/row) and one for its index
 * entries (7 params/row); 4000*7 = 28000 stays comfortably under the ceiling.
 */
import { performance } from "node:perf_hooks";
import { PostgresDocStore } from "../src/postgres-docstore";
import type { PgClient, PgQuerier, PgRow, PgValue } from "../src/pg-client";
import { PgliteClient } from "../test/pglite-client";
import { newDocumentId, encodeStorageIndexId } from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@helipod/docstore";

// ── Instrumented clients ──────────────────────────────────────────────────────────────────────

/** Counts rows returned by every data-returning round trip (`SELECT ...` for the buffered path,
 *  `FETCH ...` for the streaming path's cursor). Mirrors `test/stream-client.test.ts`'s `SpyPglite`,
 *  widened to also cover the buffered SELECT so one class serves both cells. */
class CountingPglite extends PgliteClient {
  rowsFetched = 0;
  override async query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    const rows = await super.query(text, params);
    if (/^\s*(SELECT|FETCH)\b/i.test(text)) this.rowsFetched += rows.length;
    return rows;
  }
  resetCount(): void {
    this.rowsFetched = 0;
  }
}

/** Forces the buffered path: implements the minimal required `PgClient` surface by delegating to an
 *  inner `CountingPglite`, but deliberately omits `queryStream` (an optional interface member) so
 *  `PostgresDocStore.index_scan`'s `this.db.queryStream` check is falsy. */
class BufferedClient implements PgClient {
  private readonly inner = new CountingPglite();
  get rowsFetched(): number {
    return this.inner.rowsFetched;
  }
  resetCount(): void {
    this.inner.resetCount();
  }
  query(text: string, params?: readonly PgValue[]): Promise<PgRow[]> {
    return this.inner.query(text, params);
  }
  transaction<T>(fn: (tx: PgQuerier) => Promise<T>): Promise<T> {
    return this.inner.transaction(fn);
  }
  acquireWriterLock(): Promise<void> {
    return this.inner.acquireWriterLock();
  }
  tryAcquireWriterLock(): Promise<boolean> {
    return this.inner.tryAcquireWriterLock();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  // No `queryStream` — that omission IS the point of this class.
}

// ── Fixture ────────────────────────────────────────────────────────────────────────────────────

const TABLE = 90001;
const INDEX_ID = encodeStorageIndexId(TABLE, "by_key");
const FULL: Interval = { start: new Uint8Array(), end: null };
const READ_TS = 5n;
const PAGE_SIZE = 50; // matches `paginate()`'s default page shape

/** Chunked seeding: <=4000 rows/`write()` call (params/row: docs=6, indexes=7; 4000*7=28000 « 32767). */
async function seed(store: PostgresDocStore, n: number): Promise<void> {
  const CHUNK = 4000;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(start + CHUNK, n);
    const documents: DocumentLogEntry[] = [];
    const indexUpdates: IndexWrite[] = [];
    for (let i = start; i < end; i++) {
      const id: InternalDocumentId = newDocumentId(TABLE);
      const key = encodeIndexKey([i]);
      documents.push({ ts: 1n, id, prev_ts: null, value: { id, value: { n: i } } });
      indexUpdates.push({ ts: 1n, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } });
    }
    await store.write(documents, indexUpdates, "Error");
  }
}

async function collectBreak<T>(gen: AsyncGenerator<T>, n: number): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) {
    out.push(x);
    if (out.length >= n) break;
  }
  return out;
}

async function collectAll<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

function percentile(sortedMs: readonly number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx]!;
}

interface Timing {
  p50: number;
  p95: number;
  meanMs: number;
}

async function timeReps(reps: number, fn: () => Promise<unknown>): Promise<Timing> {
  const times: number[] = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const meanMs = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), meanMs };
}

/** ~200 reps is cheap when the op is bounded (streaming: one cursor batch; buffered at N=1,000: one
 *  small query). At N=100,000 the BUFFERED cell's "paginated" op still fetches and hydrates the
 *  FULL 100k-row range every single rep (that cost IS the metric) — 200 reps of that would dominate
 *  this bench's own runtime for no extra statistical value, so the large-N paginated wall-clock rep
 *  count is reduced to keep the bench tractable; p50/p95 over 40 reps is still a stable read. */
function paginatedRepsFor(n: number): number {
  return n <= 1_000 ? 200 : 40;
}

/** Full-drain reps: this touches the whole N-row range on BOTH cells every rep, so it's kept small
 *  regardless of N — it exists to check for regression (±3%), not to characterize a distribution. */
function fullDrainRepsFor(n: number): number {
  return n <= 1_000 ? 20 : 5;
}

interface NResult {
  n: number;
  rowsFetchedBufferedPaginated: number;
  rowsFetchedStreamingPaginated: number;
  wallBufferedPaginated: Timing;
  wallStreamingPaginated: Timing;
  rowsFetchedBufferedFull: number;
  rowsFetchedStreamingFull: number;
  wallBufferedFullMs: number;
  wallStreamingFullMs: number;
  fullDrainCountBuffered: number;
  fullDrainCountStreaming: number;
}

function pctDelta(streaming: number, buffered: number): number {
  return buffered === 0 ? 0 : (100 * (streaming - buffered)) / buffered;
}

async function runForN(n: number): Promise<NResult> {
  // Two independent stores/clients, same seed, only the streaming flag differs.
  const streamingClient = new CountingPglite();
  const streamingStore = new PostgresDocStore(streamingClient);
  await streamingStore.setupSchema();
  await seed(streamingStore, n);

  const bufferedClient = new BufferedClient();
  const bufferedStore = new PostgresDocStore(bufferedClient);
  await bufferedStore.setupSchema();
  await seed(bufferedStore, n);

  // --- Primary: rows fetched from the DB, paginated shape (index_scan, JS-side break at 50) ---
  streamingClient.resetCount();
  const streamingPage = await collectBreak(streamingStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"), PAGE_SIZE);
  const rowsFetchedStreamingPaginated = streamingClient.rowsFetched;

  bufferedClient.resetCount();
  const bufferedPage = await collectBreak(bufferedStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"), PAGE_SIZE);
  const rowsFetchedBufferedPaginated = bufferedClient.rowsFetched;

  if (streamingPage.length !== PAGE_SIZE || bufferedPage.length !== PAGE_SIZE) {
    throw new Error(`expected ${PAGE_SIZE} rows from the paginated break, got streaming=${streamingPage.length} buffered=${bufferedPage.length}`);
  }
  if (streamingPage.map(([k]) => Buffer.from(k).toString("hex")).join(",") !== bufferedPage.map(([k]) => Buffer.from(k).toString("hex")).join(",")) {
    throw new Error("streaming and buffered paginated results diverge — correctness bug, not a benchmark artifact");
  }

  // --- Secondary: wall-clock p50/p95 for the same paginated shape ---
  const paginatedReps = paginatedRepsFor(n);
  const wallStreamingPaginated = await timeReps(paginatedReps, () =>
    collectBreak(streamingStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"), PAGE_SIZE),
  );
  const wallBufferedPaginated = await timeReps(paginatedReps, () =>
    collectBreak(bufferedStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"), PAGE_SIZE),
  );

  // --- Full-drain control: no break, confirm no regression when everything is consumed ---
  const fullReps = fullDrainRepsFor(n);
  streamingClient.resetCount();
  let fullDrainCountStreaming = 0;
  let rowsFetchedStreamingFull = 0;
  const streamingFullTimes: number[] = [];
  for (let i = 0; i < fullReps; i++) {
    streamingClient.resetCount();
    const t0 = performance.now();
    const all = await collectAll(streamingStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"));
    streamingFullTimes.push(performance.now() - t0);
    fullDrainCountStreaming = all.length;
    rowsFetchedStreamingFull = streamingClient.rowsFetched;
  }

  let fullDrainCountBuffered = 0;
  let rowsFetchedBufferedFull = 0;
  const bufferedFullTimes: number[] = [];
  for (let i = 0; i < fullReps; i++) {
    bufferedClient.resetCount();
    const t0 = performance.now();
    const all = await collectAll(bufferedStore.index_scan(INDEX_ID, "", READ_TS, FULL, "asc"));
    bufferedFullTimes.push(performance.now() - t0);
    fullDrainCountBuffered = all.length;
    rowsFetchedBufferedFull = bufferedClient.rowsFetched;
  }

  if (fullDrainCountStreaming !== n || fullDrainCountBuffered !== n) {
    throw new Error(`full drain row count mismatch: expected ${n}, got streaming=${fullDrainCountStreaming} buffered=${fullDrainCountBuffered}`);
  }

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)]!;
  };

  await streamingStore.pgClient().close();
  await bufferedStore.pgClient().close();

  return {
    n,
    rowsFetchedBufferedPaginated,
    rowsFetchedStreamingPaginated,
    wallBufferedPaginated,
    wallStreamingPaginated,
    rowsFetchedBufferedFull,
    rowsFetchedStreamingFull,
    wallBufferedFullMs: median(bufferedFullTimes),
    wallStreamingFullMs: median(streamingFullTimes),
    fullDrainCountBuffered,
    fullDrainCountStreaming,
  };
}

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function printResult(r: NResult): void {
  const paginatedRowsRatio = r.rowsFetchedBufferedPaginated === 0 ? 0 : r.rowsFetchedStreamingPaginated / r.rowsFetchedBufferedPaginated;
  const paginatedP50Delta = pctDelta(r.wallStreamingPaginated.p50, r.wallBufferedPaginated.p50);
  const paginatedP95Delta = pctDelta(r.wallStreamingPaginated.p95, r.wallBufferedPaginated.p95);
  const fullDelta = pctDelta(r.wallStreamingFullMs, r.wallBufferedFullMs);

  console.log(`\n=== index_scan buffered vs streaming — N=${r.n} ===`);
  console.log(`--- Paginated (break at pageSize=${PAGE_SIZE}, ${paginatedRepsFor(r.n)} reps for wall-clock) ---`);
  console.log(`  rows fetched from DB:  buffered=${r.rowsFetchedBufferedPaginated}   streaming=${r.rowsFetchedStreamingPaginated}   ratio(streaming/buffered)=${paginatedRowsRatio.toFixed(4)}`);
  console.log(`  wall-clock p50:        buffered=${fmt(r.wallBufferedPaginated.p50)}   streaming=${fmt(r.wallStreamingPaginated.p50)}   Δ%=${paginatedP50Delta.toFixed(1)}%`);
  console.log(`  wall-clock p95:        buffered=${fmt(r.wallBufferedPaginated.p95)}   streaming=${fmt(r.wallStreamingPaginated.p95)}   Δ%=${paginatedP95Delta.toFixed(1)}%`);
  console.log(`--- Full drain (no break, ${fullDrainRepsFor(r.n)} reps, median wall-clock — regression control) ---`);
  console.log(`  rows fetched from DB:  buffered=${r.rowsFetchedBufferedFull}   streaming=${r.rowsFetchedStreamingFull}   (both should ≈ N=${r.n})`);
  console.log(`  wall-clock (median):   buffered=${fmt(r.wallBufferedFullMs)}   streaming=${fmt(r.wallStreamingFullMs)}   Δ%=${fullDelta.toFixed(1)}%`);
}

interface Gate {
  label: string;
  pass: boolean;
  detail: string;
}

function gatesFor(r: NResult): Gate[] {
  const paginatedRowsRatio = r.rowsFetchedBufferedPaginated === 0 ? 0 : r.rowsFetchedStreamingPaginated / r.rowsFetchedBufferedPaginated;
  const paginatedP50Delta = pctDelta(r.wallStreamingPaginated.p50, r.wallBufferedPaginated.p50);
  const fullDelta = pctDelta(r.wallStreamingFullMs, r.wallBufferedFullMs);
  const gates: Gate[] = [
    {
      label: "rows-fetched (paginated)",
      pass: r.rowsFetchedStreamingPaginated < r.rowsFetchedBufferedPaginated && paginatedRowsRatio < 0.5,
      detail: `streaming=${r.rowsFetchedStreamingPaginated} buffered=${r.rowsFetchedBufferedPaginated} ratio=${paginatedRowsRatio.toFixed(4)}`,
    },
    {
      label: "full-drain regression (±3%)",
      pass: Math.abs(fullDelta) <= 3,
      detail: `Δ%=${fullDelta.toFixed(1)}%`,
    },
  ];
  // Wall-clock (paginated) win is only gated at N=100,000 per the brief.
  if (r.n >= 100_000) {
    gates.splice(1, 0, {
      label: "wall-clock p50 (paginated, N=100k)",
      pass: paginatedP50Delta < -3,
      detail: `Δ%=${paginatedP50Delta.toFixed(1)}% (negative = streaming faster)`,
    });
  }
  return gates;
}

async function main(): Promise<void> {
  console.log("index_scan buffered-vs-streaming A/B — substrate: PGlite (in-process, embedded-postgres unavailable in this sandbox)");
  console.log(
    "HONESTY NOTE: PGlite has no network hop, so wall-clock here shows compute/serialization avoided only — NOT round-trip savings. " +
      "The production NodePgClient path opens a fresh connection per index_scan (no pool yet); its real-network latency profile is UNMEASURED by this bench.",
  );

  // Smoke-test override, e.g. `HELIPOD_BENCH_PGSTREAM_N=200 bun ...`. Unset in normal use — the
  // gate is defined against the real [1_000, 100_000] grid.
  const override = process.env["HELIPOD_BENCH_PGSTREAM_N"];
  const grid = override ? override.split(",").map((s) => Number(s.trim())) : [1_000, 100_000];

  const results: NResult[] = [];
  for (const n of grid) {
    const r = await runForN(n);
    results.push(r);
    printResult(r);
  }

  console.log("\n=== Gate summary ===");
  let anyFail = false;
  for (const r of results) {
    console.log(`N=${r.n}:`);
    for (const g of gatesFor(r)) {
      const status = g.pass ? "PASS" : "FAIL";
      if (!g.pass) anyFail = true;
      console.log(`  [${status}] ${g.label} — ${g.detail}`);
    }
  }

  console.log(`\n${JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
