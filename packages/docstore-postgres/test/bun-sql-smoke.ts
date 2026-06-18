/**
 * Bun smoke test — validates `BunSqlClient` against a REAL `postgres:16` server through the same
 * `PostgresDocStore` MVCC contract `NodePgClient` passes under Node vitest (see e.g.
 * `write-get.test.ts`/`index-scan.test.ts`, which run the identical assertions over `PgliteClient`).
 * `bun test/bun-sql-smoke.ts` (NOT `.test.ts` — vitest runs under Node, which cannot load `Bun.SQL`;
 * this file is deliberately named so vitest's default glob never collects it) is the only way to
 * exercise the real driver: PGlite/vitest structurally cannot prove Bun.SQL's own wire codec.
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
  ok("index_scan: bytea key is Uint8Array, order correct asc/desc (buffered — no queryStream in v1)");
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

  await store.close();

  console.log("\nBUN SQL SMOKE OK — BunSqlClient passes the MVCC DocStore contract against real Postgres\n");
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
await benchmark();
