/**
 * `@stackbase/executor` — runs user functions through a fully-serializable syscall ABI (the
 * host/guest split), with determinism profiles and an inline (Tier 0) executor. The kernel
 * maintains indexes on writes, so insert-then-query works end to end.
 */
export type { UdfType, CapabilityMode, UdfCapabilities, UdfEnvironmentProfile } from "./profile";
export { QUERY_PROFILE, MUTATION_PROFILE, ACTION_PROFILE, HTTP_ACTION_PROFILE, profileFor } from "./profile";

export type { SeededRandom } from "./seeded-random";
export { createSeededRandom } from "./seeded-random";

export type { KernelContext, SyscallHandler, SyscallChannel } from "./kernel";
export { SyscallRouter, InlineSyscallChannel, createKernelRouter } from "./kernel";

export type { IndexCatalog, TableMeta } from "./catalog";
export { SimpleIndexCatalog } from "./catalog";

export type { DocId, QueryCtx, MutationCtx } from "./guest";
export { GuestDatabaseReader, GuestDatabaseWriter, QueryBuilder } from "./guest";

export type { RegisteredFunction } from "./functions";
export { query, mutation, action } from "./functions";

export type { ExecutorDeps, RunOptions, UdfResult, ComponentContext, ContextProvider } from "./executor";
export { InlineUdfExecutor, commitThenThrow, CommitThenThrow } from "./executor";

export type { LogKind, ExecutionLogEntry, LogFilter, LogSink } from "./log-sink";
export { InMemoryLogSink, NoopLogSink } from "./log-sink";

export * from "./policy";
