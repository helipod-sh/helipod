/**
 * Fleet globals (Tier 3 Slice 4, Task 4.1, design record §5 layout / carried note I1) — a persist-once,
 * bucket-root `globals` object carrying the deployment's identity (`deploymentId`, `numShards`). A fresh
 * node materializing from the bucket must ADOPT this existing identity rather than mint a new one — a
 * re-minted `deploymentId` would flip every outbox client to `known:false`. Mirrors `manifest.ts`'s
 * create-only-via-`casPut` + JSON-encode/decode shape, but for a single bucket-wide key instead of a
 * per-shard one.
 */
import { isCasConflict, type ObjectStore } from "@stackbase/objectstore";

/** The deployment-wide identity every node adopts on open. `numShards` is recorded once at deployment
 *  creation (Task 4.3 composes `numShards` independent per-shard lanes over the same bucket). */
export interface FleetGlobals {
  deploymentId: string;
  numShards: number;
}

const GLOBALS_KEY = "globals";

/** Read the bucket's fleet globals, or `null` if no node has created them yet. */
export async function readGlobals(os: ObjectStore): Promise<FleetGlobals | null> {
  const entry = await os.get(GLOBALS_KEY);
  if (entry === null) return null;
  return JSON.parse(new TextDecoder().decode(entry.body)) as FleetGlobals;
}

/** Create-only initialization of the bucket's fleet globals (`casPut` with `ifMatch: null`). Throws
 *  `CasConflict` (see `isCasConflict`) if another node already wrote them — callers racing to initialize
 *  the same bucket must treat that as "someone else already did it" and `readGlobals` instead (this is
 *  exactly what `ensureGlobals` does below). */
export async function createGlobals(os: ObjectStore, globals: FleetGlobals): Promise<FleetGlobals> {
  await os.casPut(GLOBALS_KEY, new TextEncoder().encode(JSON.stringify(globals)), null);
  return globals;
}

/** Adopt-on-open: read the bucket's existing fleet globals and return them if present — NEVER overwrite
 *  an already-established `deploymentId`/`numShards`. Only when the bucket has no globals yet does this
 *  create them (create-only). Two nodes racing to initialize a fresh bucket both call this concurrently:
 *  the `casPut` one-winner property means exactly one `createGlobals` lands; the loser's `CasConflict` is
 *  caught here and resolved by re-reading — so both callers converge on the SAME winning globals. */
/**
 * SINGLE-DEPLOYMENT-PER-BUCKET (whole-branch review, Finding 3, Task 4.5): Slice 4's object keyspace
 * is bare (`s{shard}/...`, `globals`) — NOT namespaced per deployment (design record §5's
 * `deployment/{id}/...` layout is deferred to Slice 5/6). Consequence: this function has no way to
 * tell "a fresh deployment pointed at an already-occupied bucket" apart from "a node of the SAME
 * deployment reconnecting" — a misconfigured second deployment aimed at an occupied bucket silently
 * ADOPTS the first's `deploymentId` (and, if it differs, its `numShards` too) rather than erroring.
 * This is a documented boundary, not a bug: fix it by giving each deployment its own bucket/prefix
 * until key-namespacing lands.
 */
export async function ensureGlobals(os: ObjectStore, globals: FleetGlobals): Promise<FleetGlobals> {
  const existing = await readGlobals(os);
  if (existing !== null) return existing;

  try {
    return await createGlobals(os, globals);
  } catch (e) {
    if (!isCasConflict(e)) throw e;
    // Lost the create race — someone else's globals won. Adopt theirs.
    const winner = await readGlobals(os);
    if (winner === null) {
      // Vanishingly unlikely (the winner would have to be deleted between the CasConflict and this
      // read) but surface loudly rather than silently return the loser's un-persisted globals.
      throw new Error("objectstore-substrate: globals CasConflict but re-read found no globals object");
    }
    return winner;
  }
}
