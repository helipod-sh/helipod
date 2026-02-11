/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Consumer watermarks (Tier 3 Slice 5, Task 5.2, design record §6c) — a bucket-wide `consumers/{id}`
 * object per registered consumer (a replica's `ObjectStoreReplicaTailer`, keyed by whatever
 * `consumerId` the caller chooses — e.g. a per-`(replica, shard)` id) carrying the seqno it has
 * durably applied. `ObjectStoreDocStore.gc()` floors its deletion at the SLOWEST published
 * watermark so it never reclaims a segment a lagging replica still needs to tail.
 *
 * Unlike a segment (`putImmutable`, keep-first-immutable) or the manifest (`casManifest`, the fence
 * a WRITER contends on), a watermark is a single value that must be OVERWRITABLE as its owning
 * consumer advances — `putImmutable`'s keep-first semantics (Tier 3 Slice 4 fix) make it unusable
 * here. This module instead does a plain read-etag-then-`casPut` upsert: `get()` the current etag (or
 * `null` if the object doesn't exist yet, which makes the `casPut` create-only), then CAS the new
 * value over it. A watermark is single-writer-per-`consumerId` in the intended usage (one tailer
 * instance publishes its own watermark), so a lost CAS race is expected only from a genuine
 * concurrent writer under the SAME `consumerId` (a misconfiguration, or a brief overlap during a
 * consumer's own restart) — handled with a small bounded retry (re-read, re-CAS) rather than treated
 * as a hard error on the first conflict.
 */
import { isCasConflict, type ObjectStore } from "@stackbase/objectstore";

const CONSUMERS_PREFIX = "consumers/";

function consumerKey(consumerId: string): string {
  return `${CONSUMERS_PREFIX}${consumerId}`;
}

interface WatermarkBody {
  appliedSeqno: number;
}

/** Upsert `consumerId`'s watermark to `appliedSeqno` — overwritable (see module doc), NOT
 *  `putImmutable`. Retries a handful of times on a lost CAS race (re-reading the current etag each
 *  time) before giving up loudly; a genuine single-writer-per-`consumerId` caller should never
 *  exhaust this. */
export async function publishConsumerWatermark(os: ObjectStore, consumerId: string, watermark: { appliedSeqno: number }): Promise<void> {
  const key = consumerKey(consumerId);
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
      `unexpected sustained contention (watermarks are meant to be single-writer-per-consumerId)`,
  );
}

/** List every registered consumer's published watermark. Order is whatever `os.list()` returns
 *  (unspecified) — callers that need `min(appliedSeqno)` (GC) reduce over the whole set anyway. */
export async function readConsumerWatermarks(os: ObjectStore): Promise<{ consumerId: string; appliedSeqno: number }[]> {
  const keys = await os.list(CONSUMERS_PREFIX);
  const out: { consumerId: string; appliedSeqno: number }[] = [];
  for (const key of keys) {
    const entry = await os.get(key);
    if (entry === null) continue; // raced delete between list() and get() — skip, not fatal
    const parsed = JSON.parse(new TextDecoder().decode(entry.body)) as WatermarkBody;
    out.push({ consumerId: key.slice(CONSUMERS_PREFIX.length), appliedSeqno: parsed.appliedSeqno });
  }
  return out;
}

/** Deregister a departing consumer (e.g. a decommissioned replica) so it no longer floors GC. */
export async function removeConsumer(os: ObjectStore, consumerId: string): Promise<void> {
  await os.delete(consumerKey(consumerId));
}
