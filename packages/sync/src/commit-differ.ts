/**
 * The server-side CommitDiffer for DIFFABLE_BYID subscriptions (§DLR 2a). Derives the row `Change[]`
 * a commit implies for a single by-id subscription, from the commit's `WrittenDoc` (no re-read, no
 * re-run of the UDF). Pure + unit-tested in isolation from the handler, which owns the per-sub
 * `byIdRowMap` lifecycle (seed on subscribe/reset, update on each diff, drop on unsubscribe).
 */
import type { JSONValue } from "@stackbase/values";
import type { ByIdRead, RangeRead } from "./classify";
import { applyChanges, type Change, type RowVersion } from "./change";
import type { WrittenDoc } from "@stackbase/transactor";
import type { DocumentValue } from "@stackbase/docstore";
import { evaluateFilter, extractIndexKey } from "@stackbase/query-engine";
import { deserializeKeyRange, keyInRange, serializeKeyRange } from "@stackbase/index-key-codec";

/**
 * Given the sub's current row-map and the matching written doc (or `undefined` if this commit's
 * `writtenDocs` had no entry at the sub's `(keyspace, key)` — i.e. the invalidation matched this sub
 * by range/table but the write wasn't actually at its id, which shouldn't happen for a true by-id
 * point-range match but is handled defensively as a no-op), return the changes to apply plus the
 * resulting row-map. `wd === undefined` emits no changes and returns `prev` unchanged.
 */
export function byIdChangesFor(
  byId: ByIdRead,
  prev: Map<string, RowVersion>,
  wd: WrittenDoc | undefined,
): { changes: Change[]; next: Map<string, RowVersion> } {
  if (!wd) return { changes: [], next: prev };
  if (wd.keyspace !== byId.keyspace) {
    // Defensive: the caller (handler.ts) is expected to only ever pass a `wd` it already matched
    // to `byId`'s own keyspace (see the `writtenDocs.find(...)` call site). A mismatch here would
    // mean a caller bug, not a runtime condition to silently recover from — surface it loudly
    // rather than misapplying a foreign-table write to this sub's row-map.
    console.error(
      `[sync] byIdChangesFor: wd.keyspace "${wd.keyspace}" !== byId.keyspace "${byId.keyspace}" (caller bug)`,
    );
  }
  const docId = wd.docId;
  let change: Change;
  if (wd.newRow === null) change = { t: "remove", key: docId };
  else if (!wd.wasPresent || !prev.has(docId)) change = { t: "add", key: docId, row: wd.newRow, ts: wd.ts };
  else change = { t: "edit", key: docId, row: wd.newRow, ts: wd.ts };
  const changes = [change];
  return { changes, next: applyChanges(prev, changes) };
}

/** The initial reset for a DIFFABLE_BYID sub: an add for the current doc (if present), else empty
 *  (no doc → no changes, empty map). `row === null` means "no document" (subscribing to an id that
 *  doesn't (yet) exist), not a tombstone — there is nothing to remove from an empty starting map. */
export function byIdResetChanges(
  docId: string,
  row: JSONValue | null,
  ts: number,
): { changes: Change[]; next: Map<string, RowVersion> } {
  const next = new Map<string, RowVersion>();
  if (row === null) return { changes: [], next };
  next.set(docId, { row, ts });
  return { changes: [{ t: "add", key: docId, row, ts }], next };
}

/**
 * The server-side CommitDiffer for DIFFABLE_RANGE subscriptions (§DLR 2b). Derives the row
 * `Change[]` a commit implies for a single index-range subscription, from the commit's
 * `WrittenDoc`s (no re-read, no re-run of the UDF) — the membership diff mirrored below.
 *
 * `toBase64`/`fromBase64` deliberately go through `serializeKeyRange`/`deserializeKeyRange`
 * (the SAME base64 codec `SerializedKeyRange.start` already uses, via a throwaway keyspace)
 * rather than hand-rolling a second `btoa`/`atob` pair — so `orderKeyFor`'s output decodes with
 * the exact bytes-in bytes-out contract the rest of the range machinery (`keyInRange`,
 * `deserializeKeyRange`) already relies on.
 */
