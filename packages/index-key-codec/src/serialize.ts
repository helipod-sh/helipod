/**
 * Wire-serializable forms of key ranges and write invalidations. In-memory ranges hold
 * `Uint8Array`s; to cross a process boundary (the transactor→sync pub/sub fan-out,
 * scale-seam #4) they become base64 strings. Foundation uses these even at Tier 0 so the
 * fan-out payload is identical when it later spans processes.
 */
import type { KeyRange } from "./range";

export interface SerializedKeyRange {
  keyspace: string;
  start: string; // base64
  end: string | null; // base64 or null (+∞)
}

/** A committed write's invalidation, in fully serializable form. */
export interface WriteInvalidation {
  /** Tables touched (table-level invalidation — the v1 matcher). */
  tables: readonly string[];
  /** Precise ranges touched (range-level matcher — reserved). */
  ranges: readonly SerializedKeyRange[];
}

/** Exported (DLR 2b) so client-side code (e.g. `@helipod/client`'s range render mode) can decode
 *  an `orderKey` the exact same way the server encoded it via `orderKeyFor` (`commit-differ.ts`,
 *  which itself routes through `serializeKeyRange`/`deserializeKeyRange` — same codec, no drift).
 *  Never hand-roll a second base64 codec; import these instead. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function serializeKeyRange(range: KeyRange): SerializedKeyRange {
  return {
    keyspace: range.keyspace,
    start: bytesToBase64(range.start),
    end: range.end === null ? null : bytesToBase64(range.end),
  };
}

export function deserializeKeyRange(s: SerializedKeyRange): KeyRange {
  return {
    keyspace: s.keyspace,
    start: base64ToBytes(s.start),
    end: s.end === null ? null : base64ToBytes(s.end),
  };
}
