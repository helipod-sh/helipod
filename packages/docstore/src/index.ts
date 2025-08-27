/**
 * `@stackbase/docstore` — the storage contract (the narrow seam) plus the timestamp
 * oracle. Implementations live in sibling packages (`@stackbase/docstore-sqlite`, …).
 */
export type {
  InternalDocumentId,
  ShardId,
  DocumentValue,
  ResolvedDocument,
  DocumentLogEntry,
  LatestDocument,
  Order,
  ConflictStrategy,
  Interval,
  TimestampRange,
  DatabaseIndexValue,
  DatabaseIndexUpdate,
  IndexWrite,
  IndexOverlayEntry,
  PrevRevQuery,
  SchemaSetupOptions,
  DocStore,
  TimestampOracle,
} from "./types";
export { getPrevRevQueryKey } from "./types";

export { MonotonicTimestampOracle } from "./timestamp-oracle";