function toBase64(bytes: Uint8Array): string {
  return serializeKeyRange({ keyspace: "", start: bytes, end: null }).start;
}

function fromBase64(b64: string): Uint8Array {
  return deserializeKeyRange({ keyspace: "", start: b64, end: null }).start;
}

/**
 * The base64 index-entry key for `row` under `range.fields`: `extractIndexKey` (the engine's OWN
 * key extraction, `@stackbase/query-engine`) already appends the system `_creationTime`/`_id`
 * tiebreak fields, so this is byte-identical to the doc's real stored index entry — no hand
 * concatenation needed. Used both for membership bounds-checking and as the client's sort key.
 */
export function orderKeyFor(range: RangeRead, row: JSONValue): string {
  const key = extractIndexKey(row as unknown as DocumentValue, range.fields);
  return toBase64(key);
}

/** `[start, end)` bounds check against `range.bounds`, end EXCLUSIVE (matches `KeyRange`/
 *  `keyInRange` semantics — the same helper the executor's own range scans use). */
function inBounds(range: RangeRead, orderKeyB64: string): boolean {
  const bounds = deserializeKeyRange(range.bounds);
  return keyInRange(fromBase64(orderKeyB64), bounds);
}

/** All of `range.filters` (the query's `.where()` residual filters, evaluated with the same
 *  `evaluateFilter` the query runtime itself uses) pass against `row`. */
function passesFilters(range: RangeRead, row: JSONValue): boolean {
  return range.filters.every((f) => evaluateFilter(row as unknown as DocumentValue, f));
}

/** The initial reset for a DIFFABLE_RANGE sub: one `add` per doc, in the caller's already-sorted
 *  order (the fresh scan's own result order) — carries each doc's `orderKey` so the client can
 *  maintain sort order without re-deriving it. */
export function rangeResetChanges(
  range: RangeRead,
  orderedDocs: readonly JSONValue[],
  ts: number,
): { changes: Change[]; next: Map<string, RowVersion> } {
  const changes: Change[] = [];
  const next = new Map<string, RowVersion>();
  for (const row of orderedDocs) {
    const key = String((row as { _id: unknown })._id);
    const orderKey = orderKeyFor(range, row);
    changes.push({ t: "add", key, row, ts, orderKey });
    next.set(key, { row, ts, orderKey });
  }
  return { changes, next };
}

/**
 * The membership diff for a commit against a DIFFABLE_RANGE sub: for each `WrittenDoc` in the
 * sub's table, compute `before` (was this doc's id already in the sub's row-map) and `after` (is
 * the write's new row non-tombstone, in-bounds, AND filter-passing). `!before && after` is an
 * `add`; `before && after` is an `edit` (a "move" — an in-range reorder — is just an edit whose
 * `orderKey` differs from before, no separate change kind); `before && !after` is a `remove`
 * (covers both an actual delete AND a write that crosses OUT of the range/filter); anything else
 * (`!before && !after`, e.g. a write to a doc never in and still not in this range) is a no-op —
 * no `Change` emitted for it.
 */
export function rangeChangesFor(
  range: RangeRead,
  prev: Map<string, RowVersion>,
  writtenDocs: readonly WrittenDoc[],
): { changes: Change[]; next: Map<string, RowVersion> } {
  const changes: Change[] = [];
  for (const wd of writtenDocs) {
    const key = wd.docId;
    const before = prev.has(key);
    const orderKey = wd.newRow !== null ? orderKeyFor(range, wd.newRow) : undefined;
    const after =
      wd.newRow !== null && orderKey !== undefined && inBounds(range, orderKey) && passesFilters(range, wd.newRow);
    if (!before && after) changes.push({ t: "add", key, row: wd.newRow!, ts: wd.ts, orderKey: orderKey! });
    else if (before && after) changes.push({ t: "edit", key, row: wd.newRow!, ts: wd.ts, orderKey: orderKey! });
    else if (before && !after) changes.push({ t: "remove", key });
    // !before && !after => no-op, no change emitted.
  }
  return { changes, next: applyChanges(prev, changes) };
}
