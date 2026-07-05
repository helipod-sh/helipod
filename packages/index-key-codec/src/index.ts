/**
 * `@helipod/index-key-codec` — the order-preserving key codec plus key-range
 * machinery. Canonical home (design §3.1) for `KeyRange`, `RangeSet`,
 * `SerializedKeyRange`, `WriteInvalidation`, cursors, and the keyspace helpers; every
 * other package imports these from here rather than redeclaring them.
 */
export type { IndexableValue, IndexKeyTuple } from "./encode";
export {
  encodeIndexKey,
  compareIndexKeys,
  compareKeyBytes,
  indexKeysEqual,
  indexKeyRangeStart,
  indexKeyRangeEnd,
  compareIndexTuples,
  normalizeValue,
} from "./encode";

export type { Keyspace } from "./keyspace";
export {
  keyspaceId,
  parseKeyspaceId,
  tableKeyspaceId,
  indexKeyspaceId,
  tableOfKeyspaceId,
} from "./keyspace";

export type { KeyRange } from "./range";
export {
  RangeSet,
  keyInRange,
  rangesOverlap,
  keySuccessor,
  writtenTablesFromRanges,
} from "./range";

export { IntervalIndex } from "./interval-index";

export type { SerializedKeyRange, WriteInvalidation } from "./serialize";
export { serializeKeyRange, deserializeKeyRange, bytesToBase64, base64ToBytes } from "./serialize";

export type { Cursor, SimpleCursor, IndexCursor } from "./cursor";
export { encodeCursor, decodeCursor, getCursorId, InvalidCursorError } from "./cursor";
