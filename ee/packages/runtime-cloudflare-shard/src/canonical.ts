/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */

/**
 * Map a shard-key VALUE to the Durable Object NAME that owns its shard. Two routing modes (spec §1.1),
 * both deterministic and both reusing the engine's OWN canonicalization so a key routes identically
 * however it arrives (a raw `1` number vs the string `"1"` route to distinct DOs, exactly as they land
 * in distinct shards on the portable path):
 *
 *   - **mode "key" (A, default)** — one DO per distinct shard-key value. `getByName(canonicalName)`.
 *     No fixed shard count, no reshard, no shard map: a new key just addresses a new DO forever. This
 *     is Lunora's model and the CF-idiomatic default (§1.1, §5.2). The name is a collision-safe encoding
 *     of the value (index-key bytes → hex), never the raw value, so no app key can ever alias the
 *     reserved `"default"` DO or smuggle control characters into a DO name.
 *
 *   - **mode "hash" (B)** — fixed-N jump-consistent-hash, reusing `shardIdForKeyValue` from
 *     `@stackbase/id-codec` VERBATIM. The DO name is the SAME `ShardId` string the portable path uses
 *     (`"default"`/`"s1"`/…), so an app's key→shard identity is byte-identical across the portable and
 *     DO hosts (important for a future migration tool, §7 #7). Cost: growing N needs an offline reshard.
 *
 * The DO name is a pure function of the value + mode; the Worker holds no shard map.
 */
import { shardIdForKeyValue, DEFAULT_SHARD } from "@stackbase/id-codec";
import { encodeIndexKey, type IndexableValue } from "@stackbase/index-key-codec";

/** The DO name for unsharded tables / no-`shardBy` requests — byte-identical to Slice 3's single DO. */
export const DEFAULT_SHARD_DO_NAME = DEFAULT_SHARD; // "default"

export type ShardRoutingMode = "key" | "hash";

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Resolve a shard-key value to its owning DO name.
 *
 * @param value    the shard-key value extracted from the request (a scalar the engine can index).
 * @param mode     routing mode; "key" (default) or "hash".
 * @param numShards for mode "hash" only: the fixed shard count N (≥ 1). Ignored in mode "key".
 */
export function shardDoName(value: unknown, mode: ShardRoutingMode = "key", numShards = 1): string {
  if (mode === "hash") {
    // Byte-identical to the portable path: returns "default" | "s1" | … .
    return shardIdForKeyValue(value, Math.max(1, numShards));
  }
  // mode "key": collision-safe per-value name. `s.` prefix guarantees it can NEVER equal "default".
  const bytes = encodeIndexKey([value as IndexableValue]);
  return `s.${toHex(bytes)}`;
}
