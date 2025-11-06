/**
 * `@stackbase/sync` — the reactive sync tier: the version-bracketed protocol, the
 * subscription manager (table-level invalidation), the protocol handler that pushes reactive
 * transitions, and the client reducer. Talks only to abstract `SyncWebSocket`/`SyncUdfExecutor`
 * so it runs in-process at Tier 0 or as a fleet node at Tier 2.
 */
export type {
  StateVersion,
  QueryRequest,
  ClientMessage,
  StateModification,
  ServerMessage,
  ClientMutationRef,
  MutationBatchEntry,
  ClientMutationVerdict,
} from "./protocol";
export {
  INITIAL_VERSION,
  versionsEqual,
  compareStateVersion,
  isContiguous,
  parseClientMessage,
  encodeServerMessage,
} from "./protocol";

export type { MatchMode, Subscription } from "./subscription-manager";
export { SubscriptionManager } from "./subscription-manager";

export type {
  SyncWebSocket,
  SyncUdfExecutor,
  WriteInvalidation,
  SyncProtocolHandlerOptions,
  MutationRan,
  MutationReplay,
  RunMutationResult,
} from "./handler";
export { SyncProtocolHandler } from "./handler";

export type { BackpressureOptions, HeartbeatOptions } from "./session-controllers";
export { SessionBackpressureController, SessionHeartbeatController } from "./session-controllers";

export type { SyncClientState, MutationOutcome } from "./client-reducer";
export { createClientState, applyServerMessage } from "./client-reducer";
