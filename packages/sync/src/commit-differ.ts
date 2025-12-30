/**
 * The server-side CommitDiffer for DIFFABLE_BYID subscriptions (§DLR 2a). Derives the row `Change[]`
 * a commit implies for a single by-id subscription, from the commit's `WrittenDoc` (no re-read, no
 * re-run of the UDF). Pure + unit-tested in isolation from the handler, which owns the per-sub
 * `byIdRowMap` lifecycle (seed on subscribe/reset, update on each diff, drop on unsubscribe).
 */
import type { JSONValue } from "@stackbase/values";
import type { ByIdRead } from "./classify";
import { applyChanges, type Change, type RowVersion } from "./change";
import type { WrittenDoc } from "@stackbase/transactor";

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
