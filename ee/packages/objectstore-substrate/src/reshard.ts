/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * Offline object-storage reshard (`docs/superpowers/plans/2026-02-20-objectstore-reshard.md`).
 *
 * Changes a STOPPED object-storage deployment's shard count N→M. Unlike the fleet reshard (logical lanes
 * over one shared store → moves no rows), object-storage lanes each have their own physical log, so a doc
 * whose lane changes (`shardIdForKeyValue(doc[shardKey], N) ≠ …M`) has its current state PHYSICALLY MOVED
 * between lane logs. The operation:
 *   1. GATE — refuse if any source lane has a live lease (an online reshard is out of scope).
 *   2. MATERIALIZE every source lane's current state into memory (`dumpCurrentState`).
 *   3. RE-PARTITION each doc by `shardIdForKeyValue(doc[table.shardKey], M)` (a doc's table with no
 *      shardKey → the "default" lane), routing each live index entry to the same lane as its doc.
 *   4. REWRITE — delete all objects for every lane in source∪target, then write each target lane fresh
 *      (open empty → acquire → commit its re-partitioned docs+index → relinquish).
 *   5. Set `globals.numShards = M` LAST — the linearization point.
 *
 * CRASH-SAFETY, honest: object storage has no cross-object transaction, so step 4 is a NON-ATOMIC full
 * rewrite. A crash mid-rewrite leaves the bucket partially rewritten and is NOT resumable — the contract
 * is OFFLINE, against a BACKED-UP bucket, don't interrupt. (The whole current state is read into memory
 * in step 2 first, so the destructive window is as short as possible and never races the read.)
 */
import type { ObjectStore } from "@helipod/objectstore";
import type { SqliteDocStore } from "@helipod/docstore-sqlite";
import type { DocumentLogEntry, IndexWrite } from "@helipod/docstore";
import { shardIdList, shardIdForKeyValue, DEFAULT_SHARD, documentIdKey, type ShardId } from "@helipod/id-codec";
import { ObjectStoreDocStore } from "./object-doc-store";
import { readManifest } from "./manifest";
import { readGlobals, writeGlobals } from "./globals";

/** Thrown when reshard is asked to run against a deployment that still has a live lease on any lane. */
export class ReshardObjectStoreLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReshardObjectStoreLiveError";
  }
}

export interface ReshardObjectStoreOpts {
  objectStore: ObjectStore;
  /** The target shard count (M ≥ 1). */
  toShards: number;
  /** Wall-clock ms (caller-supplied — the substrate holds no ambient clock). Used only for the live-lease
   *  gate and the transient lease `acquire` while writing each fresh lane. */
  now: number;
  /** The table's shard key field (`schema.ts` `.shardKey(field)`), or null when the table isn't sharded.
   *  The reshard's ONLY schema dependency — injected so the core needs no schema loader (the CLI wires the
   *  composed catalog's `getTableByNumber(n)?.shardKey`). */
  shardKeyFor: (tableNumber: number) => string | null;
  /** Mint a throwaway local `SqliteDocStore` (`:memory:`) for materialization + each fresh lane's commit —
   *  injected so the substrate stays adapter-agnostic. */
  makeLocal: () => SqliteDocStore;
}

export interface ReshardObjectStoreResult {
  fromShards: number;
  toShards: number;
  /** Docs whose owning lane changed (physically moved between lane logs). */
  movedDocs: number;
  /** Doc count landed in each target lane. */
  perLaneCounts: Record<string, number>;
}

/** The lane-id set a deployment of `numShards` uses. A deployment BORN single-shard uses the shipped
 *  "0" lane; any multi-shard (or resharded) deployment uses the canonical `shardIdList`. */
