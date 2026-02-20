/**
 * Shared point-range conversion helpers — the canonical home for `keyToPointRange`/
 * `docKeyToPointRange`, byte-for-byte identical to the versions that originally shipped in
 * `ee/packages/fleet/src/ranges.ts` (Tier 3 Slice 1/2). Extracted here (Tier 3 Slice 8, Task 8.1) so
 * `ee/packages/objectstore-substrate`'s replica reactive-tailer wiring can reuse them without taking
 * a dependency on `@stackbase/fleet` (an EE package objectstore-substrate must not import — the
 * object-store substrate and the Postgres fleet are siblings, not a hierarchy).
 *
 * Homed in `@stackbase/id-codec`, NOT `@stackbase/index-key-codec`, despite `SerializedKeyRange`
 * itself living in the latter: these functions bridge a STORAGE id (`decodeStorageIndexId`,
 * `encodeStorageTableId` — this package's own `storage-id.ts`) to the engine's KEYSPACE id
 * (`indexKeyspaceId`/`tableKeyspaceId` — `@stackbase/index-key-codec`'s `keyspace.ts`), so they
 * inherently need both id spaces. `@stackbase/id-codec` already depends on
 * `@stackbase/index-key-codec` (see `jump-hash.ts`'s `encodeIndexKey` import), so this direction adds
 * no new edge; the reverse — moving these into `index-key-codec` and having IT depend on
 * `id-codec`'s storage-id helpers — would create an import cycle (`id-codec -> index-key-codec ->
 * id-codec`). `id-codec` is therefore the only cycle-free canonical home for this bridge.
 *
 * `ee/packages/fleet/src/ranges.ts` re-exports both functions from here verbatim — fleet's public
 * API and existing tests are unaffected by the move.
 */
import {
  keySuccessor,
  serializeKeyRange,
  indexKeyspaceId,
  tableKeyspaceId,
  type SerializedKeyRange,
} from "@stackbase/index-key-codec";
import { decodeStorageIndexId, encodeStorageTableId } from "./storage-id";

/**
 * Convert a single written `(indexId, key)` pair into the sync handler's point range
 * `[key, keySuccessor(key))` — the exact same half-open encoding `RangeSet.addKey` uses for a
 * point read/write, so a follower's derived write range overlaps a subscription's recorded read
 * range under `rangesOverlap`.
 *
 * `indexId` here is the storage `index_id` — the STORAGE index id produced by
 * `encodeStorageIndexId`, format `"<tableNumber>/<indexName>"` (e.g. `"10001/by_creation"`). That
 * is NOT the same string as the engine's keyspace id (`indexKeyspaceId`'s `"index:<table>:<name>"`
 * / `tableKeyspaceId`'s `"table:<table>"`), which is what `SerializedKeyRange.keyspace` — and
 * `rangesOverlap` — actually compare on. So the storage id must be decoded back into its parts and
 * the keyspace REBUILT with the engine's own helper; feeding the raw storage id straight through
 * silently produces ranges that can never overlap anything.
 */
export function keyToPointRange(indexId: string, key: Uint8Array): SerializedKeyRange {
  const { tableNumber, indexName } = decodeStorageIndexId(indexId);
  const keyspace = indexKeyspaceId(encodeStorageTableId(tableNumber), indexName);
  return serializeKeyRange({ keyspace, start: key, end: keySuccessor(key) });
}

/**
 * Convert a single written `(table_id, internal_id)` pair — e.g. from a `DerivedInvalidation`'s (or
 * `AppliedInvalidation`'s) `writtenDocs` — into the DOCUMENT-keyspace point range a bare
 * `ctx.db.get(id)` read records: `[internalId, keySuccessor(internalId))` under
 * `tableKeyspaceId(table)`. Unlike `keyToPointRange` above, no decode/recompose round trip is
 * needed here — `table_id` is already `encodeStorageTableId(tableNumber)`, exactly the string
 * `tableKeyspaceId` expects; it is NOT a storage *index* id, so there is no separate "storage id"
 * vs "engine keyspace id" split to bridge for the table half. This must match
 * `single-writer-transactor.ts`'s `docKeyspace()` (`tableKeyspaceId(encodeStorageTableId(...))`)
 * plus its `RangeSet.addKey(docKeyspace(id), id.internalId)` byte-for-byte, or a follower never
 * invalidates a subscription whose only read was a point `get`.
 */
export function docKeyToPointRange(tableId: string, internalId: Uint8Array): SerializedKeyRange {
  const keyspace = tableKeyspaceId(tableId);
  return serializeKeyRange({ keyspace, start: internalId, end: keySuccessor(internalId) });
}
