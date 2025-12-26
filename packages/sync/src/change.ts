/**
 * The DLR row-diff vocabulary shared by the server (emit) and the client (apply). A DIFFABLE query's
 * materialized value is a keyed `Map<docId, RowVersion>`; `applyChanges` is the ONE apply used on both
 * sides so they cannot drift in how a diff materializes. `driftChecksum` is an order-independent XOR
 * fold over `(key, ts)` — a cheap safety net: the client recomputes it after applying and, on
 * mismatch, scoped-resyncs that one query. See docs/dev/architecture/reactivity-differential-log-tail.md §4.3-4.4.
 */
import type { JSONValue } from "@stackbase/values";

export type Change =
  | { t: "add"; key: string; row: JSONValue; ts: number }
  | { t: "remove"; key: string }
  | { t: "edit"; key: string; row: JSONValue; ts: number };

export interface RowVersion {
  row: JSONValue;
  ts: number;
}

/** Apply changes to a keyed row-map, copy-on-write. Returns a NEW map (callers rely on a fresh
 *  reference to fire listeners). `add`/`edit` set `{row, ts}`; `remove` deletes the key. */
export function applyChanges(rows: Map<string, RowVersion>, changes: readonly Change[]): Map<string, RowVersion> {
  const out = new Map(rows);
  for (const c of changes) {
    if (c.t === "remove") out.delete(c.key);
    else out.set(c.key, { row: c.row, ts: c.ts });
  }
  return out;
}

/** FNV-1a 32-bit of `"<key> <ts>"` per row, XOR-folded to 32 bits. Order-independent so server and
 *  client agree regardless of iteration order. Hex string. */
export function driftChecksum(rows: Map<string, RowVersion>): string {
  let acc = 0;
  for (const [key, rv] of rows) {
    let h = 0x811c9dc5;
    const mix = (byte: number): void => { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; };
    for (let i = 0; i < key.length; i++) mix(key.charCodeAt(i) & 0xff);
    mix(0x00);
    const tsStr = String(rv.ts);
    for (let i = 0; i < tsStr.length; i++) mix(tsStr.charCodeAt(i) & 0xff);
    acc = (acc ^ (h >>> 0)) >>> 0;
  }
  return acc.toString(16).padStart(8, "0");
}
