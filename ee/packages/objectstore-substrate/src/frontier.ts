/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Cross-shard frontier (Tier 3 Slice 5, Task 5.1, design record §8) — the object-storage analog of
 * the shipped fleet `ReplicaTailer.readFrontier`'s `min(shard_leases.frontier_ts)` — but read
 * straight from each shard's own manifest object instead of a shared Postgres table, since object
 * storage has no cross-shard row to `min()` over server-side.
 *
 * `F = min(manifest.frontierTs)` over every shard in `shards` is the dense prefix the WHOLE fleet has
 * durably committed: a caller may treat state up to `F` as fully replicated everywhere. Mirrors the
 * fleet's partial-lease-set guard (`count < numShards` → not-ready): a shard whose manifest doesn't
 * exist yet (never `open()`'d/initialized) makes the WHOLE frontier `0n`, not merely excluded from the
 * min — a half-initialized fleet must not let the present shards' min fake readiness.
 *
 * Pure read helper: it does not track/assert monotonicity itself (unlike the fleet tailer's own
 * internal `readFrontier`, which owns a `lastF` cache) — a caller that needs the monotone-assertion
 * belt-and-braces should track its own last-observed value and compare across calls, mirroring
 * `ReplicaTailer`'s `lastF` if it wants that defense-in-depth.
 */
import type { ObjectStore } from "@stackbase/objectstore";
import { readManifest } from "./manifest";

/** `min(frontierTs)` over every shard's manifest — `0n` if any shard's manifest is absent (a
 *  partial/not-yet-initialized shard set, the same F1×N hole guard the fleet tailer applies). A
 *  single-shard replica passes `[shard]`; an empty `shards` array also returns `0n` (vacuously
 *  "nothing is ready" rather than a vacuous `+Infinity`-derived value). */
export async function readGlobalFrontier(os: ObjectStore, shards: readonly string[]): Promise<bigint> {
  if (shards.length === 0) return 0n;
  let min: bigint | null = null;
  for (const shard of shards) {
    const entry = await readManifest(os, shard);
    if (entry === null) return 0n; // partial/absent manifest set — not ready
    const ts = BigInt(entry.manifest.frontierTs);
    if (min === null || ts < min) min = ts;
  }
  return min!;
}
