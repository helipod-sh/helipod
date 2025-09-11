/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Shared point-range conversion helpers, extracted from `node.ts` (slice 1) so `replica-tailer.ts`
 * (slice 2) can reuse them without creating a `replica-tailer.ts` <-> `node.ts` import cycle
 * (`node.ts` composes fleet nodes and will itself come to depend on `replica-tailer.ts`). `node.ts`
 * re-exports both functions from here so its own callers and existing tests are unaffected.
 */
import {
  keySuccessor,
  serializeKeyRange,
  indexKeyspaceId,
  tableKeyspaceId,
  type SerializedKeyRange,
} from "@stackbase/index-key-codec";
import { decodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";

/**
 * Convert a single written `(indexId, key)` pair into the sync handler's point range
 * `[key, keySuccessor(key))` — the exact same half-open encoding `RangeSet.addKey` uses for a
 * point read/write, so a follower's derived write range overlaps a subscription's recorded read
 * range under `rangesOverlap`.
 *
 * `indexId` here is the Postgres `indexes.index_id` column — the STORAGE index id produced by
 * `encodeStorageIndexId`, format `"<tableNumber>/<indexName>"` (e.g. `"10001/by_creation"`). That
 * is NOT the same string as the engine's keyspace id (`indexKeyspaceId`'s `"index:<table>:<name>"`
 * / `tableKeyspaceId`'s `"table:<table>"`, see `packages/index-key-codec/src/keyspace.ts`), which is
 * what `SerializedKeyRange.keyspace` — and `rangesOverlap` — actually compare on. So the storage id
 * must be decoded back into its parts and the keyspace REBUILT with the engine's own helper; feeding
 * the raw storage id straight through silently produces ranges that can never overlap anything.
 */
export function keyToPointRange(indexId: string, key: Uint8Array): SerializedKeyRange {
  const { tableNumber, indexName } = decodeStorageIndexId(indexId);
  const keyspace = indexKeyspaceId(encodeStorageTableId(tableNumber), indexName);
  return serializeKeyRange({ keyspace, start: key, end: keySuccessor(key) });
}

/**
 * Convert a single written `(table_id, internal_id)` pair — from `documents`, i.e.
 * `DerivedInvalidation.writtenDocs` — into the DOCUMENT-keyspace point range a bare
 * `ctx.db.get(id)` read records: `[internalId, keySuccessor(internalId))` under
 * `tableKeyspaceId(table)`. Unlike `keyToPointRange` above, no decode/recompose round trip is
 * needed here — the Postgres `documents.table_id` column is already written as
 * `encodeStorageTableId(tableNumber)` (see `postgres-docstore.ts`'s `write()`), which is exactly
 * the string `tableKeyspaceId` expects; it is NOT a storage *index* id, so there is no separate
 * "storage id" vs "engine keyspace id" split to bridge for the table half. This must match
 * `single-writer-transactor.ts`'s `docKeyspace()` (`tableKeyspaceId(encodeStorageTableId(...))`)
 * plus its `RangeSet.addKey(docKeyspace(id), id.internalId)` byte-for-byte, or a follower never
 * invalidates a subscription whose only read was a point `get`.
 */
export function docKeyToPointRange(tableId: string, internalId: Uint8Array): SerializedKeyRange {
  const keyspace = tableKeyspaceId(tableId);
  return serializeKeyRange({ keyspace, start: internalId, end: keySuccessor(internalId) });
}
