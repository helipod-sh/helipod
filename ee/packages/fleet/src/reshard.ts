/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */
/**
 * The offline fleet reshard tool (B5 Part 1, Task 9.1): change a STOPPED Postgres fleet's shard
 * count N→M by updating the persist-once `fleet:numShards` global + creating/deleting
 * `shard_leases` lane rows — atomically, in one transaction — and NOTHING else. Because a shard is
 * a logical commit-serialization lane over one shared store (`documents.shard_id` is decorative;
 * routing always recomputes `shardIdForKeyValue(key, numShards)` fresh), resharding moves no rows:
 * only which lane FUTURE commits for a key serialize through changes. See
 * `docs/dev/research/write-sharding/b5-reshard-and-object-storage.md` (Part 1) and
 * `docs/superpowers/plans/2026-02-20-fleet-reshard-b5.md` for the full design.
 *
 * Safety rests on the STOPPED-FLEET precondition (no `--force`): a live node makes the old-N and
 * new-M epochs potentially overlap in time, which is out of scope (needs an epoch-fence vocabulary
 * this tool doesn't have — see the plan's "online reshard" scope boundary). A quiesced fleet makes
 * the two epochs strictly non-overlapping, so changing a key's lane between them is as safe as any
 * config change to a stopped system.
 *
 * `F = min(frontier_ts)` is monotone across a reshard: new lanes are seeded at `MAX(ts)` (never
 * below the true high-water mark — the same F1 seed `LeaseManager.setup()`/`tryAcquire()` use, see
 * `frontierSeedExpr` in `./lease.ts`), retained lanes are GREATEST-bumped up to that same floor
 * (never lowered — a documented, safe deviation from "retained rows untouched": raise-only can
 * never regress F, and it proactively heals a lane whose frontier legitimately lags `MAX(ts)` after
 * a crash stop — no `selfFence` ran, so nothing bumped it since the last idle-closer beat — the
 * same healing a node boot's `seedFrontierAll` would eventually do), and deleting a lane can only
 * raise or hold `min(frontier_ts)`, never lower it. Net effect: EVERY post-reshard lane is
 * `>= MAX(ts)`, making the post-verify's F1 check a true post-condition rather than a best-effort one.
 */
import type { PgClient, PgQuerier, PgRow, PgValue } from "@helipod/docstore-postgres";
import { DEFAULT_SHARD, shardIdList, type ShardId } from "@helipod/id-codec";

/** The `persistence_globals` key the resolved shard count is stamped under — byte-identical to
 *  `packages/cli/src/boot.ts`'s `NUM_SHARDS_GLOBAL_KEY` (kept as an independent literal here: the
 *  ee `@helipod/fleet` package has no dependency on core `packages/cli`, mirroring the same
 *  independent-literal choice `boot.ts`'s own doc comment makes for `DEFAULT_NUM_SHARDS`). */
export const NUM_SHARDS_GLOBAL_KEY = "fleet:numShards";

/** Thrown when `reshardFleet` is asked to run against a fleet with any live `fleet_nodes` or
 *  `shard_leases.writer_url` row — the hard stopped-fleet precondition, no `--force` escape hatch.
 *  `liveUrls` names every live node/writer URL found, so the operator error is actionable. */
export class ReshardFleetLiveError extends Error {
  readonly liveUrls: string[];

  constructor(liveUrls: string[]) {
    super(
      `refusing to reshard: ${liveUrls.length} node(s) still live: ${liveUrls.join(", ")} — ` +
        `scale the fleet to zero first`,
    );
    this.name = "ReshardFleetLiveError";
    this.liveUrls = liveUrls;
  }
}

/** Thrown when the post-commit verification pass finds the reshard did not land as expected —
 *  should be impossible (a guard against a logic bug, not an expected operational outcome). */
export class ReshardVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReshardVerificationError";
  }
}

/** Thrown when `reshardFleet` is pointed at a Postgres database that has never run a fleet on it —
 *  no `shard_leases`/`fleet_nodes` tables. Without this pre-gate, the live-fleet gate query below
 *  would throw a raw `relation "fleet_nodes" does not exist`, which reads like an internal SQL bug
 *  rather than the operator-actionable "you haven't booted a fleet here yet" that it actually is. */
export class ReshardNotAFleetError extends Error {
  constructor() {
    super(
      "this database is not a fleet store (no shard_leases/fleet_nodes tables) — a fleet is " +
        "initialized by `helipod serve --fleet`; run the fleet at least once before resharding",
    );
    this.name = "ReshardNotAFleetError";
  }
}

