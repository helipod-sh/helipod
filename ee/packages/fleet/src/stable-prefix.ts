/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `StablePrefixTs` (Fenced Frontier B1, D6) — a compile-time brand over `bigint` marking a
 * timestamp as a member of the FENCED FRONTIER: the stable prefix of the primary's MVCC log that
 * `ReplicaTailer` is allowed to pull from, per D5. A raw `bigint` (e.g. `primary.maxTimestamp()`,
 * which reports the log's live high-water mark INCLUDING any commit that raced past the last fence
 * check) is NOT a `StablePrefixTs` — only a value read straight off `shard_leases.frontier_ts`, or
 * a watermark previously derived from one, is.
 *
 * This is deliberately narrow: it brands ONLY `ReplicaTailer`'s internal pull target (`F`) and its
 * own watermark (`wm`), which must never advance past `F` (D5's "wm never exceeds F" invariant).
 * It does NOT brand `waitFor`'s public `ts` parameter — that's a caller-supplied `commitTs` (a raw
 * log position by nature, e.g. forwarded from `WriteForwarder`'s `/_fleet/run` response), and RYOW
 * correctness only needs `wm >= ts`, which is a plain bigint comparison regardless of which side is
 * branded. Branding that parameter too would just force every call site to launder a raw commitTs
 * through the constructor for no safety benefit.
 *
 * The sole constructor, `stablePrefixFromFrontier`, is intentionally the ONLY way to produce one —
 * assigning a raw `bigint` to a `StablePrefixTs`-typed binding without going through it is a
 * compile error (see `replica-tailer.test.ts`'s `@ts-expect-error` cases). At runtime this is a
 * plain `bigint`; the brand (`__stablePrefix`) exists purely in the type system and costs nothing.
 */
export type StablePrefixTs = bigint & { readonly __stablePrefix: unique symbol };

/**
 * The sole constructor. Call this ONLY where a value is actually a frontier — a fresh read of
 * `shard_leases.frontier_ts` (via the tailer's `CommitChannelClient`), or a watermark already
 * derived from a prior `StablePrefixTs` (e.g. the replica's own persisted `maxTimestamp()` on
 * restart, which IS this node's last-applied frontier). Do not use this to launder an arbitrary
 * `bigint` (e.g. `primary.maxTimestamp()`, or a document's raw `ts`) into the brand — that value is
 * NOT guaranteed to be a durably-fenced, dense prefix and defeats the whole point of the type.
 */
export function stablePrefixFromFrontier(raw: bigint): StablePrefixTs {
  return raw as StablePrefixTs;
}
