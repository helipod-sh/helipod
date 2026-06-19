/**
 * Bun smoke test — validates `BunSqlClient` against a REAL `postgres:16` server through the same
 * `PostgresDocStore` MVCC contract `NodePgClient` passes under Node vitest (see e.g.
 * `write-get.test.ts`/`index-scan.test.ts`, which run the identical assertions over `PgliteClient`).
 * `bun test/bun-sql-smoke.ts` (NOT `.test.ts` — vitest runs under Node, which cannot load `Bun.SQL`;
 * this file is deliberately named so vitest's default glob never collects it) is the only way to
 * exercise the real driver: PGlite/vitest structurally cannot prove Bun.SQL's own wire codec.
 *
 * Also covers, against the same real server: `.code` normalization (a genuine `PostgresError`'s
 * `.code` must be the pg SQLSTATE, not Bun's own `ERR_POSTGRES_SERVER_ERROR` — see
 * `testErrorCodeNormalization`), `queryStream` (a SQL-level `DECLARE ... CURSOR`/`FETCH` stream —
 * see `testQueryStream`), and the fleet/sharding surface (`commitQuerierFor`/`tryAcquireShardLock`/
 * `releaseShardLock` — see `testFleet`).
 *
 * Run: `STACKBASE_TEST_DATABASE_URL=postgres://sb:pw@localhost:5433/bunsql_smoke bun test/bun-sql-smoke.ts`
 * (defaults to that same Docker URL if the env var is unset — see `DEFAULT_URL` below).
 */
import assert from "node:assert/strict";
import { PostgresDocStore } from "../src/postgres-docstore";
import { BunSqlClient } from "../src/bun-sql-client";
import { NodePgClient } from "../src/node-pg-client";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@stackbase/id-codec";
import { encodeIndexKey } from "@stackbase/index-key-codec";
import type { DocumentLogEntry, IndexWrite, InternalDocumentId, Interval } from "@stackbase/docstore";

const DEFAULT_URL = "postgres://sb:pw@localhost:5433/bunsql_smoke";
const URL = process.env.STACKBASE_TEST_DATABASE_URL ?? DEFAULT_URL;

const TABLE = 20001;
const TABLE_ID = encodeStorageTableId(TABLE);
const INDEX_ID = encodeStorageIndexId(TABLE, "by_key");
const FULL: Interval = { start: new Uint8Array(), end: null };

function rev(id: InternalDocumentId, ts: bigint, prevTs: bigint | null, body: string | null): DocumentLogEntry {
  return { ts, id, prev_ts: prevTs, value: body === null ? null : { id, value: { body, n: ts } } };
}
function idxPut(id: InternalDocumentId, key: Uint8Array, ts: bigint): IndexWrite {
  return { ts, update: { indexId: INDEX_ID, key, value: { type: "NonClustered", docId: id } } };
}
async function collect<T>(g: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of g) out.push(x);
  return out;
}
function ok(label: string): void {
  console.log(`  [ok] ${label}`);
}

// Reset to a clean schema every run so re-running the smoke doesn't accumulate rows across the
// fixed TABLE/INDEX_ID it uses. `DROP ... CASCADE` is scoped to this smoke's own physical tables —
// the same three the whole package uses — so a fresh `setupSchema()` starts from nothing.
async function resetDatabase(): Promise<void> {
  const admin = new BunSqlClient({ connectionString: URL });
  await admin.query(
    `DROP TABLE IF EXISTS documents, indexes, persistence_globals, client_mutations, client_floors CASCADE`,
  );
  await admin.query(`DROP SEQUENCE IF EXISTS stackbase_ts`);
  await admin.close();
}

