/**
 * `@stackbase/errors` — the structured error hierarchy for the Stackbase engine.
 *
 * Every error carries a stable `code`, an HTTP `httpStatus`, and a `retryable` flag,
 * and serializes losslessly via `toJSON()` so it can cross the syscall and wire
 * boundaries without losing its identity. Three families:
 *
 *  - {@link UserError}      — the caller's fault (4xx, not retryable).
 *  - {@link SystemError}    — our fault (5xx, not retryable).
 *  - {@link TransientError} — try again later (5xx/429, retryable).
 *  - {@link ConflictError}  — optimistic-concurrency / write conflict (409, retryable).
 */

export interface StackbaseErrorJSON {
  name: string;
  code: string;
  message: string;
  httpStatus: number;
  retryable: boolean;
  data?: unknown;
}

export interface StackbaseErrorOptions {
  /** The underlying cause (sets `Error.cause`). */
  cause?: unknown;
  /** Structured, serializable payload surfaced to clients / logs. */
  data?: unknown;
}

/** Base class for every error the engine raises deliberately. */
export abstract class StackbaseError extends Error {
  /** Stable, machine-readable identifier (e.g. `"OCC_CONFLICT"`). */
  abstract readonly code: string;
  /** The HTTP status this error maps to at the edge. */
  abstract readonly httpStatus: number;
  /** Whether retrying the same operation could succeed. */
  abstract readonly retryable: boolean;
  /** Optional structured payload. */
  readonly data?: unknown;

