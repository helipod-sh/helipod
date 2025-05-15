/**
 * `@stackbase/id-codec` — document identity (the self-validating `DocumentId` codec),
 * the binary primitives it's built from (Crockford base32, fletcher16, varint), storage
 * id helpers, the table registry, and the sharding seam (`ShardId`, `ShardKeyResolver`,
 * `ShardRouter`). Canonical home (design §3.1) for `ShardId`/`DEFAULT_SHARD` and identity.
 */
export { CROCKFORD_ALPHABET, base32Encode, base32Decode, isValidBase32, Base32Error } from "./base32";
export { fletcher16, verifyFletcher16 } from "./checksum";
export { varintEncode, varintDecode, varintEncodedLength, VarintError } from "./varint";
export type { VarintDecodeResult } from "./varint";

export {
  INTERNAL_ID_BYTES,
  DocumentIdError,
  generateInternalId,
  newDocumentId,
  encodeDocumentId,
  encodeInternalDocumentId,
  decodeDocumentId,
  tryDecodeDocumentId,
  isValidDocumentId,
  getEncodedLength,
  documentIdKey,
  parseDocumentIdKey,
  documentIdsEqual,
  internalIdToHex,
} from "./document-id";
export type { InternalId, InternalDocumentId, DocumentId } from "./document-id";

export {
  encodeStorageTableId,
  decodeStorageTableId,
  encodeStorageIndexId,
  decodeStorageIndexId,
} from "./storage-id";

export {
  DEFAULT_SHARD,
  DefaultShardKeyResolver,
  FieldShardKeyResolver,
  SimpleShardRouter,
} from "./shard";
export type { ShardId, ShardKey, ShardKeyResolver, ShardKeyResolverInput, ShardRouter } from "./shard";

export {
  MemoryTableRegistry,
  isSystemTableName,
  getFullTableName,
  parseFullTableName,
  SYSTEM_TABLE_NUMBER_MIN,
  SYSTEM_TABLE_NUMBER_MAX,
  USER_TABLE_NUMBER_START,
} from "./table-registry";
export type { TableVisibility, TableState, TableInfo, AllocateOptions, TableRegistry } from "./table-registry";