async function main(): Promise<void> {
  await resetDatabase();

  const client = new BunSqlClient({ connectionString: URL });
  const store = new PostgresDocStore(client);
  await store.setupSchema(); // also takes the writer advisory lock on the pinned connection
  ok("setupSchema (DDL + writer lock) via BunSqlClient");

  // ── write + get round trip: value/ts/prev_ts types + values ─────────────────────────────────
  const a = newDocumentId(TABLE);
  await store.write([rev(a, 1n, null, "v1")], [], "Error");
  await store.write([rev(a, 2n, 1n, "v2")], [], "Error");
  assert.equal(await store.get(a, 0n), null);
  const atV1 = await store.get(a, 1n);
  assert.equal(atV1!.value.value.body, "v1");
  const latest = await store.get(a);
  assert.equal(latest!.value.value.body, "v2");
  assert.equal(typeof latest!.ts, "bigint");
  assert.equal(latest!.ts, 2n);
  assert.equal(typeof latest!.prev_ts, "bigint");
  assert.equal(latest!.prev_ts, 1n);
  ok("write + get MVCC round trip (ts/prev_ts are real bigint)");

  // ── the codec, explicitly: a doc with a bigint field, a bytea id, a boolean, and a null ──────
  const codecId = newDocumentId(TABLE);
  await store.write(
    [
      {
        ts: 3n,
        id: codecId,
        prev_ts: null,
        value: { id: codecId, value: { big: 123456789012345n, flag: true, nothing: null, body: "codec" } },
      },
    ],
    [],
    "Error",
  );
  const codecDoc = await store.get(codecId);
  const codecVal = codecDoc!.value.value as { big: bigint; flag: boolean; nothing: null; body: string };
  assert.equal(typeof codecVal.big, "bigint");
  assert.equal(codecVal.big, 123456789012345n);
  assert.equal(codecVal.flag, true);
  assert.equal(codecVal.nothing, null);
  assert.ok(codecDoc!.value.id.internalId instanceof Uint8Array); // bytea id
  assert.equal(typeof codecDoc!.ts, "bigint");
  ok("codec: bigint field, bytea id, boolean, null all round-trip correctly");

  // ── bytea-keyed index_scan: key is Uint8Array, correct rows/order ───────────────────────────
  const b = newDocumentId(TABLE);
  const c = newDocumentId(TABLE);
  const ka = encodeIndexKey(["a"]);
  const kb = encodeIndexKey(["b"]);
  const kc = encodeIndexKey(["c"]);
  await store.write(
    [rev(b, 4n, null, "B"), rev(c, 4n, null, "C")],
    [idxPut(b, kb, 4n), idxPut(c, kc, 4n)],
    "Error",
  );
  const scanned = await collect(store.index_scan(INDEX_ID, TABLE_ID, 10n, FULL, "asc"));
  assert.equal(scanned.length, 2);
  assert.ok(scanned[0]![0] instanceof Uint8Array);
  assert.deepEqual([...scanned[0]![0]], [...kb]);
  assert.equal(scanned.map(([, d]) => d.value.value.body).join(","), "B,C");
  const descScanned = await collect(store.index_scan(INDEX_ID, TABLE_ID, 10n, FULL, "desc"));
  assert.equal(descScanned.map(([, d]) => d.value.value.body).join(","), "C,B");
  ok("index_scan: bytea key is Uint8Array, order correct asc/desc (now streamed via BunSqlClient.queryStream)");
  void ka; // acknowledged but unused directly (kept for symmetry with the other two keys)

  // ── scan + count ──────────────────────────────────────────────────────────────────────────
  const scannedAll = await store.scan(TABLE_ID);
  assert.equal(scannedAll.length, 4); // a, codecId, b, c — all share TABLE
  const n = await store.count(TABLE_ID);
  assert.equal(n, 4);
  ok("scan + count");

  // ── commitWrite: monotonic ts ─────────────────────────────────────────────────────────────
  const d = newDocumentId(TABLE);
  const e = newDocumentId(TABLE);
  const ts1 = await store.commitWrite([rev(d, 0n, null, "D")], []);
  const ts2 = await store.commitWrite([rev(e, 0n, null, "E")], []);
  assert.ok(ts2 > ts1, `expected commitWrite ts to be monotonic: ts1=${ts1} ts2=${ts2}`);
  ok(`commitWrite: monotonic ts (ts1=${ts1} < ts2=${ts2})`);

  // ── transaction rollback on throw: atomicity ─────────────────────────────────────────────
  let threw = false;
  try {
    await client.transaction(async (tx) => {
      await tx.query(`INSERT INTO persistence_globals (key, value) VALUES ($1, $2)`, [
        "smoke:tx-marker",
        "should-not-persist",
      ]);
      throw new Error("deliberate rollback");
    });
  } catch (e) {
    threw = (e as Error).message === "deliberate rollback";
  }
  assert.ok(threw, "transaction callback's throw must propagate");
  const markerRows = await client.query(`SELECT value FROM persistence_globals WHERE key = $1`, [
    "smoke:tx-marker",
  ]);
  assert.equal(markerRows.length, 0, "a thrown transaction must roll back its writes");
  ok("transaction() rolls back atomically on throw");

  // ── single-writer: acquireWriterLock held; a second client's tryAcquireWriterLock is false ──
  const second = new BunSqlClient({ connectionString: URL });
  const gotSecond = await second.tryAcquireWriterLock();
  assert.equal(gotSecond, false, "a second client must NOT be able to take the held advisory lock");
  await second.close();
  ok("single-writer: second BunSqlClient.tryAcquireWriterLock() correctly returns false");

  // ── .code normalization: setupSchema re-run swallows its duplicate-object race errors ────────
  // Same pinned connection/session as the first `setupSchema()` call above, so re-acquiring the
  // writer lock is a reentrant no-op (Postgres advisory locks are session-reentrant) and the DDL
  // loop hits genuine "already exists" errors on every statement — if BunSqlClient did NOT
  // normalize `.code` to the real SQLSTATE (Bun's own `.code` is `ERR_POSTGRES_SERVER_ERROR`, not
  // `42P07`/`23505`/`42710`), `postgres-docstore.ts`'s swallow condition would fail to match and
  // this call would throw instead of completing cleanly.
  await store.setupSchema();
  ok("setupSchema is idempotent: second run's duplicate-object/table errors were swallowed via the normalized .code");

  await store.close();

  console.log("\nBUN SQL SMOKE OK — BunSqlClient passes the MVCC DocStore contract against real Postgres\n");
}