function laneIdsFor(numShards: number): ShardId[] {
  return numShards === 1 ? ["0"] : [...shardIdList(numShards)];
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

export async function reshardObjectStore(opts: ReshardObjectStoreOpts): Promise<ReshardObjectStoreResult> {
  const { objectStore: os, toShards, now, shardKeyFor, makeLocal } = opts;
  if (!Number.isInteger(toShards) || toShards < 1) {
    throw new RangeError(`reshardObjectStore: toShards must be a positive integer, got ${toShards}`);
  }

  const globals = await readGlobals(os);
  if (globals === null) {
    throw new Error("reshardObjectStore: no `globals` object — this bucket is not an object-storage deployment");
  }
  const fromShards = globals.numShards;
  if (fromShards === toShards) {
    return { fromShards, toShards, movedDocs: 0, perLaneCounts: {} }; // already at M — no-op
  }

  const sourceLaneIds = laneIdsFor(fromShards);
  // The BUCKET lane prefixes to write. `numShards === 1` ALWAYS means the single "0" lane (whether the
  // deployment was born single-shard or resharded down to 1) — so `numShards` alone unambiguously tells
  // a booting node its layout. `numShards > 1` uses the canonical `shardIdList` prefixes (identity with
  // the engine's routing shardIds), matching `boot.ts`'s multi-shard writer.
  const targetLaneIds = laneIdsFor(toShards);

  // Map an engine routing shardId (`shardIdForKeyValue`'s output: "default"/"s1"/…) to the BUCKET lane
  // prefix a doc's current state is written under. M>1: identity (bucket prefix === engine shardId). M=1:
  // the single "0" lane owns everything (its lone `ObjectStoreDocStore` ignores the routing shardId).
  const toBucketLane = (engineShard: ShardId): ShardId => (toShards === 1 ? "0" : engineShard);

  // 1. GATE — no live lease on any source lane.
  for (const shard of sourceLaneIds) {
    const m = await readManifest(os, shard);
    if (m !== null && m.manifest.writerId !== "" && now <= Number(m.manifest.leaseExpiresAt)) {
      throw new ReshardObjectStoreLiveError(
        `reshardObjectStore: refusing — lane '${shard}' has a live lease held by '${m.manifest.writerId}' ` +
          `(expires at ${m.manifest.leaseExpiresAt}, now ${now}). Stop the deployment (scale to zero / let leases expire) first.`,
      );
    }
  }

  // 2. MATERIALIZE every source lane's current state into memory.
  const allDocs: DocumentLogEntry[] = [];
  const allIndex: IndexWrite[] = [];
  const oldLaneOfDoc = new Map<string, ShardId>();
  for (const shard of sourceLaneIds) {
    const local = makeLocal();
    await ObjectStoreDocStore.open({ objectStore: os, shard, local }); // materializes `local` (no claim)
    const state = await local.dumpCurrentState();
    for (const d of state.documents) {
      allDocs.push(d);
      oldLaneOfDoc.set(documentIdKey(d.id), shard);
    }
    for (const iw of state.indexUpdates) allIndex.push(iw);
    await local.close();
  }

  // 3. RE-PARTITION docs by their M-lane; route live index entries to the same lane as their doc.
  const laneToDocs = new Map<ShardId, DocumentLogEntry[]>();
  const newLaneOfDoc = new Map<string, ShardId>();
  let movedDocs = 0;
  for (const d of allDocs) {
    const shardKey = shardKeyFor(d.id.tableNumber);
    // `d.value` is non-null (dumpCurrentState excludes tombstones); `.value` is the doc's fields.
    const fields = d.value?.value as Record<string, unknown> | undefined;
    const engineShard: ShardId =
      shardKey !== null && fields !== undefined ? shardIdForKeyValue(fields[shardKey], toShards) : DEFAULT_SHARD;
    const newLane = toBucketLane(engineShard);
    const key = documentIdKey(d.id);
    newLaneOfDoc.set(key, newLane);
    if (oldLaneOfDoc.get(key) !== newLane) movedDocs++;
    pushTo(laneToDocs, newLane, d);
  }
  const laneToIndex = new Map<ShardId, IndexWrite[]>();
  for (const iw of allIndex) {
    if (iw.update.value.type !== "NonClustered") continue; // drop tombstone markers — fresh lanes start clean
    const lane = newLaneOfDoc.get(documentIdKey(iw.update.value.docId));
    if (lane === undefined) continue; // index entry with no live doc (defensive — shouldn't occur)
    pushTo(laneToIndex, lane, iw);
  }

  // 4. REWRITE — delete every object for every lane in source∪target, then write each target lane fresh.
  const lanesToClear = new Set<string>([...sourceLaneIds, ...targetLaneIds]);
  for (const shard of lanesToClear) {
    for (const k of await os.list(`s${shard}/`)) await os.delete(k);
  }
  const perLaneCounts: Record<string, number> = {};
  for (const shard of targetLaneIds) {
    const docs = laneToDocs.get(shard) ?? [];
    const index = laneToIndex.get(shard) ?? [];
    perLaneCounts[shard] = docs.length;
    const local = makeLocal();
    const store = await ObjectStoreDocStore.open({ objectStore: os, shard, local }); // fresh manifest (empty lane)
    await store.acquire({ writerId: `reshard-${shard}`, leaseTtlMs: 60_000, now });
    if (docs.length > 0 || index.length > 0) {
      await store.commitWriteBatch([{ documents: docs, indexUpdates: index }], shard);
    }
    await store.relinquish(); // clear the transient lease so a post-reshard node acquires immediately
    await local.close();
  }

  // 5. Set the new shard count LAST — the linearization point of the completed reshard.
  await writeGlobals(os, { deploymentId: globals.deploymentId, numShards: toShards });

  return { fromShards, toShards, movedDocs, perLaneCounts };
}
