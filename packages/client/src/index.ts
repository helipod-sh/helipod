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

// The Gated Ledger (optimistic updates): the writeable store-view contract T5's typed
// `OptimisticLocalStore` extends, the update-closure type, and the typed undelivered rejection.
export type { OptimisticStoreView, OptimisticUpdate } from "./layered-store";
export { MutationUndeliveredError } from "./delivery-policy";

// T5 — the public, typed optimistic-update store (verdict §(b)'s v1 API surface).
export type { OptimisticLocalStore, RefArgs, RefReturn } from "./optimistic-store";
export { createOptimisticLocalStore } from "./optimistic-store";