// ── .code normalization, directly: a duplicate-table error's .code is the SQLSTATE, not Bun's
//    generic ERR_POSTGRES_SERVER_ERROR ─────────────────────────────────────────────────────────
async function testErrorCodeNormalization(): Promise<void> {
  const c = new BunSqlClient({ connectionString: URL });
  await c.query(`DROP TABLE IF EXISTS bun_code_probe`);
  await c.query(`CREATE TABLE bun_code_probe (id int primary key)`);
  try {
    await c.query(`CREATE TABLE bun_code_probe (id int primary key)`); // 42P07 duplicate_table
    assert.fail("expected a duplicate-table error");
  } catch (e) {
    assert.equal(
      (e as { code?: string }).code,
      "42P07",
      "BunSqlClient must normalize .code to the pg SQLSTATE, not Bun's ERR_POSTGRES_SERVER_ERROR",
    );
  }
  try {
    await c.query(`INSERT INTO bun_code_probe (id) VALUES (1)`);
    await c.query(`INSERT INTO bun_code_probe (id) VALUES (1)`); // 23505 unique_violation
    assert.fail("expected a unique-violation error");
  } catch (e) {
    assert.equal((e as { code?: string }).code, "23505");
  }
  await c.query(`DROP TABLE bun_code_probe`);
  await c.close();
  ok("BunSqlClient normalizes thrown PostgresError.code to the real SQLSTATE (42P07/23505), not ERR_POSTGRES_SERVER_ERROR");
}