export interface ReshardResult {
  previousShards: number;
  newShards: number;
  /** Shard ids newly created (present in the target set, absent from the prior lane set). */
  created: string[];
  /** Shard ids removed (present in the prior lane set, absent from the target set). Never includes
   *  `"default"` — it is a member of `shardIdList(M)` for every `M >= 1` and so can never be a
   *  target-set omission. */
  deleted: string[];
  /** `min(frontier_ts)` across every post-reshard lane, as a decimal string (frontier_ts is a
   *  Postgres BIGINT — carried as a string rather than risk a JS-number precision loss). */
  frontierFloor: string;
}

function toBigIntOrZero(v: PgValue | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  return typeof v === "bigint" ? v : BigInt(v as number | string);
}

/** True if the `documents` table exists yet — gates which frontier-seed SQL fragment is safe to
 *  interpolate (a literal `FROM documents` reference fails to even PARSE against a database that
 *  has never run `setupSchema()`, so this must be checked before that text is ever built). Mirrors
 *  `LeaseManager`'s own `documentsTableExists`-gated `frontierSeedExpr` reasoning (see `./lease.ts`). */
async function documentsTableExists(q: PgQuerier): Promise<boolean> {
  const rows = await q.query(`SELECT to_regclass('documents') IS NOT NULL AS exists`);
  return rows[0]?.exists === true;
}

/** `MAX(ts)` over `documents`, or `0n` when the table doesn't exist yet (a fresh/never-written
 *  store — there is no history to protect against). */
async function maxDocumentsTs(q: PgQuerier): Promise<bigint> {
  if (!(await documentsTableExists(q))) return 0n;
  const rows = await q.query(`SELECT COALESCE(MAX(ts), 0) AS m FROM documents`);
  return toBigIntOrZero(rows[0]?.m as PgValue | undefined);
}

/** Read `fleet:numShards` back the same way `resolveNumShards` (`packages/cli/src/boot.ts`) does:
 *  `Number(JSON.parse(value))`. Returns `null` when the global has never been written. */
async function readNumShardsGlobal(q: PgQuerier): Promise<number | null> {
  const rows = await q.query(`SELECT value FROM persistence_globals WHERE key = $1`, [NUM_SHARDS_GLOBAL_KEY]);
  const row = rows[0];
  if (!row) return null;
  return Number(JSON.parse(row.value as string));
}

function shardIdSet(rows: PgRow[]): Set<ShardId> {
  return new Set(rows.map((r) => r.shard_id as ShardId));
}

/**
 * Change a STOPPED Postgres fleet's shard count from whatever it currently is to `opts.targetShards`.
 * See the module doc comment for the full safety argument. Steps (verbatim to the plan, plus the
 * not-a-fleet pre-gate):
 *   1. validate `targetShards >= 1`
 *   2. probe that this is actually a fleet store (`shard_leases`/`fleet_nodes` exist) —
 *      `ReshardNotAFleetError` otherwise, before the next step's raw SQL can throw an opaque
 *      "relation does not exist"
 *   3. refuse if any `fleet_nodes`/`shard_leases` row is live (`ReshardFleetLiveError`)
 *   4. read the current lane set + the current `fleet:numShards` global
 *   5. one transaction: upsert the global, INSERT new lanes (seeded at `MAX(ts)`), DELETE surplus
 *      lanes, then GREATEST-bump every remaining lane's frontier up to that same `MAX(ts)` floor
 *      (heals a retained lane that crash-stopped below it — see the module doc comment)
 *   6. post-verify (count/set/frontier-floor/global) — `ReshardVerificationError` on any mismatch
 */
