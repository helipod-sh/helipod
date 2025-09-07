/**
 * `@stackbase/runtime-embedded` — the Tier 0 engine: composes the full stack into one
 * process, exposes in-memory loopback connections, and drives the swappable write-fan-out
 * seam. The single-binary core.
 */
export type { EmbeddedRuntimeOptions, WriteRouter } from "./runtime";
export { EmbeddedRuntime, createEmbeddedRuntime } from "./runtime";

export type { LoopbackConnection, ServerMessageListener, LoopbackHandler } from "./loopback";
export { createLoopbackConnection } from "./loopback";

export type {
  EmbeddedWriteFanoutPayload,
  EmbeddedWriteFanoutAdapter,
  FanoutListener,
} from "./write-fanout";
export { EmbeddedWriteFanout, InMemoryWriteFanoutAdapter } from "./write-fanout";