// ── queryStream: bytea-keyed streaming read ≡ buffered results; early break yields fewer rows ──
async function testQueryStream(): Promise<void> {
  const STREAM_TABLE = 20002;
  const client = new BunSqlClient({ connectionString: URL });
  const store = new PostgresDocStore(client);
  await store.setupSchema();

  const N = 30;
  for (let i = 0; i < N; i++) {
    const id = newDocumentId(STREAM_TABLE);
    await store.write([rev(id, BigInt(1000 + i), null, `s${i}`)], [], "Error");
  }

  const sql = `SELECT internal_id, ts, value FROM documents WHERE table_id = $1 ORDER BY ts ASC`;
  const params = [encodeStorageTableId(STREAM_TABLE)];

  const buffered = await client.query(sql, params);
  assert.equal(buffered.length, N, "sanity: buffered query sees all N rows");

  assert.equal(typeof client.queryStream, "function", "BunSqlClient.queryStream must be implemented (Bun.SQL DECLARE/FETCH cursor)");
  const streamed: typeof buffered = [];
  for await (const row of client.queryStream!(sql, params)) streamed.push(row);
  assert.equal(streamed.length, N, "streamed full drain must see the same row count as buffered query()");
  assert.deepEqual(
    streamed.map((r) => r.ts),
    buffered.map((r) => r.ts),
    "streamed rows must match buffered rows in the same order",
  );
  assert.ok(streamed[0]!.internal_id instanceof Uint8Array, "bytea internal_id must decode as Uint8Array via queryStream, same as query()");
  ok(`queryStream: full-drain stream (${N} rows) ≡ buffered query(), bytea id decodes correctly`);

  // Early break: consumer stops after a handful of rows — must yield exactly that many, never hang,
  // and must not corrupt the connection for subsequent calls (cursor CLOSE + ROLLBACK in `finally`).
  const BREAK_AT = 3;
  let seen = 0;
  for await (const _row of client.queryStream!(sql, params)) {
    seen++;
    if (seen === BREAK_AT) break;
  }
  assert.equal(seen, BREAK_AT, "an early consumer break must yield exactly BREAK_AT rows, not the full N");
  ok(`queryStream: early break after ${BREAK_AT} rows (< ${N} total) — cursor released cleanly, no hang`);

  // Prove the connection pool/session is still healthy after the early break: a fresh full drain
  // still sees every row.
  const streamedAgain: typeof buffered = [];
  for await (const row of client.queryStream!(sql, params)) streamedAgain.push(row);
  assert.equal(streamedAgain.length, N, "a queryStream call after an earlier early-break must still see all N rows (no connection corruption/leak)");
  ok("queryStream: a subsequent full drain after an early break still sees all rows (no connection corruption/leak)");

  await store.close();
}

// ── close-while-streaming: close() must NOT hang when a queryStream is mid-iteration and never
//    drained/broken (the shutdown-hang this fix closes — sql.end() otherwise waits forever for the
//    stream's reserved connection, which an abandoned generator will never itself release) ────────
async function testCloseWhileStreaming(): Promise<void> {
  const STREAM_TABLE = 20003;
  const client = new BunSqlClient({ connectionString: URL });
  const store = new PostgresDocStore(client);
  await store.setupSchema();

  const N = 10;
  for (let i = 0; i < N; i++) {
    const id = newDocumentId(STREAM_TABLE);
    await store.write([rev(id, BigInt(2000 + i), null, `cw${i}`)], [], "Error");
  }

  const sql = `SELECT internal_id, ts, value FROM documents WHERE table_id = $1 ORDER BY ts ASC`;
  const params = [encodeStorageTableId(STREAM_TABLE)];

  // Consume exactly one row via `.next()` directly (bypassing `for await`, which would trigger an
  // implicit `.return()`/`finally` on `break` — that's the already-covered early-break case in
  // `testQueryStream`). Then deliberately ABANDON the generator: never call `.next()`/`.return()`
  // again. This is the case whose `finally` never runs on its own, so the reserved connection can
  // only be recovered by `close()`'s own force-release (the hang this fix closes).
  const iter = client.queryStream!(sql, params)[Symbol.asyncIterator]();
  const first = await iter.next();
  assert.equal(first.done, false, "sanity: the stream yielded a row before being abandoned");
  // `iter` is now deliberately leaked/abandoned — never `.return()`ed, never drained.

  const closeStart = Date.now();
  const closeTimeoutMs = 5000;
  await Promise.race([
    store.close(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`close() did not return within ${closeTimeoutMs}ms — shutdown hang`)), closeTimeoutMs),
    ),
  ]);
  const closeElapsedMs = Date.now() - closeStart;
  ok(`close-while-streaming: close() returned in ${closeElapsedMs}ms (< ${closeTimeoutMs}ms) despite an abandoned, undrained queryStream`);
}