export async function reshardFleet(client: PgClient, opts: { targetShards: number }): Promise<ReshardResult> {
  const { targetShards } = opts;
  if (!Number.isInteger(targetShards) || targetShards < 1) {
    throw new RangeError(`reshardFleet: targetShards must be an integer >= 1, got ${targetShards}`);
  }

  // 2. Not-a-fleet pre-gate: without this, a fresh/never-fleeted Postgres database makes the live-
  // fleet gate query below (step 3) throw a raw `relation "fleet_nodes" does not exist` — technically
  // correct but reads like an internal bug rather than "you haven't booted a fleet here yet".
  const fleetProbe = await client.query(
    `SELECT to_regclass('shard_leases') IS NOT NULL AND to_regclass('fleet_nodes') IS NOT NULL AS is_fleet`,
  );
  if (fleetProbe[0]?.is_fleet !== true) {
    throw new ReshardNotAFleetError();
  }

  // 3. Precondition — stopped fleet. Live means EITHER an unexpired fleet_nodes presence row OR an
  // unexpired shard_leases row with a writer_url — the exact `liveNodes()` query shape from
  // `./lease.ts`, run directly here (no LeaseManager instance needed for a one-shot read).
  const liveRows = await client.query(
    `SELECT advertise_url AS url FROM fleet_nodes WHERE expires_at >= now()
     UNION
     SELECT writer_url AS url FROM shard_leases WHERE writer_url IS NOT NULL AND expires_at >= now()`,
  );
  const liveUrls = liveRows
    .map((r) => r.url as string)
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  if (liveUrls.length > 0) throw new ReshardFleetLiveError(liveUrls);

  // 4. Read current state.
  const laneRows = await client.query(`SELECT shard_id FROM shard_leases`);
  const currentLanes = shardIdSet(laneRows);
  const persistedNumShards = await readNumShardsGlobal(client);
  const previousShards = persistedNumShards ?? currentLanes.size;

  const target = shardIdList(targetShards);
  const targetSet = new Set(target);
  const created = target.filter((id) => !currentLanes.has(id));
  const deleted = [...currentLanes].filter((id) => !targetSet.has(id));
  // Invariant: "default" is a member of shardIdList(M) for every M >= 1, so it can never be a
  // target-set omission — assert rather than silently drop it if this ever regresses.
  if (deleted.includes(DEFAULT_SHARD)) {
    throw new ReshardVerificationError(`internal invariant violation: "${DEFAULT_SHARD}" lane marked for deletion`);
  }

  // 5. One transaction: global upsert + lane INSERTs (seeded at MAX(ts)) + lane DELETEs + a
  // GREATEST-bump of every REMAINING lane's frontier up to that same MAX(ts) floor.
  await client.transaction(async (tx) => {
    const seedFragment = (await documentsTableExists(tx))
      ? `(SELECT COALESCE(MAX(ts), 0) FROM documents)`
      : `0`;

    await tx.query(
      `INSERT INTO persistence_globals (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [NUM_SHARDS_GLOBAL_KEY, JSON.stringify(String(targetShards))],
    );

    for (const shardId of created) {
      // UNACQUIRED row shape — verbatim to `LeaseManager.setup()`'s pre-seed: epoch=0,
      // writer_url=NULL, writer_app_name=NULL, expires_at=now() (already-expired-equivalent — a
      // fresh acquire's `ON CONFLICT` branch still bumps epoch 0->1), frontier_ts=<seed>, prev_ts=0.
      await tx.query(
        `INSERT INTO shard_leases (shard_id, epoch, writer_url, writer_app_name, expires_at, frontier_ts, prev_ts)
         VALUES ($1, 0, NULL, NULL, now(), ${seedFragment}, 0)`,
        [shardId],
      );
    }

    for (const shardId of deleted) {
      await tx.query(`DELETE FROM shard_leases WHERE shard_id = $1`, [shardId]);
    }

    // Heal every REMAINING lane (retained + just-created) up to the F1 floor — matches boot's
    // `LeaseManager.seedFrontierAll` healing exactly, see the module doc comment. `GREATEST` only
    // ever RAISES a lane's frontier, so this is a no-op for a lane already >= the floor (the common
    // case — a live-fenced fleet's frontiers already track every commit) and only actually moves a
    // lane that legitimately lagged, e.g. a retained lane left behind by a crash stop (`kill -9`,
    // no `selfFence` ran). This is what makes the post-verify below a TRUE post-condition rather
    // than a best-effort check: after this statement, every post-reshard lane is >= MAX(ts).
    await tx.query(`UPDATE shard_leases SET frontier_ts = GREATEST(frontier_ts, ${seedFragment})`);
  });

  // 6. Post-verify (read-only, after commit). The F1 floor check below is now a true post-condition
  // — the in-tx GREATEST-bump above guarantees every lane is >= MAX(ts) — rather than a best-effort
  // check that could throw on a legitimately-lagging retained lane the tx never touched.
  const postLaneRows = await client.query(`SELECT shard_id, frontier_ts FROM shard_leases`);
  const postLaneIds = postLaneRows.map((r) => r.shard_id as ShardId);
  const postSet = new Set(postLaneIds);
  const setMatches = postLaneIds.length === targetShards && target.every((id) => postSet.has(id));
  if (!setMatches) {
    throw new ReshardVerificationError(
      `reshard post-verify failed: expected shard_leases set ${JSON.stringify(target)}, got ${JSON.stringify(postLaneIds)}`,
    );
  }

  const frontierValues = postLaneRows.map((r) => toBigIntOrZero(r.frontier_ts as PgValue | undefined));
  const minFrontier = frontierValues.reduce((a, b) => (b < a ? b : a));
  const maxTs = await maxDocumentsTs(client);
  if (minFrontier < maxTs) {
    throw new ReshardVerificationError(
      `reshard post-verify failed: min(frontier_ts)=${minFrontier} < MAX(ts)=${maxTs} (the F1 floor)`,
    );
  }

  const globalNumShards = await readNumShardsGlobal(client);
  if (globalNumShards !== targetShards) {
    throw new ReshardVerificationError(
      `reshard post-verify failed: fleet:numShards reads back ${globalNumShards}, expected ${targetShards}`,
    );
  }

  return {
    previousShards,
    newShards: targetShards,
    created,
    deleted,
    frontierFloor: minFrontier.toString(),
  };
}
