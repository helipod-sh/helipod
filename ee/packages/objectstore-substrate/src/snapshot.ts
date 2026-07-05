/**
 * The snapshot codec + object helpers (Tier 3 Slice 3, design record §6b, Task 3.1) — a snapshot
 * `s{shard}/snap/{ts}` is a materialized image of a shard's CURRENT state at `frontierTs = ts`: the
 * current (non-tombstone) revision of every live document at its REAL `ts`/`prev_ts`, plus the
 * current row of every index entry. Produced by `SqliteDocStore.dumpCurrentState()` and restored via
 * the SAME `write(..., "Overwrite")` primitive segments use — see that method's doc comment.
 *
 * The wire codec deliberately REUSES `segment.ts`'s per-row `DocumentLogEntry`/`IndexWrite`
 * bigint/base64/`Value` tagging (`encodeDocumentLogEntries`/`decodeDocumentLogEntries`/
 * `encodeIndexWrites`/`decodeIndexWrites`) rather than duplicating it — a snapshot's `documents`/
 * `indexUpdates` are the exact same row shapes a segment carries; only the envelope (`frontierTs`/
 * `segBase` instead of none) differs.
 */
import type { ObjectStore } from "@helipod/objectstore";
import type { DocumentLogEntry, IndexWrite } from "@helipod/docstore";
import {
  encodeDocumentLogEntries,
  decodeDocumentLogEntries,
  encodeIndexWrites,
  decodeIndexWrites,
  type WireDocumentLogEntry,
  type WireIndexWrite,
} from "./segment";

/** A snapshot's payload — the CURRENT state of a shard's local store at `frontierTs`, covering
 *  every committed segment up to and including seqno `segBase` (bootstrap replays only segments
 *  with seqno > `segBase` after restoring this). `documents`/`indexUpdates` are the same
 *  `DocumentLogEntry`/`IndexWrite` rows `SqliteDocStore.dumpCurrentState()` returns — real `ts`/
 *  `prev_ts`, not renumbered. */
export interface SnapshotPayload {
  frontierTs: string;
  segBase: number;
  documents: DocumentLogEntry[];
  indexUpdates: IndexWrite[];
}

interface WireSnapshotPayload {
  frontierTs: string;
  segBase: number;
  documents: WireDocumentLogEntry[];
  indexUpdates: WireIndexWrite[];
}

/** Encode a snapshot's payload to bytes (UTF-8 JSON) for `ObjectStore.putImmutable`. */
export function encodeSnapshot(payload: SnapshotPayload): Uint8Array {
  const wire: WireSnapshotPayload = {
    frontierTs: payload.frontierTs,
    segBase: payload.segBase,
    documents: encodeDocumentLogEntries(payload.documents),
    indexUpdates: encodeIndexWrites(payload.indexUpdates),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

/** Decode snapshot bytes (as read from `ObjectStore.get`) back to `SnapshotPayload`. Inverse of
 *  {@link encodeSnapshot} — round-trips bigints and byte arrays exactly, same as `decodeSegment`. */
export function decodeSnapshot(bytes: Uint8Array): SnapshotPayload {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as WireSnapshotPayload;
  return {
    frontierTs: wire.frontierTs,
    segBase: wire.segBase,
    documents: decodeDocumentLogEntries(wire.documents),
    indexUpdates: decodeIndexWrites(wire.indexUpdates),
  };
}

/** The object key a shard's snapshot at `ts` (a decimal-string `frontierTs`, matching the manifest's
 *  own string-bigint convention) lives at — `s{shard}/snap/{ts}`, parallel to `segmentKey`'s
 *  `s{shard}/seg/{seqno}` in `object-doc-store.ts`. */
export function snapshotKey(shard: string, ts: string): string {
  return `s${shard}/snap/${ts}`;
}

/** Write a snapshot object (immutable — one snapshot per `frontierTs`, never overwritten). Callers
 *  write the snapshot object FIRST, then CAS the manifest to reference it (Task 3.2) — never the
 *  reverse, so the manifest can never point at an absent snapshot (the same torn-forward discipline
 *  segments follow). */
export async function writeSnapshot(os: ObjectStore, shard: string, payload: SnapshotPayload): Promise<void> {
  await os.putImmutable(snapshotKey(shard, payload.frontierTs), encodeSnapshot(payload));
}

/** Read + decode a shard's snapshot at `ts`, or `null` if no such snapshot object exists. */
export async function readSnapshot(os: ObjectStore, shard: string, ts: string): Promise<SnapshotPayload | null> {
  const entry = await os.get(snapshotKey(shard, ts));
  if (entry === null) return null;
  return decodeSnapshot(entry.body);
}
