/**
 * `@stackbase/client` — the framework-agnostic reactive client: the `api` proxy, transports
 * (loopback + WebSocket), and `StackbaseClient`. React bindings are at `@stackbase/client/react`.
 */
export type { FunctionReference, AnyFunctionRef } from "./api";
export { anyApi, getFunctionPath } from "./api";

export type { AnyFunctionReference, FunctionArgs, FunctionReturnType } from "./function-types";

export type { ClientTransport, LoopbackLike, WebSocketTransportOptions } from "./transport";
export { loopbackTransport, webSocketTransport, reconnectDelayMs } from "./transport";

export type { QueryListener, QueryErrorListener } from "./client";
export { StackbaseClient } from "./client";

// T5 — the durable-outbox registry, R9 observability (verdict §(d) "Observability").
export type { MutationFailedInfo, OutboxBroadcastLike, OutboxBroadcastMessage, PendingMutationEntry, PendingSummary } from "./client";

// The Gated Ledger (optimistic updates): the writeable store-view contract T5's typed
// `OptimisticLocalStore` extends, the update-closure type, and the typed undelivered rejection.
export type { OptimisticStoreView, OptimisticUpdate } from "./layered-store";
export { MutationUndeliveredError } from "./delivery-policy";

// T5 — the public, typed optimistic-update store (verdict §(b)'s v1 API surface), plus the
// durable-outbox `optimisticUpdates` registry's updater shape (spec §(k)6).
export type { OptimisticLocalStore, OptimisticUpdateFn, RefArgs, RefReturn } from "./optimistic-store";
export { createOptimisticLocalStore } from "./optimistic-store";

// The durable-offline `OutboxStorage` seam (verdict §(d)): the interface, the in-memory default,
// and the probe-and-fallback IndexedDB adapter. `mintIdentity` is exported mainly for direct
// testing of the identity model — app code configures `outbox` at client construction and never
// calls it itself.
export type { HydrateResult, IndexedDBOutboxOptions, OutboxEntry, OutboxEntryError, OutboxEntryStatus, OutboxMeta, OutboxStorage } from "./outbox-storage";
export { DEFAULT_OUTBOX_MAX_QUEUE_SIZE, OUTBOX_VERSION, OfflineClientResetError, OutboxOverflowError, defaultMintClientId, indexedDBOutbox, memoryOutbox, mintIdentity } from "./outbox-storage";
export type { ClientResetInfo } from "./client";

// Task 4 — the drain: the poison policy, the Web Locks seam (fake-able), and the backoff mirror.
export type { DrainHost, OutboxDrainOptions, OutboxLockManager, PoisonPolicy } from "./outbox-drain";
export { DEFAULT_DRAIN_CHUNK_SIZE, DEFAULT_DRAIN_INTERVAL_MS, OFFLINE_IDENTITY_CHANGED, OutboxDrain, computeDrainBackoff } from "./outbox-drain";

/** Untyped core of client-side id minting — prefer the codegen-typed `mintId` from your app's
 *  `_generated/ids`. Exists for hosts without codegen output at hand. */
export { mintEncodedDocumentId as mintDocumentId } from "@stackbase/id-codec";
