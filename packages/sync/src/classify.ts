/**
 * Classify a subscription as DIFFABLE_BYID (a single `db.get(id)`) vs RERUN, from its recorded read
 * set + result. A by-id read records EXACTLY one point range in a table's primary keyspace
 * (`table:<enc>`, NOT `index:...`), and returns a single document object or `null`. Anything else —
 * multiple ranges, an index/collect read, a span range, an array result — is RERUN (safe fallback).
 */
import type { Value } from "@stackbase/values";
import { deserializeKeyRange, keySuccessor, compareKeyBytes, type SerializedKeyRange } from "@stackbase/index-key-codec";

export interface ByIdRead {
  keyspace: string;
  /** base64 of the point-range start bytes (== the doc's primary-key bytes). */
  key: string;
  /** the public document id (the diff Change.key), taken from the returned doc's `_id`. */
  docId: string;
}

function isPointRange(r: SerializedKeyRange): boolean {
  if (!r.keyspace.startsWith("table:")) return false;
  if (r.end === null) return false;
  const { start, end } = deserializeKeyRange(r);
  if (end === null) return false;
  const succ = keySuccessor(start);
  return compareKeyBytes(end, succ) === 0; // end === start followed by 0x00 => a single-key point range
}

/** A single doc object (has a string `_id`) — not an array, not null-here. */
function singleDocId(value: Value): string | null {
  if (value === null || value === undefined) return "";       // absent doc — still by-id, docId unknown-but-empty
  if (Array.isArray(value)) return null;
  if (typeof value === "object") {
    const id = (value as Record<string, unknown>)["_id"];
    return typeof id === "string" ? id : null;
  }
  return null;
}

export function classifyByIdRead(value: Value, readRanges: readonly SerializedKeyRange[]): ByIdRead | null {
  if (readRanges.length !== 1) return null;
  const r = readRanges[0]!;
  if (!isPointRange(r)) return null;
  const docId = singleDocId(value);
  if (docId === null) return null; // array or non-doc scalar => RERUN
  return { keyspace: r.keyspace, key: r.start, docId };
}