  constructor(message: string, options?: StackbaseErrorOptions) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    // `new.target.name` gives the concrete subclass name even after minification-safe builds.
    this.name = new.target.name;
    if (options?.data !== undefined) this.data = options.data;
  }

  toJSON(): StackbaseErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      retryable: this.retryable,
      ...(this.data !== undefined ? { data: this.data } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* User errors — 4xx, not retryable                                           */
/* -------------------------------------------------------------------------- */

export abstract class UserError extends StackbaseError {
  override readonly httpStatus: number = 400;
  override readonly retryable = false;
}

export class ArgumentValidationError extends UserError {
  override readonly code = "ARGUMENT_VALIDATION";
}
export class DocumentValidationError extends UserError {
  override readonly code = "DOCUMENT_VALIDATION";
}
export class FunctionTypeMismatchError extends UserError {
  override readonly code = "FUNCTION_TYPE_MISMATCH";
}
export class QueryError extends UserError {
  override readonly code = "QUERY_ERROR";
}
export class SystemFieldModificationError extends UserError {
  override readonly code = "SYSTEM_FIELD_MODIFICATION";
}
export class SchedulingError extends UserError {
  override readonly code = "SCHEDULING_ERROR";
}
export class DocumentNotFoundError extends UserError {
  override readonly code = "DOCUMENT_NOT_FOUND";
  override readonly httpStatus = 404;
}
export class FunctionNotFoundError extends UserError {
  override readonly code = "FUNCTION_NOT_FOUND";
  override readonly httpStatus = 404;
}
export class IndexNotFoundError extends UserError {
  override readonly code = "INDEX_NOT_FOUND";
  override readonly httpStatus = 404;
}
export class ForbiddenOperationError extends UserError {
  override readonly code = "FORBIDDEN";
  override readonly httpStatus = 403;
}

/* -------------------------------------------------------------------------- */
/* Conflict errors — 409, retryable (the OCC family)                          */
/* -------------------------------------------------------------------------- */

export class ConflictError extends StackbaseError {
  override readonly code: string = "CONFLICT";
  override readonly httpStatus: number = 409;
  override readonly retryable: boolean = true;
}

/** Raised by the transactor when optimistic-concurrency validation fails. */
export class OccConflictError extends ConflictError {
  override readonly code = "OCC_CONFLICT";
}

/* -------------------------------------------------------------------------- */
/* System errors — 5xx, not retryable                                         */
/* -------------------------------------------------------------------------- */

export abstract class SystemError extends StackbaseError {
  override readonly httpStatus: number = 500;
  override readonly retryable = false;
}

export class DatabaseError extends SystemError {
  override readonly code = "DATABASE_ERROR";
}
export class StorageError extends SystemError {
  override readonly code = "STORAGE_ERROR";
}
export class StorageNotConfiguredError extends SystemError {
  override readonly code = "STORAGE_NOT_CONFIGURED";
}
export class UdfExecutionError extends SystemError {
  override readonly code = "UDF_EXECUTION_ERROR";
}
export class ModuleLoadError extends SystemError {
  override readonly code = "MODULE_LOAD_ERROR";
}
/** Catch-all used by {@link toStackbaseError} to normalize unknown throwables. */
export class InternalError extends SystemError {
  override readonly code = "INTERNAL";
}

/* -------------------------------------------------------------------------- */
/* Transient errors — retryable                                               */
/* -------------------------------------------------------------------------- */

export abstract class TransientError extends StackbaseError {
  override readonly httpStatus: number = 503;
  override readonly retryable = true;
}

export class TimeoutError extends TransientError {
  override readonly code = "TIMEOUT";
  override readonly httpStatus = 504;
}
export class RateLimitError extends TransientError {
  override readonly code = "RATE_LIMIT";
  override readonly httpStatus = 429;
}
export class ServiceUnavailableError extends TransientError {
  override readonly code = "SERVICE_UNAVAILABLE";
}

/* -------------------------------------------------------------------------- */
/* Remote errors — a typed error rehydrated after crossing a wire boundary     */
/* -------------------------------------------------------------------------- */

/**
 * A {@link StackbaseError} reconstructed from a serialized {@link StackbaseErrorJSON} that crossed a
 * process boundary (e.g. a fleet SYNC node rehydrating the error a forwarded mutation raised on the
 * WRITER). Carries the ORIGINAL `code`/`httpStatus`/`retryable`/`name`/`data` verbatim, so edge
 * status mapping ({@link getHttpStatus}) and client retry semantics ({@link isRetryableError})
 * survive the hop — without needing a code→class registry. Its `name` is the original error's
 * concrete class name, so `instanceof StackbaseError` holds and log/message shape is preserved.
 */
export class RemoteError extends StackbaseError {
  override readonly code: string;
  override readonly httpStatus: number;
  override readonly retryable: boolean;
  constructor(json: StackbaseErrorJSON) {
    super(json.message, json.data !== undefined ? { data: json.data } : undefined);
    this.code = json.code;
    this.httpStatus = json.httpStatus;
    this.retryable = json.retryable;
    this.name = json.name;
  }
}

/** Rehydrate a {@link StackbaseError} from its serialized form (the inverse of `toJSON()`). Used at
 *  wire boundaries so a typed error's status/code/retryable identity is not flattened to a generic
 *  500 by {@link toStackbaseError}. */
export function stackbaseErrorFromJSON(json: StackbaseErrorJSON): StackbaseError {
  return new RemoteError(json);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export function isStackbaseError(error: unknown): error is StackbaseError {
  return error instanceof StackbaseError;
}

/** True when retrying the operation could plausibly succeed. Non-Stackbase errors → false. */
export function isRetryableError(error: unknown): boolean {
  return isStackbaseError(error) ? error.retryable : false;
}

/** Map any thrown value to an HTTP status. Non-Stackbase errors → 500. */
export function getHttpStatus(error: unknown): number {
  return isStackbaseError(error) ? error.httpStatus : 500;
}

/** Normalize ANY thrown value into a {@link StackbaseError} (preserving the cause). */
export function toStackbaseError(error: unknown): StackbaseError {
  if (isStackbaseError(error)) return error;
  if (error instanceof Error) return new InternalError(error.message, { cause: error });
  return new InternalError(typeof error === "string" ? error : "Unknown error", { data: error });
}