// ── kill switch: STACKBASE_PG_STREAM=0/"false" disables queryStream on the Bun path, mirroring
//    NodePgClient's identical env var ────────────────────────────────────────────────────────────
async function testKillSwitch(): Promise<void> {
  const original = process.env.STACKBASE_PG_STREAM;
  try {
    process.env.STACKBASE_PG_STREAM = "0";
    const disabled = new BunSqlClient({ connectionString: URL });
    assert.equal(disabled.queryStream, undefined, "STACKBASE_PG_STREAM=0 must leave queryStream unassigned");
    await disabled.close();

    process.env.STACKBASE_PG_STREAM = "false";
    const disabled2 = new BunSqlClient({ connectionString: URL });
    assert.equal(disabled2.queryStream, undefined, 'STACKBASE_PG_STREAM="false" must leave queryStream unassigned');
    await disabled2.close();

    delete process.env.STACKBASE_PG_STREAM;
    const enabledUnset = new BunSqlClient({ connectionString: URL });
    assert.equal(typeof enabledUnset.queryStream, "function", "unset STACKBASE_PG_STREAM must default queryStream ON");
    await enabledUnset.close();

    process.env.STACKBASE_PG_STREAM = "1";
    const enabledOne = new BunSqlClient({ connectionString: URL });
    assert.equal(typeof enabledOne.queryStream, "function", 'STACKBASE_PG_STREAM="1" (any non-"0"/"false" value) must leave queryStream ON');
    await enabledOne.close();
  } finally {
    if (original === undefined) delete process.env.STACKBASE_PG_STREAM;
    else process.env.STACKBASE_PG_STREAM = original;
  }
  ok("kill switch: STACKBASE_PG_STREAM=0/\"false\" disables queryStream; unset/\"1\" leaves it enabled");
}

// ── fleet: commitQuerierFor gives independent per-shard sessions; shard locks are session-scoped
//    and mutually exclusive across clients ─────────────────────────────────────────────────────
async function testFleet(): Promise<void> {
  const SHARDS = ["shard-a", "shard-b"] as const;
  const fleetClient = new BunSqlClient({ connectionString: URL, commitPool: { shards: [...SHARDS] } });

  assert.equal(typeof fleetClient.commitQuerierFor, "function", "commitQuerierFor must be present when commitPool is configured");
  assert.equal(typeof fleetClient.tryAcquireShardLock, "function");
  assert.equal(typeof fleetClient.releaseShardLock, "function");

  const qa = await fleetClient.commitQuerierFor!("shard-a");
  const qb = await fleetClient.commitQuerierFor!("shard-b");
  const [pidA] = await qa.query(`SELECT pg_backend_pid() AS pid`);
  const [pidB] = await qb.query(`SELECT pg_backend_pid() AS pid`);
  assert.notEqual(pidA!.pid, pidB!.pid, "each shard's commitQuerierFor must be an independent Postgres session");
  ok(`fleet: commitQuerierFor("shard-a")/("shard-b") are independent sessions (pid ${pidA!.pid} vs ${pidB!.pid})`);

  // Genuine concurrency proof: hold shard A's transaction open across an await while shard B's
  // commit completes and becomes visible — impossible on a single shared session.
  await fleetClient.query(`CREATE TABLE IF NOT EXISTS bun_fleet_probe (id int, shard text)`);
  await fleetClient.query(`TRUNCATE bun_fleet_probe`);
  let releaseA!: () => void;
  const gate = new Promise<void>((r) => (releaseA = r));
  const txA = qa.transaction(async (tx) => {
    await tx.query(`INSERT INTO bun_fleet_probe (id, shard) VALUES (1, 'a')`);
    await gate;
  });
  await qb.transaction(async (tx) => {
    await tx.query(`INSERT INTO bun_fleet_probe (id, shard) VALUES (2, 'b')`);
  });
  const midRows = await fleetClient.query(`SELECT shard FROM bun_fleet_probe ORDER BY id`);
  assert.deepEqual(midRows.map((r) => r.shard), ["b"], "shard B's commit must be visible while shard A's is still open");
  releaseA();
  await txA;
  const finalRows = await fleetClient.query(`SELECT shard FROM bun_fleet_probe ORDER BY id`);
  assert.deepEqual(finalRows.map((r) => r.shard), ["a", "b"]);
  ok("fleet: shard A held open across an await while shard B's independent commit completed and became visible");

  await fleetClient.close();

  // Shard-lock acquire→release round trip, across TWO independent clients — proves the two-int
  // advisory lock is genuinely session-scoped (mutually exclusive across sessions) and released.
  const lockClientA = new BunSqlClient({ connectionString: URL, commitPool: { shards: [...SHARDS] } });
  const lockClientB = new BunSqlClient({ connectionString: URL, commitPool: { shards: [...SHARDS] } });
  const gotA = await lockClientA.tryAcquireShardLock!(0);
  assert.equal(gotA, true, "slot 0 should be free and acquirable");
  const gotBWhileHeld = await lockClientB.tryAcquireShardLock!(0);
  assert.equal(gotBWhileHeld, false, "a second client must NOT acquire a slot lock the first client holds");
  await lockClientA.releaseShardLock!(0);
  const gotBAfterRelease = await lockClientB.tryAcquireShardLock!(0);
  assert.equal(gotBAfterRelease, true, "after release, a different client can acquire the same slot");
  await lockClientA.close();
  await lockClientB.close();
  ok("fleet: tryAcquireShardLock/releaseShardLock round-trips and is mutually exclusive across clients");
}

