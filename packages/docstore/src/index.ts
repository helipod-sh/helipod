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
  CommitUnit,
  CommitGuardUnit,
  IndexOverlayEntry,
  PrevRevQuery,
  SchemaSetupOptions,
  DocStore,
  TimestampOracle,
  ClientVerdictRecord,
  ClientVerdictWrite,
} from "./types";
export { getPrevRevQueryKey, CLIENT_VERDICT_VALUE_CAP_BYTES } from "./types";

export { MonotonicTimestampOracle } from "./timestamp-oracle";

export type {
  MigrationDump,
  WireDocumentLogEntry,
  WireIndexWrite,
  DumpableDocStore,
  ImportableDocStore,
  ExportDumpMeta,
} from "./migration-dump";
export {
  MIGRATION_DUMP_FORMAT,
  MIGRATION_DUMP_VERSION,
  exportDumpFromStore,
  serializeDump,
  parseDump,
  decodeDumpRows,
  isDumpable,
  assertImportableTableNumbers,
  applyDumpToStore,
  DumpUnsupportedError,
  InvalidDumpError,
  TableNumberMismatchError,
} from "./migration-dump";
