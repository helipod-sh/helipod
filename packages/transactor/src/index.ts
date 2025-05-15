/**
 * `@stackbase/transactor` — the single-writer, OCC transaction engine: the reactive write
 * path. Runs a function as a serializable transaction, validates its read set against
 * concurrent commits, applies staged writes to the `DocStore`, and emits an `OplogDelta`
 * for the sync tier.
 */
export type {
  OplogDelta,
  CommitResult,
  WriteFanout,
  TransactionContext,
  RunInTransactionOptions,
  Transactor,
} from "./types";

export { SingleWriterTransactor, type SingleWriterTransactorOptions } from "./single-writer-transactor";

export {
  HeadroomTracker,
  HeadroomExceededError,
  DEFAULT_HEADROOM,
  type HeadroomLimits,
} from "./headroom";

export { UncommittedWrites, type LocalWrite } from "./uncommitted-writes";
export { AsyncMutex } from "./async-mutex";
