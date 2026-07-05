/**
 * `@helipod/executor` — runs user functions through a fully-serializable syscall ABI (the
 * host/guest split), with determinism profiles and an inline (Tier 0) executor. The kernel
 * maintains indexes on writes, so insert-then-query works end to end.
 */
export type { UdfType, CapabilityMode, UdfCapabilities, UdfEnvironmentProfile } from "./profile";
export { QUERY_PROFILE, MUTATION_PROFILE, ACTION_PROFILE, HTTP_ACTION_PROFILE, profileFor } from "./profile";

export type { SeededRandom } from "./seeded-random";
export { createSeededRandom } from "./seeded-random";

export type { KernelContext, SyscallHandler, SyscallChannel, CollectTrace, PaginateTrace } from "./kernel";
export { SyscallRouter, InlineSyscallChannel, createKernelRouter, COLLECT_BRAND, CrossStoreWriteError } from "./kernel";

export type { IndexCatalog, TableMeta } from "./catalog";
export { SimpleIndexCatalog } from "./catalog";

export type { DocId, QueryCtx, MutationCtx, ActionCtx, FunctionReference } from "./guest";
export { GuestDatabaseReader, GuestDatabaseWriter, QueryBuilder } from "./guest";

export type { RegisteredFunction } from "./functions";
export { query, mutation, action, httpAction } from "./functions";

export type { HttpRouter, RouteSpec, RouteEntry } from "./http-router";
export { httpRouter, matchRoute, isReservedHttpPath } from "./http-router";

export type { ExecutorDeps, RunOptions, UdfResult, ComponentContext, ContextProvider, ActionApi, WriteRouter, ClientReplay, DiffableRange, DiffablePage } from "./executor";
export { InlineUdfExecutor, commitThenThrow, CommitThenThrow, committedTsOfError, COMMITTED_TS_ERROR_KEY } from "./executor";

export type { LogKind, ExecutionLogEntry, LogFilter, LogSink } from "./log-sink";
export { InMemoryLogSink, NoopLogSink } from "./log-sink";

export * from "./policy";

export type { GlobalWriteOp } from "./global-txn";
export { GlobalTxn } from "./global-txn";
