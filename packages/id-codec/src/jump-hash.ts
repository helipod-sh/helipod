/**
 * Jump consistent hash (Lamping & Veach, 2014) + the concrete `ShardRouter` built on it.
 *
 * The routing seam (`./shard.ts`) declares WHAT a router does; this file is HOW B2a does it:
 * a shard-key value is canonicalized to bytes the way the engine already canonicalizes index
 * keys (`encodeIndexKey` from `@stackbase/index-key-codec` — never a hand-rolled encoding, so
 * a `1` routes the same whether it arrives as an arg or is read back off a document), hashed to
 * a 64-bit key, and mapped to a bucket in `[0, numShards)` by jump consistent hash. Slot 0 is
 * the reserved `"default"` shard (unsharded tables + no-`shardBy` mutations); slot k>0 is `"s"+k`.
 *
 * Jump consistent hash is chosen for its movement-minimality: growing the bucket count from n to
 * n' only ever moves a key to one of the NEW buckets `[n, n')`, never reshuffles a key among the
 * old buckets — the property B5's offline resharding tool leans on.
 */
import { encodeIndexKey, type IndexableValue } from "@stackbase/index-key-codec";
import { DEFAULT_SHARD, type ShardId, type ShardKey } from "./shard";
import type { ShardRouter } from "./shard";

const U64_MASK = 0xffffffffffffffffn;
/** 64-bit LCG multiplier from the reference jump-hash implementation. */
const LCG_MULT = 2862933555777941757n;

/**
 * Map a 64-bit `key` to a bucket in `[0, buckets)`. The reference ~10-line algorithm: walk a
 * pseudo-random sequence of "jump" points, keeping the last one that lands below `buckets`.
 * Deterministic and allocation-free; `buckets` must be ≥ 1.
 */
export function jumpConsistentHash(key: bigint, buckets: number): number {
  if (buckets < 1) throw new RangeError(`buckets must be >= 1, got ${buckets}`);
  let k = BigInt.asUintN(64, key);
  let b = -1n;
  let j = 0n;
  const n = BigInt(buckets);
  while (j < n) {
    b = j;
    k = (k * LCG_MULT + 1n) & U64_MASK;
    // j = floor((b + 1) * (2^31 / ((k >> 33) + 1)))
    const denom = Number(k >> 33n) + 1;
    j = BigInt(Math.floor((Number(b) + 1) * (0x80000000 / denom)));
  }
  return Number(b);
}

/** FNV-1a 64-bit hash of a byte string → a well-mixed 64-bit key for `jumpConsistentHash`. */
function fnv1a64(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < bytes.length; i++) {
    h ^= BigInt(bytes[i]!);
    h = (h * 0x100000001b3n) & U64_MASK;
  }
  return h;
}

/**
 * Resolve a shard-key VALUE (a scalar: string/number/bigint/boolean/null/bytes) to its shard id
 * under `numShards`. Canonicalizes via the engine's own index-key encoding so routing is stable
 * across the arg → route and document → route paths. Slot 0 → `"default"`, slot k → `"s"+k`.
 */
export function shardIdForKeyValue(value: unknown, numShards: number): ShardId {
  const bytes = encodeIndexKey([value as IndexableValue]);
  const slot = jumpConsistentHash(fnv1a64(bytes), Math.max(1, numShards));
  return slot === 0 ? DEFAULT_SHARD : `s${slot}`;
}

/**
 * The B2a `ShardRouter`: jump-consistent-hash routing over `numShards` shards. Single-node, so
 * every client resolves to one local sync node. `getShardForKey`/`getShardForDocument` take the
 * already-extracted shard-key value (a string, per the seam); `shardIdForKeyValue` is the
 * value-typed entry point the executor and kernel call directly with the raw arg/field value.
 */
export class JumpShardRouter implements ShardRouter {
  constructor(private readonly numShards: number) {
    if (numShards < 1) throw new RangeError(`numShards must be >= 1, got ${numShards}`);
  }

  getShardForKey(shardKey: ShardKey | null): ShardId {
    return shardKey === null ? DEFAULT_SHARD : shardIdForKeyValue(shardKey, this.numShards);
  }

  getShardForDocument(_table: string, shardKey: ShardKey | null): ShardId {
    return this.getShardForKey(shardKey);
  }

  getSyncNodeId(_clientId: string): string {
    return "local";
  }
}
