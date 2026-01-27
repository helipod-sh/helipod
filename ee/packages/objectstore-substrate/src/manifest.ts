/**
 * Manifest helpers (Tier 3 Slice 2, design record §5/§7) — the per-shard pointer object
 * (`s{shard}/manifest`) that names the segment chain and the commit frontier. It is the object the
 * commit path CAS's on (`casPut`), so it is the fencing/linearization point for `ObjectStoreDocStore`.
 *
 * `tsCounter` (mirrors `frontierTs` today — Slice 2 has no group-commit-ahead-of-frontier gap yet) is
 * the MONOTONE field the seam doc calls for: a real `ObjectStore`'s etag is content-derived, so an
 * A→B→A content sequence could reuse an etag (ABA) — a manifest that never repeats its content (because
 * this field strictly increases every successful CAS) closes that hole.
 */
import type { ObjectStore } from "@stackbase/objectstore";

/** The per-shard commit pointer. `frontierTs`/`tsCounter` are decimal-string bigints (JSON has no
 *  native bigint) — the highest committed timestamp and the monotone CAS-content counter, respectively.
 *  `segments` is the dense `seqno` chain (`[0, 1, 2, …]`) of `s{shard}/seg/{seqno}` objects, in order. */
export interface Manifest {
  epoch: number;
  frontierTs: string;
  tsCounter: string;
  segments: number[];
}

function manifestKey(shard: string): string {
  return `s${shard}/manifest`;
}

/** The seeded manifest a fresh shard's `createManifest` writes: no commits yet. */
function emptyManifest(): Manifest {
  return { epoch: 0, frontierTs: "0", tsCounter: "0", segments: [] };
}

/** Read the shard's current manifest + its etag (for a follow-up `casManifest`), or `null` if the
 *  shard has never been initialized (no manifest object yet — call `createManifest` first). */
export async function readManifest(os: ObjectStore, shard: string): Promise<{ manifest: Manifest; etag: string } | null> {
  const entry = await os.get(manifestKey(shard));
  if (entry === null) return null;
  const manifest = JSON.parse(new TextDecoder().decode(entry.body)) as Manifest;
  return { manifest, etag: entry.etag };
}

/** Create-only initialization of a shard's manifest (`casPut` with `ifMatch: null`). Throws
 *  `CasConflict` (via `@stackbase/objectstore`'s `isCasConflict`) if the manifest already exists —
 *  callers racing to initialize the same shard must treat that as "someone else already did it" and
 *  `readManifest` instead. */
export async function createManifest(os: ObjectStore, shard: string): Promise<{ manifest: Manifest; etag: string }> {
  const manifest = emptyManifest();
  const { etag } = await os.casPut(manifestKey(shard), new TextEncoder().encode(JSON.stringify(manifest)), null);
  return { manifest, etag };
}

/** Compare-and-swap the shard's manifest to `next`, conditional on `ifMatch` still being the current
 *  etag. Throws `CasConflict` (see `isCasConflict`) if another committer's manifest write already moved
 *  the etag — the caller (the commit path) must treat this as a fence: nothing else may be applied. */
export async function casManifest(
  os: ObjectStore,
  shard: string,
  next: Manifest,
  ifMatch: string,
): Promise<{ etag: string }> {
  return os.casPut(manifestKey(shard), new TextEncoder().encode(JSON.stringify(next)), ifMatch);
}
