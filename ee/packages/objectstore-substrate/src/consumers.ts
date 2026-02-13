/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Consumer watermarks (Tier 3 Slice 5, Task 5.2, design record §6c) — a per-shard
 * `s{shard}/consumers/{id}` object per registered consumer (a replica's `ObjectStoreReplicaTailer`,
 * keyed by whatever `consumerId` the caller chooses — e.g. a per-`(replica, shard)` id) carrying the
 * seqno it has durably applied. `ObjectStoreDocStore.gc()` floors its deletion at the SLOWEST
 * published watermark ON ITS OWN SHARD so it never reclaims a segment a lagging replica still needs
 * to tail.
 *
 * SHARD-SCOPED (Finding 2, whole-branch review): keys were originally bucket-global (`consumers/{id}`),
 * but `gc()` is per-shard with per-shard seqno spaces (a seqno on shard "0" and the SAME numeric
 * seqno on shard "1" are unrelated cursors) — a bucket-global watermark set meant a stuck consumer on
 * ANY shard floored GC on EVERY shard, over-retaining bucket-wide instead of just on its own shard.
 * Scoping the key prefix to `s{shard}/consumers/{consumerId}` confines that (already-safe,
 * never-under-retains) over-retention to the shard the lagging consumer is actually on.
 *
 * Unlike a segment (`putImmutable`, keep-first-immutable) or the manifest (`casManifest`, the fence
 * a WRITER contends on), a watermark is a single value that must be OVERWRITABLE as its owning
 * consumer advances — `putImmutable`'s keep-first semantics (Tier 3 Slice 4 fix) make it unusable
 * here. This module instead does a plain read-etag-then-`casPut` upsert: `get()` the current etag (or
 * `null` if the object doesn't exist yet, which makes the `casPut` create-only), then CAS the new
 * value over it. A watermark is single-writer-per-`(shard, consumerId)` in the intended usage (one
 * tailer instance publishes its own watermark), so a lost CAS race is expected only from a genuine
 * concurrent writer under the SAME key (a misconfiguration, or a brief overlap during a consumer's
 * own restart) — handled with a small bounded retry (re-read, re-CAS) rather than treated as a hard
 * error on the first conflict.
 */
import { isCasConflict, type ObjectStore } from "@stackbase/objectstore";

function consumersPrefix(shard: string): string {
  return `s${shard}/consumers/`;
}

function consumerKey(shard: string, consumerId: string): string {
  return `${consumersPrefix(shard)}${consumerId}`;
}

interface WatermarkBody {
  appliedSeqno: number;
}

/** Upsert `consumerId`'s watermark to `appliedSeqno` on `shard` — overwritable (see module doc), NOT
 *  `putImmutable`. Retries a handful of times on a lost CAS race (re-reading the current etag each
 *  time) before giving up loudly; a genuine single-writer-per-`(shard, consumerId)` caller should
 *  never exhaust this. */
export async function publishConsumerWatermark(
  os: ObjectStore,
  shard: string,
  consumerId: string,
  watermark: { appliedSeqno: number },
): Promise<void> {
  const key = consumerKey(shard, consumerId);
  const body = new TextEncoder().encode(JSON.stringify({ appliedSeqno: watermark.appliedSeqno } satisfies WatermarkBody));

  const MAX_ATTEMPTS = 5;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const existing = await os.get(key);
    try {
      await os.casPut(key, body, existing === null ? null : existing.etag);
      return;
    } catch (e) {
      if (!isCasConflict(e)) throw e;
      // Lost the CAS race — someone else (expected: another publish from the same consumer,
      // e.g. an overlapping restart) wrote first. Re-read and retry with the fresh etag.
    }
  }
  throw new Error(
    `objectstore-substrate: publishConsumerWatermark exhausted ${MAX_ATTEMPTS} retries for '${key}' — ` +
      `unexpected sustained contention (watermarks are meant to be single-writer-per-(shard, consumerId))`,
  );
}

/** List every consumer registered on `shard` and its published watermark. Order is whatever
 *  `os.list()` returns (unspecified) — callers that need `min(appliedSeqno)` (GC) reduce over the
 *  whole set anyway. */
export async function readConsumerWatermarks(os: ObjectStore, shard: string): Promise<{ consumerId: string; appliedSeqno: number }[]> {
  const prefix = consumersPrefix(shard);
  const keys = await os.list(prefix);
  const out: { consumerId: string; appliedSeqno: number }[] = [];
  for (const key of keys) {
    const entry = await os.get(key);
    if (entry === null) continue; // raced delete between list() and get() — skip, not fatal
    const parsed = JSON.parse(new TextDecoder().decode(entry.body)) as WatermarkBody;
    out.push({ consumerId: key.slice(prefix.length), appliedSeqno: parsed.appliedSeqno });
  }
  return out;
}

/** Deregister a departing consumer (e.g. a decommissioned replica) on `shard` so it no longer floors
 *  that shard's GC. */
export async function removeConsumer(os: ObjectStore, shard: string, consumerId: string): Promise<void> {
  await os.delete(consumerKey(shard, consumerId));
}
