/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * `@stackbase/runtime-cloudflare-shard` — the MULTI-SHARD Cloudflare Durable Object front (Slice 6,
 * Milestone 1: `.shardBy(key)` write scale-out). A paid-tier (ee/) SIBLING of `ee/fleet`: this is the
 * Cloudflare-native analog of the portable multi-node scale-out. It routes each request to the owning
 * shard-DO by the shard key (CF's `getByName(shardKey)` model — the DO NAME is the shard key, no shard
 * map, no coordinator), and each shard-DO is an UNMODIFIED `StackbaseDurableObject` from the FREE
 * `@stackbase/runtime-cloudflare` package. N distinct keys ⇒ N distinct DOs ⇒ N× write throughput +
 * N×10 GB storage. No engine change: M1 is pure routing over independent Slice-3 hosts.
 *
 * NON-GOALS (M1, enforced not silently broken): a reactive query/mutation spanning MULTIPLE shards, and
 * cross-shard global-unique — both rejected with a typed `CROSS_SHARD_UNSUPPORTED`. `.global()`/D1 and
 * the opt-in non-reactive fan-out read are Milestone 2.
 */
export const RUNTIME_CLOUDFLARE_SHARD_VERSION = "0.0.0";

export { createShardWorkerHandler, DEFAULT_SHARD_NAME } from "./worker";
export { resolveShard, type ShardRoutingOptions, type ShardResolution } from "./route";
export { shardDoName, DEFAULT_SHARD_DO_NAME, type ShardRoutingMode } from "./canonical";
export {
  SHARD_KEY_REQUIRED,
  CROSS_SHARD_UNSUPPORTED,
  INVALID_REGION_HINT,
  routingError,
  type ShardRoutingErrorCode,
  type ShardRoutingErrorBody,
} from "./errors";
export {
  deriveLocationHint,
  continentToHint,
  CONTINENT_TO_HINT,
  type HintDerivation,
  type DeriveLocationHintInput,
} from "./location";
export { generateShardWorkerEntrySource, type ShardWorkerEntryInputs } from "./worker-entry";

// Re-export the FREE DO host class so an app imports ONE package at its Worker entry. This is a plain
// re-export of the free class — the multi-shard host is the SAME DO, addressed N times by the router.
export { StackbaseDurableObject, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";
