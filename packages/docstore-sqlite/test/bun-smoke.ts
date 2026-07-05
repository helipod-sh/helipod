/**
 * Bun smoke test — validates the BunSqliteAdapter against the same DocStore the Node
 * adapter passes under vitest. Run with: `bun run test/bun-smoke.ts` (not picked up by
 * vitest, which runs under Node). Proves the runtime-agnostic engine works on Bun.
 */
import assert from "node:assert/strict";
import { BunSqliteAdapter, SqliteDocStore } from "../src/index";
import { newDocumentId, encodeStorageTableId, encodeStorageIndexId } from "@helipod/id-codec";
import { encodeIndexKey } from "@helipod/index-key-codec";
import type { DocumentLogEntry } from "@helipod/docstore";

const TABLE = 10001;
const TABLE_ID = encodeStorageTableId(TABLE);

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

const store = new SqliteDocStore(new BunSqliteAdapter());
await store.setupSchema();

const id = newDocumentId(TABLE);
const rev = (ts: bigint, prev: bigint | null, body: string | null): DocumentLogEntry => ({
  ts,
  id,
  prev_ts: prev,
  value: body === null ? null : { id, value: { body, n: ts } },
});

// MVCC reads
await store.write([rev(1n, null, "v1")], [], "Error");
await store.write([rev(2n, 1n, "v2")], [], "Error");
assert.equal((await store.get(id, 1n))!.value.value.body, "v1");
assert.equal((await store.get(id))!.value.value.body, "v2");
assert.equal((await store.get(id))!.value.value.n, 2n); // bigint survives

// tombstone
await store.write([rev(3n, 2n, null)], [], "Error");
assert.equal(await store.get(id), null);
assert.equal(await store.count(TABLE_ID), 0);

// index scan
const other = newDocumentId(TABLE);
const indexId = encodeStorageIndexId(TABLE, "by_body");
await store.write(
  [{ ts: 4n, id: other, prev_ts: null, value: { id: other, value: { body: "z" } } }],
  [{ ts: 4n, update: { indexId, key: encodeIndexKey(["z"]), value: { type: "NonClustered", docId: other } } }],
  "Error",
);
const scanned = await collect(store.index_scan(indexId, TABLE_ID, 4n, { start: encodeIndexKey([]), end: null }, "asc"));
assert.equal(scanned.length, 1);
assert.equal(scanned[0]![1].value.value.body, "z");

console.log("BUN SMOKE OK — BunSqliteAdapter passes the MVCC DocStore contract");
