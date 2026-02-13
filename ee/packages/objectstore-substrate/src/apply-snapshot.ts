/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * `applySnapshotState` (Tier 3 Slice 5 re-review fix) — the MVCC-safe way to restore a
 * `SnapshotPayload` onto an already-materialized local `SqliteDocStore`: `write(..., "Overwrite")`
 * is an OVERLAY (INSERT OR REPLACE), never a replace-all, and a snapshot's `documents` (sourced
 * from `SqliteDocStore.dumpCurrentState()`) EXCLUDES tombstones — so applying a snapshot's rows
 * alone onto a NON-EMPTY store cannot express "this doc was deleted in the range this restore
 * jumps over." A doc the store still has LIVE that the snapshot silently dropped would otherwise
 * stay phantom-live on that store forever.
 *
 * The fix: diff the store's OWN current live docs against the snapshot's live-doc set and APPEND a
 * tombstone (`value: null`) for anything the snapshot dropped, at `frontierTs` (>= every existing
 * revision on a store genuinely behind the snapshot whenever this runs) — append-only, so a
 * concurrent MVCC read against the store never sees rows physically disappear mid-restore. Never
 * truncates the store to fake a "fresh" restore.
 *
 * Originally lived inline in `replica-tailer.ts`'s `#materializeRound` (Task 5.1's Finding-1 fix,
 * whole-branch review). Extracted here (Slice 5 re-review) because `object-doc-store.ts`'s
 * `materializeTo()` — the WRITER's own catch-up path, driven from BOTH `open()` (always onto an
 * empty local, safe either way) AND `acquire()`'s takeover catch-up (onto an already-open,
 * POSSIBLY NON-EMPTY, stale writer instance — dangerous without this fix) — runs the identical
 * snapshot-restore-onto-a-possibly-non-empty-store shape and needed the exact same fix: a fenced
 * writer that re-`acquire()`s after another writer deleted a doc + snapshotted + GC'd its
 * pre-snapshot segments could otherwise resurrect the deleted doc in its own local store and
 * RE-COMMIT it, permanently undoing the delete in the durable log. Single implementation, both call
 * sites — see each call site's own comment for how it folds (or ignores) the result.
 *
 * On an EMPTY local store (the common `open()` fresh-bootstrap path, and the replica tailer's own
 * first-ever round) `dumpCurrentState()` returns no documents, so the diff is a no-op and this is
 * byte-identical to a plain snapshot apply — no behavior change for that path.
 */
import type { DocumentLogEntry } from "@stackbase/docstore";
import type { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { documentIdKey } from "@stackbase/id-codec";
import type { SnapshotPayload } from "./snapshot";

/**
 * Restore `snap` onto `local`, tombstoning (at `frontierTs`) any doc `local` currently holds LIVE
 * that `snap` doesn't mention, THEN applying `snap`'s own rows — both via the same explicit-ts
 * `write(..., "Overwrite")` primitive every other materialization path uses.
 *
 * Returns the tombstones actually appended (empty if `local` had nothing to drop) so a caller that
 * tracks reactive invalidation (the replica tailer) can fold them into its own written-docs set; a
 * caller with no invalidation sink to feed (the writer's own catch-up — its transactor/tailer own
 * reactivity, not this method) may simply ignore the return value.
 */
export async function applySnapshotState(
  local: SqliteDocStore,
  snap: SnapshotPayload,
  frontierTs: bigint,
): Promise<{ deletedDocs: DocumentLogEntry[] }> {
  const snapshotIds = new Set(snap.documents.map((d) => documentIdKey(d.id)));
  const currentState = await local.dumpCurrentState();
  const dropped = currentState.documents.filter((d) => !snapshotIds.has(documentIdKey(d.id)));

  let deletedDocs: DocumentLogEntry[] = [];
  if (dropped.length > 0) {
    deletedDocs = dropped.map((d) => ({ ts: frontierTs, id: d.id, value: null, prev_ts: d.ts }));
    await local.write(deletedDocs, [], "Overwrite");
  }

  await local.write(snap.documents, snap.indexUpdates, "Overwrite");

  return { deletedDocs };
}
