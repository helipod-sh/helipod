/**
 * `@stackbase/client` — the framework-agnostic reactive client: the `api` proxy, transports
 * (loopback + WebSocket), and `StackbaseClient`. React bindings are at `@stackbase/client/react`.
 */
export type { FunctionReference } from "./api";
export { anyApi, getFunctionPath } from "./api";

export type { ClientTransport, LoopbackLike } from "./transport";
export { loopbackTransport, webSocketTransport } from "./transport";

export type { QueryListener } from "./client";
export { StackbaseClient } from "./client";