// ── benchmark: BunSqlClient vs NodePgClient, same hot query, ~3000 reps, p50/p95 ─────────────
function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function benchmark(): Promise<void> {
  const REPS = 3000;
  const query = `SELECT internal_id, ts, prev_ts, value FROM documents WHERE table_id = $1 AND internal_id = $2`;
  const id = newDocumentId(TABLE);
  const bunClient = new BunSqlClient({ connectionString: URL });
  const nodeClient = new NodePgClient({ connectionString: URL });
  // Warm both connections (pinned reserve / pg connect) before timing.
  await bunClient.query(`SELECT 1`);
  await nodeClient.query(`SELECT 1`);

  async function timeReps(fn: () => Promise<unknown>): Promise<number[]> {
    const samples: number[] = [];
    for (let i = 0; i < REPS; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    return samples.sort((x, y) => x - y);
  }

  const bunSamples = await timeReps(() => bunClient.query(query, [TABLE_ID, id.internalId]));
  const nodeSamples = await timeReps(() => nodeClient.query(query, [TABLE_ID, id.internalId]));

  const bunP50 = percentile(bunSamples, 50);
  const bunP95 = percentile(bunSamples, 95);
  const nodeP50 = percentile(nodeSamples, 50);
  const nodeP95 = percentile(nodeSamples, 95);
  const deltaP50 = (((nodeP50 - bunP50) / nodeP50) * 100).toFixed(1);
  const deltaP95 = (((nodeP95 - bunP95) / nodeP95) * 100).toFixed(1);

  console.log(`BENCHMARK (${REPS} reps, same hot query, against ${URL}):`);
  console.log(`  BunSqlClient  p50=${bunP50.toFixed(3)}ms  p95=${bunP95.toFixed(3)}ms`);
  console.log(`  NodePgClient  p50=${nodeP50.toFixed(3)}ms  p95=${nodeP95.toFixed(3)}ms`);
  console.log(`  Bun.SQL delta vs pg: p50 ${deltaP50}% faster, p95 ${deltaP95}% faster (positive = Bun.SQL wins)`);

  await bunClient.close();
  await nodeClient.close();
}

await main();
await testErrorCodeNormalization();
await testQueryStream();
await testCloseWhileStreaming();
await testKillSwitch();
await testFleet();
await benchmark();
