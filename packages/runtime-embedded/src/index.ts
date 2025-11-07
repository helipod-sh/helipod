/**
 * `@stackbase/runtime-embedded` — the Tier 0 engine: composes the full stack into one
 * process, exposes in-memory loopback connections, and drives the swappable write-fan-out
 * seam. The single-binary core.
 */
export type { EmbeddedRuntimeOptions, WriteRouter, ClientReplay } from "./runtime";
export { EmbeddedRuntime, createEmbeddedRuntime } from "./runtime";

// The exactly-once client-mutation receipts guard. Exported so a fleet node (`ee/fleet`) that boots
// with `externalReceiptsGuard` can install it on the CONCRETE write store in `armWriter` (before the
// epoch fence), rather than on the promotion-swapped `SwitchableDocStore` the runtime would register it
// on. See `EmbeddedRuntimeOptions.externalReceiptsGuard`.
export { clientReceiptsGuard } from "./client-dedup";

export type { LoopbackConnection, ServerMessageListener, LoopbackHandler } from "./loopback";
export { createLoopbackConnection } from "./loopback";

export type {
  EmbeddedWriteFanoutPayload,
  EmbeddedWriteFanoutAdapter,
  FanoutListener,
} from "./write-fanout";
export { EmbeddedWriteFanout, InMemoryWriteFanoutAdapter } from "./write-fanout";
