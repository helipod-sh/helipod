/**
 * The segment codec (Tier 3 Slice 2, design record §5) — a segment is one immutable object
 * (`s{shard}/seg/{seqno}`) holding a batch's worth of `DocumentLogEntry`/`IndexWrite` rows, JSON-encoded
 * so it survives any `ObjectStore` byte-string backend unchanged.
 *
 * JSON has no native `bigint`/`Uint8Array`, so the wire form tags them explicitly:
 *   - `bigint` (ts/prev_ts)      → decimal string
 *   - `Uint8Array` (id bytes, index keys) → base64
 * A document's own field VALUES (`ResolvedDocument.value`, a `Record<string, Value>`) reuse
 * `@helipod/values`' existing `convexToJson`/`jsonToConvex` — the same tagged-JSON transport the rest
 * of the engine already round-trips `Value` (including nested `bigint`/`ArrayBuffer`) through.
 */
import { convexToJson, jsonToConvex, type JSONValue } from "@helipod/values";
import type {
  DatabaseIndexUpdate,
  DatabaseIndexValue,
  DocumentLogEntry,
  IndexWrite,
  InternalDocumentId,
  ResolvedDocument,
} from "@helipod/docstore";

/** One segment's worth of staged rows — the unit `encodeSegment`/`decodeSegment` round-trip. */
export interface SegmentPayload {
  documents: DocumentLogEntry[];
  indexUpdates: IndexWrite[];
}

/* --- base64 (portable: global btoa/atob, no Node Buffer — matches @helipod/values' json.ts) --- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* --- wire (JSON-safe) shapes --- */

interface WireInternalDocumentId {
  tableNumber: number;
  internalId: string; // base64
}

interface WireResolvedDocument {
  id: WireInternalDocumentId;
  value: JSONValue;
}

// Exported (not just `SegmentPayload`-internal) so `snapshot.ts` can build a `WireSnapshotPayload`
// out of the SAME per-row wire shapes — see `encodeDocumentLogEntries`/`encodeIndexWrites` below.
export interface WireDocumentLogEntry {
  ts: string; // decimal bigint
  id: WireInternalDocumentId;
  value: WireResolvedDocument | null; // null preserved verbatim (tombstone)
  prev_ts: string | null; // decimal bigint, or null
}

type WireDatabaseIndexValue = { type: "Deleted" } | { type: "NonClustered"; docId: WireInternalDocumentId };

interface WireDatabaseIndexUpdate {
  indexId: string;
  key: string; // base64
  value: WireDatabaseIndexValue;
}

export interface WireIndexWrite {
  ts: string; // decimal bigint
  update: WireDatabaseIndexUpdate;
}

interface WireSegmentPayload {
  documents: WireDocumentLogEntry[];
  indexUpdates: WireIndexWrite[];
}

function encodeId(id: InternalDocumentId): WireInternalDocumentId {
  return { tableNumber: id.tableNumber, internalId: bytesToBase64(id.internalId) };
}

function decodeId(id: WireInternalDocumentId): InternalDocumentId {
  return { tableNumber: id.tableNumber, internalId: base64ToBytes(id.internalId) };
}

function encodeResolvedDocument(doc: ResolvedDocument): WireResolvedDocument {
  return { id: encodeId(doc.id), value: convexToJson(doc.value) };
}

function decodeResolvedDocument(doc: WireResolvedDocument): ResolvedDocument {
  // DocumentValue is a Record<string, Value> — jsonToConvex(object JSON) always returns an object.
  return { id: decodeId(doc.id), value: jsonToConvex(doc.value) as ResolvedDocument["value"] };
}

function encodeDocumentLogEntry(entry: DocumentLogEntry): WireDocumentLogEntry {
  return {
    ts: entry.ts.toString(),
    id: encodeId(entry.id),
    value: entry.value === null ? null : encodeResolvedDocument(entry.value),
    prev_ts: entry.prev_ts === null ? null : entry.prev_ts.toString(),
  };
}

function decodeDocumentLogEntry(entry: WireDocumentLogEntry): DocumentLogEntry {
  return {
    ts: BigInt(entry.ts),
    id: decodeId(entry.id),
    value: entry.value === null ? null : decodeResolvedDocument(entry.value),
    prev_ts: entry.prev_ts === null ? null : BigInt(entry.prev_ts),
  };
}

function encodeIndexValue(value: DatabaseIndexValue): WireDatabaseIndexValue {
  return value.type === "Deleted" ? { type: "Deleted" } : { type: "NonClustered", docId: encodeId(value.docId) };
}

function decodeIndexValue(value: WireDatabaseIndexValue): DatabaseIndexValue {
  return value.type === "Deleted" ? { type: "Deleted" } : { type: "NonClustered", docId: decodeId(value.docId) };
}

function encodeIndexUpdate(update: DatabaseIndexUpdate): WireDatabaseIndexUpdate {
  return { indexId: update.indexId, key: bytesToBase64(update.key), value: encodeIndexValue(update.value) };
}

function decodeIndexUpdate(update: WireDatabaseIndexUpdate): DatabaseIndexUpdate {
  return { indexId: update.indexId, key: base64ToBytes(update.key), value: decodeIndexValue(update.value) };
}

function encodeIndexWrite(write: IndexWrite): WireIndexWrite {
  return { ts: write.ts.toString(), update: encodeIndexUpdate(write.update) };
}

function decodeIndexWrite(write: WireIndexWrite): IndexWrite {
  return { ts: BigInt(write.ts), update: decodeIndexUpdate(write.update) };
}

/** Row-array wrappers around the single-row codecs above — exported so `snapshot.ts` can build a
 *  `WireSnapshotPayload` (which carries the SAME `documents`/`indexUpdates` wire arrays plus its own
 *  `frontierTs`/`segBase` fields) out of these directly, instead of duplicating the per-row
 *  bigint/base64/`Value` tagging logic. `encodeSegment`/`decodeSegment` below are themselves just
 *  these applied to a bare `{documents, indexUpdates}` envelope. */
export function encodeDocumentLogEntries(documents: readonly DocumentLogEntry[]): WireDocumentLogEntry[] {
  return documents.map(encodeDocumentLogEntry);
}
export function decodeDocumentLogEntries(wire: readonly WireDocumentLogEntry[]): DocumentLogEntry[] {
  return wire.map(decodeDocumentLogEntry);
}
export function encodeIndexWrites(writes: readonly IndexWrite[]): WireIndexWrite[] {
  return writes.map(encodeIndexWrite);
}
export function decodeIndexWrites(wire: readonly WireIndexWrite[]): IndexWrite[] {
  return wire.map(decodeIndexWrite);
}

/** Encode a segment's rows to bytes (UTF-8 JSON) for `ObjectStore.putImmutable`. */
export function encodeSegment(payload: SegmentPayload): Uint8Array {
  const wire: WireSegmentPayload = {
    documents: encodeDocumentLogEntries(payload.documents),
    indexUpdates: encodeIndexWrites(payload.indexUpdates),
  };
  return new TextEncoder().encode(JSON.stringify(wire));
}

/** Decode segment bytes (as read from `ObjectStore.get`) back to `SegmentPayload`. Inverse of
 *  {@link encodeSegment} — round-trips bigints and byte arrays exactly. */
export function decodeSegment(bytes: Uint8Array): SegmentPayload {
  const wire = JSON.parse(new TextDecoder().decode(bytes)) as WireSegmentPayload;
  return {
    documents: decodeDocumentLogEntries(wire.documents),
    indexUpdates: decodeIndexWrites(wire.indexUpdates),
  };
}
