/**
 * `@stackbase/client` — the framework-agnostic reactive client: the `api` proxy, transports
 * (loopback + WebSocket), and `StackbaseClient`. React bindings are at `@stackbase/client/react`.
 */
export type { FunctionReference } from "./api";
export { anyApi, getFunctionPath } from "./api";

export type { AnyFunctionReference, FunctionArgs, FunctionReturnType } from "./function-types";

export type { ClientTransport, LoopbackLike } from "./transport";
export { loopbackTransport, webSocketTransport } from "./transport";

export type { QueryListener, QueryErrorListener } from "./client";
export { StackbaseClient } from "./client";

// The Gated Ledger (optimistic updates): the writeable store-view contract T5's typed
// `OptimisticLocalStore` extends, the update-closure type, and the typed undelivered rejection.
export type { OptimisticStoreView, OptimisticUpdate } from "./layered-store";
export { MutationUndeliveredError } from "./delivery-policy";
