/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet node composition (Task 6). Two entry points `stackbase serve --fleet` calls around the
 * shared `bootProject` boot core:
 *
 *  - `prepareFleetNode` — constructs the Postgres client + read-only store, sets up the lease
 *    table, and makes ONE `tryAcquire()` attempt. Its result decides the whole boot: acquired →
 *    a WRITER (writable Postgres store as the runtime store, drivers on, forwarder pre-promoted);
 *    not acquired → a SYNC replica. A sync node does NOT run Postgres as its runtime store — it
 *    boots a LOCAL file-backed embedded replica (`SqliteDocStore` at `<dataDir>/fleet-replica.db`)
 *    behind a `SwitchableDocStore`, and reads/serves everything off that replica; the (read-only)
 *    Postgres store is kept only as the tail source + promotion swap target. BOTH roles get the
 *    pg_notify-wrapping `NotifyingFanoutAdapter` — a sync node's is inert until (if) it's later
 *    promoted, at which point its commits immediately wake the remaining followers instead of
 *    degrading them to the poll fallback for good. It returns the exact `createEmbeddedRuntime`
 *    option deltas the caller threads through `bootProject`.
 *
 *  - `startFleetNode` — called AFTER the runtime is built. For a sync node it starts the
 *    `ReplicaTailer` (verbatim MVCC apply onto the local replica + cross-process reactive fan-out;
 *    its `start()` doesn't resolve until the replica has caught up to the primary, which is this
 *    node's ready gate) and the lease acquire loop, and on promotion runs the CRITICAL PROMOTION
 *    ORDER (`promoteFleetNode`). For a writer node it just returns handles (already promoted).
 *
 * The HTTP layer consumes `FleetHandles`: `role()` decides whether to proxy public httpActions to
 * the writer, `writerUrl()` is that proxy target, `onPromoted()` lets it drop the proxy once this
 * node becomes the writer.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import { SqliteDocStore, NodeSqliteAdapter, BunSqliteAdapter } from "@stackbase/docstore-sqlite";
import type { DatabaseAdapter } from "@stackbase/docstore-sqlite";
import type { DocStore } from "@stackbase/docstore";
import type { JSONValue } from "@stackbase/values";
import { DEFAULT_SHARD, shardIdList, type ShardId } from "@stackbase/id-codec";
import {
  InMemoryWriteFanoutAdapter,
  type EmbeddedRuntime,
  type EmbeddedWriteFanoutAdapter,
  type WriteRouter,
} from "@stackbase/runtime-embedded";
import { LeaseManager, type TryRunExclusiveOnShard } from "./lease";
import { LeaseMonitor } from "./lease-monitor";
import { ShardLeaseBalancer } from "./balancer";
import { FencedError } from "./fenced-error";
import { NotifyingFanoutAdapter } from "./commit-notifier";
import { WriteForwarder } from "./forwarder";
import { SwitchableDocStore } from "./switchable-store";
import { ReplicaTailer, type AppliedInvalidation } from "./replica-tailer";
import { keyToPointRange, docKeyToPointRange } from "./ranges";

// Re-exported for existing callers/tests (`test/point-range.test.ts` imports these from
// `../src/node`, and `index.ts` publicly exports `keyToPointRange` from here) — the
// implementations now live in `ranges.ts` (moved, not copied) so `replica-tailer.ts` can reuse
// them without a node.ts <-> replica-tailer.ts import cycle. See ranges.ts for the doc comments.
export { keyToPointRange, docKeyToPointRange } from "./ranges";

/** The filename of a sync node's local embedded replica, under the serve data dir. */
export const REPLICA_DB_FILENAME = "fleet-replica.db";

/** Default lease TTL (ms) when `STACKBASE_FLEET_LEASE_TTL_MS` is unset — mirrors `lease.ts`'s own
 *  default so the two never drift. */
export const DEFAULT_LEASE_TTL_MS = 15_000;

/** Default number of shards a fleet node runs (B2a). T5 owns the persist-once/env/`STACKBASE_FLEET_
 *  SHARDS` story; this task threads it as a plain parameter (`prepareFleetNode`'s `numShards` dep),
 *  defaulting here. The one node holds ALL N shard leases, commits in parallel across them (per-shard
 *  commit-connection pool + per-shard `ShardedTransactor` mutexes), and F = min over the N frontiers. */
export const DEFAULT_NUM_SHARDS = 8;

/** Idle-shard frontier-closing cadence (B2a, D5). The periodic beat runs every `FRONTIER_BEAT_MS`;
 *  a local commit additionally schedules a coalesced beat `FRONTIER_COALESCE_MS` later (so an idle
 *  shard un-pins F within ~10ms of a commit on a sibling shard, not the full 100ms). */
export const FRONTIER_BEAT_MS = 100;
export const FRONTIER_COALESCE_MS = 10;
/** Frontier-lag warn threshold (ms): if `min(frontier_ts)` hasn't advanced in this long, the writer
 *  logs a warning naming the pinning shard (D5 observability). Also the health endpoint's warn line. */
export const FRONTIER_LAG_WARN_MS = 5_000;

/** A point-in-time frontier-lag reading for the health endpoint (D5): the fleet-wide fenced frontier
 *  (`min(frontier_ts)` across all shard rows), how long (wall-clock ms) it has been stuck at that
 *  value, and which shard is holding it there. */
export interface FrontierStats {
  frontier: bigint;
  lagMs: number;
  pinningShard: ShardId;
}

/**
 * Fleet frontier-lag monitor + (writer-only) idle-shard closer (B2a, D5). One runs per fleet node:
 *
 *  - On the WRITER (`closeIdle: true`) each beat first CLOSES idle shards — `lease.closeIdleFrontiers`
 *    allocates one `nextval` and advances every held shard whose frontier lags it — so an idle shard
 *    can't pin `F = min(frontier_ts)` below the live commit position for more than a beat. A local
 *    commit also schedules a coalesced beat (~10ms) so F reacts promptly to writes on sibling shards.
 *  - On EITHER role each beat then READS all shard frontiers to compute `min` + the pinning shard and
 *    track how long `min` has been stuck (wall-clock since it last advanced) → the `FrontierStats`
 *    the health endpoint reports. A lag past `lagWarnMs` logs a warning naming the pinning shard
 *    (once per stall, reset when it recovers), the console signal D5 asks for.
 *
 * A sync node runs it read-only (`closeIdle: false`) — it holds no leases, so it must NOT allocate
 * `nextval` (only the writer drives the frontier); it just observes whether the fleet frontier is
 * advancing.
 */
export class FrontierMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private running = false;
  private cached: FrontierStats | null = null;
  /** The last-observed `min(frontier_ts)` and the wall-clock time it was first seen — lag is the age
   *  of the CURRENT min (how long it's been stuck), so both reset whenever min advances. */
  private lastMin: bigint | null = null;
  private minSinceMs: number;
  private warned = false;

  constructor(
    private readonly lease: LeaseManager,
    private readonly opts: {
      closeIdle: boolean;
      /** Per-shard commit-mutex seam the idle-frontier closer runs each bump under (see
       *  `closeIdleFrontiers`). Required when `closeIdle` is true; ignored otherwise. */
      runExclusiveOnShard?: TryRunExclusiveOnShard;
      beatMs?: number;
      coalesceMs?: number;
      lagWarnMs?: number;
      now?: () => number;
      warn?: (msg: string) => void;
    },
  ) {
    this.minSinceMs = (opts.now ?? Date.now)();
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    void this.beat(); // seed stats immediately so /api/health has a reading from the first request
    this.timer = setInterval(() => void this.beat(), this.opts.beatMs ?? FRONTIER_BEAT_MS);
  }

  /** Schedule a single coalesced beat `coalesceMs` out — called on each local commit so an idle
   *  sibling shard un-pins F within ~10ms instead of waiting out the periodic beat. Multiple commits
   *  inside the window collapse onto one beat. */
  triggerCoalesced(): void {
    if (this.stopped || this.coalesceTimer !== null) return;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      void this.beat();
    }, this.opts.coalesceMs ?? FRONTIER_COALESCE_MS);
  }

  private async beat(): Promise<void> {
    if (this.stopped || this.running) return; // never overlap two beats (one nextval per beat)
    this.running = true;
    try {
      if (this.opts.closeIdle) {
        if (!this.opts.runExclusiveOnShard) {
          throw new Error("fleet: FrontierMonitor closeIdle requires a runExclusiveOnShard seam (bug)");
        }
        // Close THIS node's held idle shards up to a fresh ceiling, then reuse that SAME ceiling
        // (one nextval/beat) to un-pin any ORPHANED shard's frontier (B2b, D4) — a shard nobody holds
        // (a peer died and its rows expired, or a graceful release before its new owner acquired)
        // would otherwise pin F below the live commit position indefinitely. WRITER beat only
        // (`closeIdle` is false on a sync node), so orphans move iff at least one writer is alive.
        const ceiling = await this.lease.closeIdleFrontiers(this.opts.runExclusiveOnShard);
        await this.lease.bumpOrphanFrontiers(ceiling);
      }
      const rows = await this.lease.readAllFrontiers();
      if (rows.length === 0) return;
      const min = rows[0]!.frontierTs; // ordered ascending → first row is the pinning shard
      const pinningShard = rows[0]!.shardId;
      const nowMs = this.now();
      if (this.lastMin === null || min > this.lastMin) {
        this.lastMin = min;
        this.minSinceMs = nowMs;
        this.warned = false;
      }
      const lagMs = nowMs - this.minSinceMs;
      this.cached = { frontier: min, lagMs, pinningShard };
      const lagWarnMs = this.opts.lagWarnMs ?? FRONTIER_LAG_WARN_MS;
      if (lagMs > lagWarnMs && !this.warned) {
        this.warned = true;
        (this.opts.warn ?? ((m: string) => console.warn(m)))(
          `fleet: frontier stuck for ${lagMs}ms at ${min} — shard '${pinningShard}' is pinning F`,
        );
      }
    } catch {
      // A transient read/close failure must not kill the beat loop — the next beat retries. (On the
      // writer, a persistent failure to close idle shards surfaces as growing lag, which is exactly
      // what the warn above reports.)
    } finally {
      this.running = false;
    }
  }

  /** The most recent frontier reading, or null if no beat has completed yet. `lagMs` is recomputed
   *  against the current clock so a caller between beats still sees a fresh age. */
  stats(): FrontierStats | null {
    if (this.cached === null) return null;
    return { ...this.cached, lagMs: this.now() - this.minSinceMs };
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.coalesceTimer !== null) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = null;
    }
  }
}

/**
 * Derive the failover cadences from a single knob, the lease TTL. Every timing that must stay in a
 * fixed ratio to the TTL is computed here so one env var (`STACKBASE_FLEET_LEASE_TTL_MS`) scales the
 * whole clock coherently — a live writer must renew (probe) several times per TTL, and a follower
 * must retry-acquire several times per TTL, or a shortened TTL would either expire a healthy writer's
 * lease or notice a wedged one too slowly. The ratios are chosen so the DEFAULT TTL (15000ms)
 * reproduces the historical hard-coded constants EXACTLY — `probeMs = ttl/3 = 5000` (the old
 * `LeaseMonitor` default) and `retryMs = ttl*2/15 = 2000` (the old `LeaseManager` default) — so the
 * production default is byte-for-byte behavior-identical; only a shortened TTL (the wedged-writer
 * E2E's 4000ms, or an operator's tuning) changes anything.
 */
export function fleetProbeMs(ttlMs: number): number {
  return Math.max(1, Math.round(ttlMs / 3));
}
export function fleetAcquireRetryMs(ttlMs: number): number {
  return Math.max(1, Math.round((ttlMs * 2) / 15));
}

/**
 * Bounded-writer-session timeouts (Fenced Frontier B1, D4) applied to every fleet node's pinned
 * Postgres connection — the single `NodePgClient` `prepareFleetNode` builds is the writer-capable one
 * (a sync node's same connection becomes the writer's on promotion via `pgStore.setWritable()`), so
 * it is bounded from boot. `idle_in_transaction=5s` kills a transaction a wedged writer leaves open
 * mid-commit (releasing the row lock a fencer's `evictExpired` needs); `statement=10s` caps any single
 * runaway statement. A NON-fleet single-node `serve`/`dev` (`makeStore` in `packages/cli`) constructs
 * `NodePgClient` WITHOUT this option and stays unbounded — see that call site.
 */
export const FLEET_WRITER_SESSION_TIMEOUTS = { idleInTransactionMs: 5_000, statementMs: 10_000 };

/**
 * `persistence_globals` key a fleet deployment stamps once on the primary (C7) and every sync
 * node mirrors locally onto its replica. A replica file is a rebuildable mirror of ONE primary —
 * reused against a DIFFERENT primary (e.g. a data dir copied/reattached to another deployment) it
 * would otherwise silently serve foreign rows, since the file itself carries no identity. The
 * tailer never replicates `persistence_globals` (it applies only `documents`/`indexes` rows), so
 * this stamp can only ever land on the replica via a direct local write — see
 * `reconcileReplicaIdentity`.
 */
export const FLEET_DEPLOYMENT_ID_KEY = "fleet:deploymentId";

/** Delete a SQLite replica file and its `-wal`/`-shm` sidecars — shared by the corrupted-file
 *  recovery in `openSyncReplica` and the foreign-replica rebuild in `reconcileReplicaIdentity`. */
function deleteReplicaFile(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

/**
 * The `application_name` a fleet node stamps on its Postgres backends, derived from its advertise
 * URL so every node on a host is distinguishable in `pg_stat_activity`. Uses the URL's port (unique
 * per node on a host); if the URL is unparseable or portless, falls back to the raw string so the
 * name is always deterministic and non-empty. Exported so failover tooling/tests can reconstruct a
 * specific node's discriminator without guessing.
 */
/**
 * True if the `documents` MVCC-log table already exists on `client`'s database. Used at writer
 * election (which runs BEFORE `setupSchema` creates the table) to decide whether a first-created
 * shard-lease row can safely seed its frontier from `SELECT MAX(ts) FROM documents` — referencing a
 * non-existent `documents` in that INSERT subquery would fail to plan on a fresh database. `to_regclass`
 * returns NULL for an absent relation rather than erroring, so this is a safe pre-DDL probe.
 */
async function documentsTableExists(client: NodePgClient): Promise<boolean> {
  const rows = await client.query(`SELECT to_regclass('documents') IS NOT NULL AS present`);
  return rows[0]?.present === true;
}

export function fleetApplicationName(advertiseUrl: string): string {
  let discriminator = advertiseUrl;
  try {
    const port = new URL(advertiseUrl).port;
    if (port) discriminator = port;
  } catch {
    // Unparseable advertise URL — keep the raw string as the discriminator.
  }
  return `stackbase-fleet-${discriminator}`;
}

/** Pick the SQLite adapter for the active runtime — Bun is primary (`bun:sqlite`), Node is
 *  supported (`node:sqlite`). Same runtime split `packages/cli`'s `makeStore` uses; hardcoding
 *  `NodeSqliteAdapter` would crash a Bun-hosted `stackbase serve --fleet` with "no such built-in
 *  module: node:sqlite" the moment a sync node tries to open its replica. */
function replicaAdapter(path: string): DatabaseAdapter {
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
  return isBun ? new BunSqliteAdapter({ path }) : new NodeSqliteAdapter({ path });
}

/**
 * Whether this deployment runs in MULTI-WRITER mode (`STACKBASE_FLEET_MULTI_WRITER`), read in ONE
 * place so `prepareFleetNode` (which decides the runtime store/queryStore wiring) and
 * `startFleetNode` (which decides the tailer/promotion wiring) can never disagree about a node's
 * shape. Multi-writer IS the hybrid regime (Fleet B3): every writer-ish node keeps a local replica
 * and serves queries from it while committing to the primary. Off (the production default) → the
 * shipped single-writer topology: the sole writer holds every shard and reads the primary, additional
 * nodes are pure read-replica sync nodes — no hybrid machinery anywhere (byte-identical to B2b).
 */
export function fleetMultiWriterEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.STACKBASE_FLEET_MULTI_WRITER ?? "");
}

export interface FleetHandles {
  role(): "sync" | "writer";
  /** The current writer's URL — the proxy target for public httpActions handled on a sync node. */
  writerUrl(): Promise<string>;
  /** Register a callback fired once, when this node is promoted from sync to writer. */
  onPromoted(cb: () => void): void;
  /** The current frontier-lag reading (D5 health observability): `min(frontier_ts)` across shards,
   *  how long it's been stuck (ms), and the pinning shard. Null before the first frontier beat, or if
   *  no shard rows exist yet. */
  frontierStats(): FrontierStats | null;
  /** Per-shard ownership (B2b, D1): does THIS node currently hold `shardId`'s write lease? Backs
   *  the `/_fleet/run` single-hop guard (`packages/cli`'s `http-handler.ts`) — delegates straight to
   *  `WriteForwarder.isLocalWriter`, the same live held-set view the executor's own per-shard
   *  router and `relinquish()` consult. */
  isLocalWriter(shardId: ShardId): boolean;
  stop(): Promise<void>;
}

/** The createEmbeddedRuntime option deltas the caller threads through `bootProject`. `store` is the
 *  node's RUNTIME (WRITE) store: the writable Postgres store for a writer, the `SwitchableDocStore`
 *  (over the local replica, until promotion swaps in the Postgres store) for a single-writer sync
 *  node, and — for a HYBRID (multi-writer) node — ALWAYS the Postgres store (mutations commit to the
 *  primary), paired with `queryStore` for the replica-backed read path. */
export interface FleetRuntimeOptions {
  store: DocStore;
  writeRouter: WriteRouter;
  deferDrivers: boolean;
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
  /** Number of shards this node's runtime runs (B2a). Threaded to `createEmbeddedRuntime`, which
   *  builds ONE `ShardedTransactor` (N per-shard mutexes) over the pooled store instead of the
   *  single-shard `SingleWriterTransactor` when >1 — so cross-shard commits run in parallel. */
  numShards: number;
  /**
   * Fleet B3 hybrid nodes (D1) — the replica-backed QUERY store (the `SwitchableDocStore` over the
   * local replica). Set ONLY on a hybrid (multi-writer) node: `store` (above) is the primary, where
   * mutations commit, while queries/subscriptions read this replica store. `createEmbeddedRuntime`
   * builds a separate query-path transactor + QueryRuntime over it, and routes `observeTimestamp`
   * (fed by this node's ReplicaTailer post-apply) to the query oracle so a query snapshot never
   * exceeds the replica watermark. Absent → every query runs against `store` (single-writer/sync/
   * non-fleet), byte-identical to before B3.
   */
  queryStore?: DocStore;
  /**
   * Fleet B3 hybrid RYOW (D2) — awaited in the runtime's serial fan-out `drain()` before a local
   * commit's subscription re-runs, so those re-runs (reading the replica) don't observe the commit's
   * absence on a replica that hasn't applied it yet. Wired to `forwarder.waitForReplica`. Set only on
   * a hybrid node. Absent → the drain is byte-identical to before B3.
   */
  beforeNotify?: (commitTs: bigint) => Promise<void>;
}

export interface FleetPrep {
  client: NodePgClient;
  /** The Postgres store. Writer: the runtime store (writable). Sync: the tail source + promotion
   *  swap target (read-only until promoted) — NOT the runtime store (`runtimeOptions.store` is the
   *  `SwitchableDocStore` over the local replica for a sync node). */
  pgStore: PostgresDocStore;
  /** The local file-backed replica the runtime reads queries through, and the switchable wrapper it
   *  points at. Present for a single-writer SYNC boot (runtime store = the switchable) AND for a
   *  HYBRID (multi-writer) boot of EITHER role (the switchable is `runtimeOptions.queryStore`, the
   *  read path beside the primary write store). Absent only for a single-writer WRITER boot (no
   *  replica — it reads the primary). */
  replica?: SqliteDocStore;
  switchable?: SwitchableDocStore;
  /** The on-disk path of `replica`, threaded through to `startFleetNode` so its C7
   *  `reconcileReplicaIdentity` call (deferred there — see that function's doc comment) can rebuild
   *  the file in place if needed. Present whenever `replica` is (sync boot, or any hybrid boot). */
  replicaPath?: string;
  lease: LeaseManager;
  forwarder: WriteForwarder;
  role: "sync" | "writer";
  /** The shard count decided at boot — threaded through to `startFleetNode` (acquire-all loop,
   *  all-rows seed, per-shard commit guard, idle closer) and the tailer's `count(*) < N` ready gate. */
  numShards: number;
  runtimeOptions: FleetRuntimeOptions;
}

/**
 * Open (or recover) the on-disk SQLite replica file itself — no `SwitchableDocStore` wrapper. A
 * corrupted replica file (open or `setupSchema` throws — e.g. a torn write from a hard crash) is not
 * fatal: the file is a rebuildable mirror of the primary, so delete it and retry ONCE (a fresh
 * replica re-tails from scratch); a second failure is a real environment problem and propagates.
 * Also clears the SQLite `-wal`/`-shm` sidecars so a stale journal can't re-corrupt the fresh file.
 *
 * Shared by `openSyncReplica` (first boot, wraps the result in a NEW switchable) and
 * `reconcileReplicaIdentity`'s foreign-replica rebuild path, which instead repoints an EXISTING
 * switchable via `swapTo()` — see that function's doc comment for why minting a new switchable there
 * would be wrong.
 */
async function openReplicaFile(replicaPath: string): Promise<SqliteDocStore> {
  try {
    const replica = new SqliteDocStore(replicaAdapter(replicaPath));
    await replica.setupSchema();
    return replica;
  } catch (e) {
    console.warn(
      `fleet: local replica at ${replicaPath} failed to open (${e instanceof Error ? e.message : String(e)}) — ` +
        `deleting and rebuilding from the primary`,
    );
    deleteReplicaFile(replicaPath);
    // Retry ONCE — a second failure here is not a corrupt-file problem and must surface.
    const replica = new SqliteDocStore(replicaAdapter(replicaPath));
    await replica.setupSchema();
    return replica;
  }
}

/**
 * Open the sync node's local file-backed replica (`SqliteDocStore`) and wrap it in a fresh
 * `SwitchableDocStore`. See `openReplicaFile` for the corrupted-file recovery behavior.
 */
export async function openSyncReplica(
  replicaPath: string,
): Promise<{ replica: SqliteDocStore; switchable: SwitchableDocStore }> {
  const replica = await openReplicaFile(replicaPath);
  return { replica, switchable: new SwitchableDocStore(replica) };
}

/**
 * C7: reconcile the sync node's local replica identity against the primary's `fleet:deploymentId`
 * stamp — called by `startFleetNode`'s sync path, immediately BEFORE the tailer is started. (An
 * earlier version of this code called it from `prepareFleetNode`, right after `openSyncReplica`
 * opened the replica — but that runs BEFORE `bootProject`, and `persistence_globals` (which
 * `pgStore.getGlobal` below reads) is only created by `store.setupSchema()` inside `bootProject`'s
 * `createEmbeddedRuntime`. On a fresh multi-node CONCURRENT first boot, a sync node could hit this
 * before ANY node's schema DDL had run and crash with "relation persistence_globals does not exist".
 * `startFleetNode`'s sync path now runs `pgStore.setupSchema()` itself — idempotent DDL, no writer
 * lock in read-only mode — immediately before calling this, so the check is self-sufficient on a
 * fresh database regardless of the writer's boot progress; see `startFleetNode` for the wiring.) A
 * replica file is only ever safe to tail
 * onto when it's either brand new or already stamped for THIS primary; otherwise it may carry rows
 * from a different deployment (e.g. a data dir reused/copied across environments) and must be
 * rebuilt before a single row is served off it.
 *
 * Cases:
 *  - primary has no stamp yet (this sync node won the boot race against the writer): mint-adopt via
 *    `writeGlobalIfAbsent` on the PG store — race-safe by contract, so every node that hits this
 *    converges on whichever write landed first.
 *  - fresh replica (no data, no stamp): adopt the primary's id locally, no warning, no rebuild.
 *  - stamps match: proceed as-is.
 *  - mismatch, or data present without a stamp (a pre-C7 replica): warn, delete the replica file
 *    (+ `-wal`/`-shm`), reopen a fresh one, and adopt the primary's id onto it. The rebuild repoints
 *    the CALLER's existing `switchable` via `swapTo()` rather than minting a new `SwitchableDocStore`
 *    — by the time this runs (inside `startFleetNode`), that switchable is already the runtime's live
 *    store (threaded from `prepareFleetNode` through `bootProject`), so replacing the object instead
 *    of repointing it would orphan the runtime on the stale (deleted) replica file.
 */
export async function reconcileReplicaIdentity(deps: {
  pgStore: PostgresDocStore;
  replica: SqliteDocStore;
  switchable: SwitchableDocStore;
  replicaPath: string;
}): Promise<{ replica: SqliteDocStore; switchable: SwitchableDocStore }> {
  const { pgStore, replicaPath } = deps;

  let primaryId = await pgStore.getGlobal(FLEET_DEPLOYMENT_ID_KEY);
  if (primaryId === null) {
    // The writer hasn't booted (or minted) yet — mint-adopt from here instead. Whichever node's
    // write wins the race is authoritative; re-read to pick up the actual winner (may not be ours).
    await pgStore.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, crypto.randomUUID());
    primaryId = await pgStore.getGlobal(FLEET_DEPLOYMENT_ID_KEY);
  }

  const replicaId = await deps.replica.getGlobal(FLEET_DEPLOYMENT_ID_KEY);
  if (replicaId === primaryId) {
    return { replica: deps.replica, switchable: deps.switchable }; // already stamped for this primary
  }

  const hasData = (await deps.replica.maxTimestamp()) > 0n;
  if (replicaId === null && !hasData) {
    // Fresh replica — nothing foreign to worry about, just adopt silently.
    await deps.replica.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, primaryId as JSONValue);
    return { replica: deps.replica, switchable: deps.switchable };
  }

  // Mismatch, or data present without a stamp (predates C7) — this file may carry rows from a
  // different deployment. Not fatal: rebuild from scratch, same recovery as a corrupted file.
  console.warn(
    `fleet: local replica at ${replicaPath} does not match the primary's deployment id ` +
      `(foreign replica, or predates identity stamping) — deleting and rebuilding from the primary`,
  );
  await deps.replica.close();
  deleteReplicaFile(replicaPath);
  const freshReplica = await openReplicaFile(replicaPath);
  await freshReplica.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, primaryId as JSONValue);
  // Repoint the EXISTING switchable — do NOT mint a new one (see the doc comment above): whatever
  // holds a reference to `deps.switchable` (the runtime store, for a sync node) must keep working.
  deps.switchable.swapTo(freshReplica);
  return { replica: freshReplica, switchable: deps.switchable };
}

/**
 * Decide writer-vs-sync BEFORE the runtime is constructed: one `tryAcquire()` after the lease
 * table exists. This must run before `bootProject` because the acquire result determines the
 * store's writability, the fan-out adapter, whether drivers are deferred, and the forwarder's
 * starting role — all of which are `createEmbeddedRuntime` inputs.
 */
export async function prepareFleetNode(deps: {
  databaseUrl: string;
  advertiseUrl: string;
  adminKey: string;
  /** The serve data dir — the sync node's local replica is created at `<dataDir>/fleet-replica.db`. */
  dataDir: string;
  /** Lease TTL in ms — the single knob the whole failover clock scales from (see `fleetProbeMs`/
   *  `fleetAcquireRetryMs`). Threaded from serve's fleet config, which reads
   *  `STACKBASE_FLEET_LEASE_TTL_MS` (ops/test tuning; the wedged-writer E2E uses 4000). Default 15000
   *  reproduces the historical constants exactly. */
  leaseTtlMs?: number;
  /** Number of shards this fleet runs (B2a). This task threads it as a plain parameter (default 8);
   *  T5 owns the persist-once/`STACKBASE_FLEET_SHARDS`/mismatch-fail-fast story. Drives the commit
   *  pool's connection set, the acquire-all loop, and the runtime's `ShardedTransactor`. */
  numShards?: number;
}): Promise<FleetPrep> {
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const numShards = deps.numShards ?? DEFAULT_NUM_SHARDS;
  // Canonical ordered shard ids (`["default","s1",…,"s{N-1}"]`) — the ONE source of truth for the
  // slot↔shardId contract shared by the commit pool (`commitPool.shards[slot]`), the per-slot
  // advisory locks (`tryAcquireShardLock(slot)`), and the acquire-all loop below. `shards[0]` is the
  // default shard (the writer-election slot).
  const shards = shardIdList(numShards);
  // Tag this node's Postgres backends so they're identifiable in `pg_stat_activity` — an operator can
  // see which fleet node owns a connection, and the writer self-exit E2E targets exactly one node's
  // backends via `pg_terminate_backend(... WHERE application_name = ...)`. Derived from the advertise
  // URL's port (unique per node on a host); falls back to the whole advertise URL if it has no port.
  const applicationName = fleetApplicationName(deps.advertiseUrl);
  // Writer-capable connection: bound its session (D4) — see FLEET_WRITER_SESSION_TIMEOUTS. Non-fleet
  // constructions (packages/cli's makeStore) pass no sessionTimeouts and stay unbounded.
  const client = new NodePgClient({
    connectionString: deps.databaseUrl,
    applicationName,
    sessionTimeouts: FLEET_WRITER_SESSION_TIMEOUTS,
    // Per-shard commit-connection pool (B2a, D1): one dedicated connection per shard for `commitWrite`
    // transactions, so different shards' commits run as genuinely concurrent Postgres transactions
    // (the pinned connection keeps heartbeats/eviction/setup/queries + LISTEN). Each slot's advisory
    // lock is taken on its own connection, so a shard's connection death releases exactly that shard.
    commitPool: { shards },
  });
  // Read-only until (and unless) this node wins the lease. A follower still runs the idempotent
  // DDL in setupSchema but does NOT contend for the writer advisory lock (see PostgresDocStore).
  const pgStore = new PostgresDocStore(client, { readOnly: true });
  // `applicationName` is recorded on the lease row (writer_app_name) so a future D4 eviction
  // fencer can `pg_terminate_backend` the exact wedged holder's connection by name.
  const lease = new LeaseManager(client, {
    advertiseUrl: deps.advertiseUrl,
    applicationName,
    ttlMs: leaseTtlMs,
    retryMs: fleetAcquireRetryMs(leaseTtlMs),
  });
  const forwarder = new WriteForwarder(lease, { adminKey: deps.adminKey, selfUrl: deps.advertiseUrl });

  // EVERY fleet node — writer or sync — gets the pg_notify-wrapping fan-out adapter, not just the
  // node that wins the lease at boot. A sync node never commits (`InMemoryWriteFanoutAdapter.publish`
  // is only ever invoked by a LOCAL commit), so wrapping it here is inert until this node is
  // eventually promoted (see the promotion order in `startFleetNode`) — at which point its commits
  // immediately NOTIFY the remaining followers instead of leaving them degraded to the `pollMs`
  // fallback in the tailer for the rest of the process lifetime.
  const fanoutAdapter = new NotifyingFanoutAdapter(new InMemoryWriteFanoutAdapter(), client);

  await lease.setup();
  // B2b, D3: write this node's `fleet_nodes` presence row FIRST — BEFORE the writer-election
  // `tryAcquire`, so a node that LOSES the election and boots sync is already visible in every peer's
  // live set (and thus a rendezvous participant) from the instant it exists, not only once it holds a
  // shard. This is the bootstrap-deadlock fix: a shardless node must be discoverable or scale-out
  // never happens. Idempotent upsert; the balancer/probe re-heartbeats it on the TTL clock.
  await lease.heartbeatPresence();
  // Writer election is the DEFAULT shard's lock (slot 0). In B2a single-node the node that wins it
  // holds ALL shards (the remaining slots are acquired in `startFleetNode`'s writer/promotion arming);
  // drivers run on the default-shard holder only (D5). `tryAcquire` takes slot 0's per-shard lock in
  // pool mode, else the legacy writer lock (PGlite/no-pool) — same election either way.
  //
  // Seed the DEFAULT shard's first-created frontier from the store max IFF `documents` already exists
  // (F1×N residual-window fix). This election runs BEFORE `bootProject`'s `setupSchema`, so on a fresh
  // database `documents` does NOT exist yet — but a fresh store holds no data, so `frontier_ts = 0` is
  // correct there. On a PRE-LOADED store (single-node `serve` upgraded to `--fleet`), `documents`
  // already exists and this seeds the default row to the real max at INSERT time, so it is never
  // momentarily visible at 0 while the other shards are still being acquired in `armWriter`.
  const seedDefaultFrontier = await documentsTableExists(client);
  const acquired = await lease.tryAcquire(DEFAULT_SHARD, 0, seedDefaultFrontier);

  // Fleet B3: multi-writer IS the hybrid regime. A hybrid node — of EITHER boot role — keeps a local
  // replica and serves queries from it while committing to the primary, so BOTH branches below open
  // the replica and wire it as `runtimeOptions.queryStore` (the write store stays the PRIMARY). The
  // `beforeNotify` RYOW gate delegates to `forwarder.waitForReplica` (which the forwarder answers via
  // the tailer `startFleetNode` attaches). Off → the shipped single-writer/sync store wiring below.
  const multiWriter = fleetMultiWriterEnabled();
  const replicaPath = join(deps.dataDir, REPLICA_DB_FILENAME);
  const beforeNotify = (commitTs: bigint): Promise<void> => forwarder.waitForReplica(commitTs);

  if (acquired) {
    // Writer boot: make the Postgres store writable and promote the forwarder so writes execute
    // locally. C7: the deployment-id mint (writeGlobalIfAbsent) needs `persistence_globals` to already
    // exist, which `bootProject`'s `createEmbeddedRuntime` only creates via `store.setupSchema()`
    // AFTER this function returns — so the mint itself happens in `startFleetNode`'s writer branch,
    // not here. See that comment for the full rationale.
    pgStore.setWritable();
    forwarder.promote();
    if (multiWriter) {
      // HYBRID writer boot: the runtime commits to the writable Postgres store (primary) but serves
      // queries from a local replica (queryStore). `startFleetNode` starts the ReplicaTailer over that
      // replica. Drivers ON (this node holds the default ring at boot).
      const { replica, switchable } = await openSyncReplica(replicaPath);
      return {
        client, pgStore, replica, switchable, replicaPath, lease, forwarder, role: "writer", numShards,
        runtimeOptions: {
          store: pgStore, writeRouter: forwarder, deferDrivers: false, fanoutAdapter, numShards,
          queryStore: switchable, beforeNotify,
        },
      };
    }
    // Single-writer boot: the runtime runs directly on the writable Postgres store — no replica, no
    // switchable, no query-path split (it reads the primary, as shipped).
    return {
      client, pgStore, lease, forwarder, role: "writer", numShards,
      runtimeOptions: { store: pgStore, writeRouter: forwarder, deferDrivers: false, fanoutAdapter, numShards },
    };
  }

  // Sync boot: open the local file-backed replica behind a SwitchableDocStore. Drivers deferred until
  // (if) promoted; writes forwarded to the current writer.
  //
  // C7: the replica's deployment-id stamp is reconciled against the primary's in `startFleetNode`,
  // right before the tailer starts — NOT here. `persistence_globals` (which the reconcile reads via
  // `pgStore.getGlobal`) is only created by `store.setupSchema()` inside `bootProject`'s
  // `createEmbeddedRuntime`, which runs AFTER this function returns; reading it here would crash on a
  // concurrent multi-node first boot, before ANY node's schema DDL has run. See
  // `reconcileReplicaIdentity`'s doc comment for the full rationale.
  const { replica, switchable } = await openSyncReplica(replicaPath);
  if (multiWriter) {
    // HYBRID sync boot: the runtime's WRITE store is the (read-only-until-promoted) PRIMARY, and the
    // replica is the queryStore. Unlike the single-writer sync node below (whose runtime store IS the
    // replica, swapped to the primary on promotion), a hybrid's store is ALREADY the primary — so a
    // promotion just makes it writable (no swapTo) and the tailer KEEPS running to serve replica reads.
    // No local commit lands on the read-only primary meanwhile (writes forward via `forwarder`).
    return {
      client, pgStore, replica, switchable, replicaPath, lease, forwarder, role: "sync", numShards,
      runtimeOptions: {
        store: pgStore, writeRouter: forwarder, deferDrivers: true, fanoutAdapter, numShards,
        queryStore: switchable, beforeNotify,
      },
    };
  }
  // Single-writer sync boot: the runtime store is the replica behind the SwitchableDocStore; the
  // read-only Postgres store is the tail source + promotion swap target only.
  return {
    client, pgStore, replica, switchable, replicaPath, lease, forwarder, role: "sync", numShards,
    runtimeOptions: { store: switchable, writeRouter: forwarder, deferDrivers: true, fanoutAdapter, numShards },
  };
}

export interface StartFleetNodeDeps {
  client: NodePgClient;
  /** The Postgres store — the tail source + promotion swap target (sync), or the live runtime store
   *  (writer, in which case `startFleetNode` just returns handles). */
  pgStore: PostgresDocStore;
  runtime: EmbeddedRuntime;
  lease: LeaseManager;
  forwarder: WriteForwarder;
  /** Sync only: the local replica the tailer applies onto, and the switchable the runtime reads
   *  through (swapped to the Postgres store on promotion). Absent/ignored for a writer boot. */
  replica?: SqliteDocStore;
  switchable?: SwitchableDocStore;
  /** Sync only: `replica`'s on-disk path — needed here (not just in `prepareFleetNode`) because the
   *  C7 `reconcileReplicaIdentity` check now runs in THIS function, right before `tailer.start()`. */
  replicaPath?: string;
  /** Process-exit indirection (C4/C5). Injected so tests observe exits instead of killing the runner;
   *  defaults to `console.error` + `process.exit(1)`. Fires on writer lease loss (the lease monitor)
   *  and on a failed promotion step. */
  onExit?: (reason: string) => void;
  /** Number of shards this node runs (B2a) — from `prepareFleetNode`'s decision (`FleetPrep.numShards`).
   *  The writer/promotion arming acquires all N shard leases (slots 1…N-1 beyond the default), seeds
   *  all N frontiers before ready, and drives the idle-shard closer over them. Defaults to 1 so an
   *  older single-shard call site (the B1 lifecycle tests that drive `startFleetNode` directly) is
   *  byte-identical — one shard, one lease, one frontier. */
  numShards?: number;
}

/** Production exit policy: log and terminate so the node restarts and rejoins the fleet as a fresh
 *  sync node. Overridable via `StartFleetNodeDeps.onExit` (tests inject a spy). */
function defaultFleetExit(reason: string): void {
  console.error(`fleet: ${reason} — exiting so this node restarts and rejoins as a sync replica`);
  process.exit(1);
}

/** The seam the C5 promotion wrap touches — narrow structural spies over the promotion sequence,
 *  monitor start, promoted-callback fan-out, and the exit indirection. */
export interface PromotionRunDeps {
  /** The CRITICAL PROMOTION ORDER (`promoteFleetNode`), as a thunk. */
  promote: () => Promise<void>;
  /** Start the writer lease monitor — this node is now the writer and must self-exit on lease loss. */
  startMonitor: () => void;
  /** Notify the http layer to drop its writer proxy. */
  firePromoted: () => void;
  /** Exit indirection — any promotion-step failure routes here (a half-promoted node must not linger). */
  onExit: (reason: string) => void;
}

/**
 * C5 promotion error policy: wrap the promotion sequence so ANY step failure is caught, logged, and
 * turned into an exit rather than left as a silent unhandled rejection with the node stuck
 * half-promoted (writable pg store, un-swapped runtime, no drivers). On success the lease monitor is
 * started (writer self-exit is now armed) and the http layer is told to drop its proxy. Fires exit at
 * most once by construction — it's invoked once per node (guarded by the caller's `promoting` flag).
 */
export async function runPromotion(deps: PromotionRunDeps): Promise<void> {
  try {
    await deps.promote();
    deps.startMonitor(); // this node is the writer now — arm self-exit-on-lease-loss
    deps.firePromoted();
  } catch (e) {
    deps.onExit(`promotion failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The minimal seams the CRITICAL PROMOTION ORDER touches — narrow structural interfaces (not the
 *  concrete runtime/store/tailer classes) so the sequence + its ordering can be unit-tested with
 *  lightweight spies. A real runtime/`PostgresDocStore`/`SwitchableDocStore`/`ReplicaTailer` satisfy
 *  these trivially. */
export interface PromotionDeps {
  runtime: { observeTimestamp(ts: bigint): void; startDrivers(): Promise<void> };
  pgStore: { maxTimestamp(): Promise<bigint>; setWritable(): void };
  switchable: { swapTo(next: DocStore): void };
  forwarder: { promote(): void };
  tailer: { stop(): Promise<void> };
  replica: { close(): void | Promise<void> };
}

/**
 * The CRITICAL PROMOTION ORDER (see design §1), run exactly once when a sync node wins the lease:
 *
 *   1. `observeTimestamp(maxTimestamp())` — advance the local oracle past ALL primary history, so
 *      this node's first allocated write ts can't collide with or precede one already committed.
 *   2. `pgStore.setWritable()` — the Postgres store now accepts writes.
 *   3. `switchable.swapTo(pgStore)` — the runtime store repoints from the local replica to the
 *      (now writable) Postgres store; all subsequent reads/writes go straight to Postgres.
 *   4. `forwarder.promote()` — local writes execute here instead of being forwarded (also releases
 *      any in-flight read-your-own-writes waits on the replica — moot now).
 *   5. `await tailer.stop()` — stop tailing; the writer drives its OWN fan-out from here on. Must
 *      precede closing the replica (the tailer writes to it).
 *   6. close the swapped-out replica (its file is left on disk — a rebuildable mirror).
 *   7. `await runtime.startDrivers()` — scheduler/reaper/etc. wake now that this node is the writer.
 */
export async function promoteFleetNode(deps: PromotionDeps): Promise<void> {
  deps.runtime.observeTimestamp(await deps.pgStore.maxTimestamp()); // 1
  deps.pgStore.setWritable(); //                                       2
  deps.switchable.swapTo(deps.pgStore as unknown as DocStore); //      3
  deps.forwarder.promote(); //                                         4 (also releases RYOW waits)
  await deps.tailer.stop(); //                                         5 (before closing the replica)
  await deps.replica.close(); //                                       6 (swapped-out delegate)
  await deps.runtime.startDrivers(); //                               7
}

/**
 * Install the epoch-fenced commit guard (Fenced Frontier B1, D3) on `pgStore`. Runs inside every
 * `commitWrite` transaction, after the row inserts, before COMMIT — the SAME row as the lease
 * (`shard_leases`) advances the durable-commit frontier chain (`prev_ts := frontier_ts, frontier_ts
 * := commitTs`) predicated on THIS node's epoch still being current, so frontier publication,
 * fencing, and the lease are one row with zero extra round-trips. `lease.currentEpoch()` is read
 * LIVE on every commit (not a snapshot taken at install time) so a later re-promotion's epoch bump
 * is honored automatically. Zero rows updated (a stale/superseded epoch) throws `FencedError`, which
 * aborts the whole transaction — AND calls `onFenced(shardId, reason)` before throwing so the caller
 * can react (B2b, D2: `startFleetNode` wires this straight to `relinquish(shardId, reason)` — drop
 * JUST this shard, keep serving everything else — never to a whole-node exit; see `relinquish` below
 * for why `LeaseMonitor.fenced()`/`onExit` are NOT reached from here anymore). Called at writer boot
 * AND on promotion success — see the two call sites below.
 */
export function installCommitGuard(
  pgStore: PostgresDocStore,
  lease: LeaseManager,
  onFenced: (shardId: ShardId, reason: string) => void,
): void {
  pgStore.setCommitGuard(async (q, commitTs, shardId) => {
    // B2a: the guard is now PER-SHARD. `commitWrite` routes each commit to its shard's connection and
    // passes that `shardId` here; fence against THAT shard's epoch (the per-shard epoch map) and
    // advance THAT row's frontier chain. A commit on shard s2 whose s2 epoch was superseded aborts
    // and relinquishes ONLY s2 (B2b), while the other shards' commits are unaffected.
    const epoch = lease.currentEpoch(shardId);
    if (epoch === null) {
      // Structurally shouldn't happen — the guard is only ever installed after this node has acquired
      // every shard it commits on (writer boot / promotion arming). Treat defensively as fenced rather
      // than let an inconsistent guard silently allow an unfenced commit through.
      onFenced(shardId, `commit guard invoked with no acquired epoch for shard '${shardId}'`);
      throw new FencedError(`commit fenced: this node has not acquired a shard_leases epoch for shard '${shardId}'`);
    }
    // `frontier_ts = GREATEST(frontier_ts, $1)`, not a bare `= $1` — two layers of defense against a
    // frontier regression: (1) the idle-shard closer now takes THIS shard's commit mutex before
    // bumping its frontier (`closeIdleFrontiers`), so nothing can have raised it mid-commit on the
    // same epoch, and a cross-epoch writer is fenced by the `epoch = $3` predicate; (2) GREATEST makes
    // the write monotone regardless. The tailer's semantics already tolerate `frontier_ts` exceeding
    // the last committed doc ts (idle bumps do exactly that, and its empty-range advance handles it),
    // so keeping the strictly-larger of the two is always safe. `prev_ts := frontier_ts` still records
    // the pre-write frontier as the chain's previous link.
    const rows = await q.query(
      `UPDATE shard_leases SET prev_ts = frontier_ts, frontier_ts = GREATEST(frontier_ts, $1) WHERE shard_id = $2 AND epoch = $3 RETURNING epoch`,
      [commitTs, shardId, epoch],
    );
    if (rows.length === 0) {
      onFenced(shardId, `commit guard found 0 rows for shard '${shardId}' epoch ${epoch} — superseded by another writer`);
      throw new FencedError(`commit fenced: epoch no longer current for shard '${shardId}'`);
    }
  });
}

/** The narrow seams `relinquish` needs — deliberately structural (not the concrete `NodePgClient`) so
 *  it's unit-testable with a stub, and reusable by T4's balancer without depending on `startFleetNode`'s
 *  internal closures. */
export interface RelinquishDeps {
  lease: LeaseManager;
  /** `releaseShardLock` is consulted defensively (`?.`) — absent on a poolless/PGlite client, though
   *  every real B2b fleet node runs in pool mode and always has it. */
  client: { releaseShardLock?: (slot: number) => Promise<void> };
  /** Ordered shard list (index = slot) — how `shardId`'s per-slot advisory lock is found for
   *  `releaseShardLock`. The same list `prepareFleetNode`/`startFleetNode` derive via `shardIdList`. */
  shards: readonly ShardId[];
  /** Structured-log seam, defaults to `console.error`. Tests inject a spy. */
  log?: (msg: string) => void;
  /**
   * Invoked when the DEFAULT shard is relinquished (B2b, D5 — "drivers follow the default shard"):
   * `startFleetNode` wires this to `runtime.stopDriversOnly()`, so the moment this node loses the
   * default ring the scheduler/workflow/cron/reaper drivers go quiet (a different node now owns that
   * ring). Optional — the balancer/relinquish unit tests that don't care about drivers omit it, in
   * which case relinquishing the default shard just drops the shard with no driver side effect.
   */
  onDefaultRelinquished?: () => void;
}

/**
 * Per-shard relinquish dispatcher (Fenced Frontier B2b, D2): the reduction a `FencedError` on shard
 * `s` gets now — "drop `s`, keep serving everything else" — instead of B1/B2a's "kill the node".
 * Routed to from the commit guard's `onFenced` (a fence discovered mid-commit — that commit itself
 * still aborts and propagates `FencedError` to its caller, OCC-retryable; relinquish is the SIDE
 * EFFECT, not a swallow), the batched heartbeat's `fencedShardIds` (a fence discovered on the probe
 * beat), and a per-shard commit-connection loss.
 *
 * Idempotent per shard: `lease.currentEpoch(shardId) === null` means this shard is already forgotten
 * (a prior relinquish call, or a shard this node never held) — a silent no-op, so callers never need
 * to track "have I already relinquished this" themselves.
 *
 *  1. `lease.forgetShard(shardId)` — drops the held-epoch entry, so the commit guard's "no acquired
 *     epoch" branch fences any straggler commit on `s` cleanly, and `heartbeatAll`/`closeIdleFrontiers`
 *     stop touching it.
 *  2. Release `s`'s per-slot advisory lock (`PgClient.releaseShardLock`) — UNLESS `opts.connectionLost`:
 *     a dead commit connection already released its session-scoped lock the instant the backend went
 *     away, so there is nothing left to release (and no live connection to run the unlock query on).
 *  3. Log one structured line. Relinquishing the DEFAULT shard additionally WARNS that drivers keep
 *     running (scheduler/workflow/cron/reaper stay armed on this node) until a later task wires
 *     `stopDriversOnly` (D5) — driver stop/start is deliberately NOT built here.
 *
 * Deliberately does NOT touch `LeaseMonitor` and never calls `onExit` — the whole point of B2b is that
 * a per-shard fence must no longer escalate to a whole-node exit. `LeaseMonitor` stays reserved for
 * pinned-connection loss and probe exhaustion (definitive WHOLE-NODE loss); see `startFleetNode`.
 */
export function relinquish(
  deps: RelinquishDeps,
  shardId: ShardId,
  reason: string,
  opts: { connectionLost?: boolean } = {},
): void {
  if (deps.lease.currentEpoch(shardId) === null) return; // idempotent: not held (already gone, or never)
  deps.lease.forgetShard(shardId);
  const log = deps.log ?? ((m: string) => console.error(m));
  log(
    `fleet: relinquish shard='${shardId}' reason='${reason}'` +
      (opts.connectionLost ? " (via commit-connection loss — its slot lock is already gone)" : ""),
  );
  if (shardId === DEFAULT_SHARD) {
    // B2b, D5: losing the default ring stops this node's drivers (a peer now runs the scheduler). The
    // node keeps serving everything else — `stopDriversOnly` never disposes the sync handler.
    log(`fleet: relinquished the default shard — stopping drivers (scheduler/workflow/cron/reaper)`);
    deps.onDefaultRelinquished?.();
  }
  if (opts.connectionLost) return; // the lock died with the connection — nothing left to release
  const slot = deps.shards.indexOf(shardId);
  if (slot < 0 || !deps.client.releaseShardLock) return;
  void deps.client.releaseShardLock(slot).catch((e: unknown) => {
    log(
      `fleet: releaseShardLock(${slot}) for shard '${shardId}' failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  });
}

/**
 * Acquire one non-default shard's lease as the writer (B2a acquire-all). `tryAcquire(shardId, slot)`
 * epoch-bumps that shard's row (fencing any prior holder) and takes its per-shard advisory lock. If
 * the lock is still held by a wedged prior holder AND that shard's lease has expired, fence + evict +
 * terminate its backend (the same fencing-first eviction the default-shard acquire loop uses) and
 * retry. Bounded by a generous deadline (~10 lease TTLs): the common failover frees every slot at once
 * when the default-shard loop terminates the whole wedged node, so this normally succeeds on the first
 * try (fresh boot) or right after one eviction. Exceeding the deadline throws → promotion/boot fails →
 * the node exits and rejoins fresh, never silently running as a partial-shard writer.
 */
export async function acquireShardAsWriter(
  lease: LeaseManager,
  shardId: ShardId,
  slot: number,
  retryMs: number,
  seedFrontierFromDocuments = false,
): Promise<void> {
  const deadline = Date.now() + Math.max(1, retryMs) * 75; // ~10 TTLs at the default cadence ratios
  for (;;) {
    // `seedFrontierFromDocuments`: writer-boot arming passes true (post-`setupSchema`, so `documents`
    // exists) so a FIRST-created shard row is born seeded to the store max — never momentarily visible
    // at frontier 0 (the F1×N residual-window fix). A re-acquire (ON CONFLICT) preserves the live
    // frontier regardless, so this is inert on promotion where the rows already exist.
    const state = await lease.tryAcquire(shardId, slot, seedFrontierFromDocuments);
    if (state) return;
    // Lock held — if this shard's lease has expired, its holder is wedged: fence + terminate so the
    // next attempt's advisory try can win. No-op when the lease is still live (a real concurrent
    // holder, which B2a single-node never has — belt-and-braces for the B2b multi-node future).
    if (await lease.isExpired(shardId)) {
      const { fenced, oldAppName } = await lease.evictExpired(shardId);
      if (fenced && oldAppName !== null) await lease.terminateBackend(oldAppName);
    }
    if (Date.now() > deadline) {
      throw new Error(`fleet: could not acquire shard '${shardId}' (slot ${slot}) lease within the deadline`);
    }
    await new Promise((r) => setTimeout(r, Math.max(1, retryMs)));
  }
}

/**
 * Wire the running fleet node. A writer node is already fully live (promoted in `prepareFleetNode`,
 * drivers started at `create()`) — it just gets handles. A sync node starts the replica tailer (its
 * `start()` catch-up is the node's ready gate) and the lease acquire loop, and promotes on acquire
 * via `promoteFleetNode`.
 */
export async function startFleetNode(deps: StartFleetNodeDeps): Promise<FleetHandles> {
  const { client, pgStore, runtime, lease, forwarder, switchable, replicaPath } = deps;
  const numShards = deps.numShards ?? 1;
  const shards = shardIdList(numShards);
  let replica = deps.replica;
  const onExit = deps.onExit ?? defaultFleetExit;
  const promotedCbs: Array<() => void> = [];
  // The frontier-lag monitor + (writer-only) idle-shard closer. A sync node runs it read-only so
  // /api/health can report the fleet frontier; arming as writer replaces it with an idle-closing one.
  let frontierMonitor: FrontierMonitor | null = null;
  let unsubscribeCommits: (() => void) | null = null;
  const firePromoted = (): void => {
    for (const cb of promotedCbs) {
      try {
        cb();
      } catch {
        // A misbehaving http-layer callback must not abort promotion.
      }
    }
  };

  // B2b, D3: this node's writer-ish state for the balancer. A writer boot is writer-ish from the
  // start; a sync node flips this true when it promotes (below). The balancer only ACQUIRES/RELEASES
  // shards while writer-ish; a pure sync node only heartbeats presence and may request promotion.
  let writerish = forwarder.isLocalWriter();
  // Guards the whole-node promotion so it runs at most once, whichever trigger fires first — the
  // shipped default-shard `acquireLoop` election OR the balancer's generalized trigger (a sync node
  // whose rendezvous targets include an orphaned non-default shard). Both route through the same
  // `runPromotion` via `doPromote`.
  let promoting = false;
  // Indirection so the balancer (constructed below, before the sync branch wires the real promotion
  // sequence) can trigger promotion without a definition cycle. Stays a no-op on a writer boot (a
  // writer never self-promotes) and until the sync branch assigns the real trigger.
  let doPromote: () => void = () => {};

  // B2b, D5 — "drivers follow the default shard": the scheduler/workflow/cron/reaper drivers run on
  // EXACTLY the node that currently holds the DEFAULT ring (the ring the scheduler's own unsharded
  // tables live on). Acquiring the default shard (re)starts them; relinquishing OR gracefully
  // releasing it stops them (both routed through `relinquish`, which fires `onDefaultRelinquished`).
  // `startDrivers`/`stopDriversOnly` are idempotent both ways, so these fire freely on every event.
  const relinquishDeps: RelinquishDeps = {
    lease,
    client,
    shards,
    onDefaultRelinquished: () => void runtime.stopDriversOnly(),
  };

  // One-tick acquire of a single shard's lease (+ its per-slot advisory lock) for the balancer. Mirrors
  // `acquireShardAsWriter`'s fencing-first eviction of a wedged EXPIRED holder, but as a SINGLE attempt
  // (a miss just retries on the next balancer beat, rather than looping to a deadline) so a beat never
  // blocks. `seedFrontierFromDocuments = true`: a first-created row is born seeded to the store max
  // (post-`setupSchema`, `documents` exists on every path the balancer runs), never momentarily at 0.
  const tryAcquireShard = async (shardId: ShardId): Promise<boolean> => {
    const slot = shards.indexOf(shardId);
    if (slot < 0) return false;
    let acquired = (await lease.tryAcquire(shardId, slot, true)) !== null;
    // Lock held — if this shard's lease has expired, its holder is wedged/dead: fence + terminate so
    // the retry's advisory try can win. No-op when the lease is still live (a real non-target holder,
    // which the balancer must NOT steal — so acquisition simply fails this beat and is left alone).
    if (!acquired && (await lease.isExpired(shardId))) {
      const { fenced, oldAppName } = await lease.evictExpired(shardId);
      if (fenced && oldAppName !== null) await lease.terminateBackend(oldAppName);
      acquired = (await lease.tryAcquire(shardId, slot, true)) !== null;
    }
    // D5: acquiring the default ring (re)starts this node's drivers — idempotent, so a writer boot that
    // already started them at create() is a no-op; a failover/multi-writer node that takes over the
    // default shard wakes them here.
    if (acquired && shardId === DEFAULT_SHARD) void runtime.startDrivers();
    return acquired;
  };

  // Graceful point-in-time RELEASE of a held shard the rendezvous assignment no longer gives this node
  // (B2b, D3): under the shard's commit mutex (so no in-flight commit's frontier write races it),
  // self-fence the row (epoch+1, writer_url NULL, frontier GREATEST-bump) then run the T3 relinquish
  // unwind (drop the held-epoch entry + release the slot lock). The rightful owner acquires it on its
  // own next beat — no TTL wait, no failover event. A mutation mid-execute at release time hits
  // `FencedError` at commit (OCC-retryable; the forwarder re-routes the retry to the new owner).
  const releaseShard = async (shardId: ShardId): Promise<void> => {
    await runtime.tryRunExclusiveOnShard(shardId, async () => {
      await lease.selfFence(shardId);
    });
    relinquish(relinquishDeps, shardId, "balancer graceful release (no longer a rendezvous target)");
  };

  // The rendezvous shard balancer (B2b, D3) — runs on EVERY node. Its `requestPromotion` routes through
  // `doPromote` (wired by the sync branch); `isWriterish` gates acquire/release; the acquire/release
  // thunks are the two above. Beat cadence scales with the lease TTL (2000ms at the default 15000ms).
  // Multi-writer scale-out is OPT-IN (`STACKBASE_FLEET_MULTI_WRITER`), off by default — see the
  // balancer's `multiWriter` doc. Off = single writer holds all shards + additional nodes are read
  // replicas (the shipped single-writer/sync-replica behavior, byte-identical to B2a); the balancer
  // still heartbeats presence (the bootstrap fix) and performs FAILOVER acquisition regardless. On =
  // full rendezvous distribution across co-writers, and (Fleet B3) every writer-ish node is a HYBRID:
  // it keeps its replica + real ReplicaTailer and serves queries from the replica while committing to
  // the primary. The SAME `fleetMultiWriterEnabled()` `prepareFleetNode` reads to decide the store/
  // queryStore wiring — so the two halves can never disagree about whether this node is a hybrid.
  const multiWriter = fleetMultiWriterEnabled();
  const balancer = new ShardLeaseBalancer({
    lease,
    myUrl: lease.advertiseUrl,
    numShards,
    multiWriter,
    isHeld: (shardId) => lease.currentEpoch(shardId) !== null,
    isWriterish: () => writerish,
    tryAcquireShard,
    releaseShard,
    requestPromotion: async () => {
      doPromote();
    },
    beatMs: fleetAcquireRetryMs(lease.ttlMs),
  });

  // Shared invalidation sink (B2b): advance this node's oracle past a learned ts + push a reactive
  // transition into the sync handler, derived from ONE pulled batch. Used by BOTH the sync node's
  // replica tailer AND the writer-ish node's derive-only listener (D5/T5-c) — the wiring is identical
  // because both end at "invalidate my own live subscriptions"; only whether the batch was also
  // applied to a replica differs (the tailer's mode, not this sink's concern).
  const invalidationSink = async (inv: AppliedInvalidation): Promise<void> => {
    // Wrapped so a rejection never surfaces as an unhandled promise rejection (the tailer awaits this);
    // reactivity is best-effort — reads stay correct regardless.
    try {
      runtime.observeTimestamp(inv.newMaxTs);
      const ranges = [
        ...inv.writtenKeys.map((k) => keyToPointRange(k.indexId, k.key)),
        ...inv.writtenDocs.map((d) => docKeyToPointRange(d.tableId, d.internalId)),
      ];
      await runtime.handler.notifyWrites({
        tables: inv.writtenTables,
        ranges,
        commitTs: Number(inv.newMaxTs),
      });
    } catch (e) {
      console.error("fleet: replica invalidation failed", e);
    }
  };

  // Fleet B3 (D1) — the HYBRID replica read path. In MULTI-WRITER mode EVERY writer-ish node keeps a
  // local replica and serves queries from it, so it ALWAYS runs the REAL ReplicaTailer (verbatim apply
  // + derive-only invalidation), never the B2b derive-only `invalidateOnly` listener (which is now
  // superseded on this path — the mode remains in `replica-tailer.ts` for its own tests). Shared by a
  // hybrid WRITER boot and a hybrid PROMOTION (the tailer never stops across promotion, so there is no
  // handoff gap to seed around — the B2b `seedWm` machinery is gone from this path).
  //
  // Reconciles the replica's deployment identity (post-DDL — createEmbeddedRuntime ran
  // `pgStore.setupSchema()` for a hybrid, whose runtime WRITE store IS `pgStore`), opens the tailer
  // over the replica, gates on catch-up to F (the ready gate), and attaches it to the forwarder so
  // BOTH forwarded-write RYOW and the own-commit `beforeNotify` gate resolve against the same replica
  // watermark. `replica`/`switchable`/`replicaPath` are guaranteed present on any hybrid boot by
  // `prepareFleetNode` (both roles open the replica in multi-writer mode).
  const startHybridTailer = async (): Promise<ReplicaTailer> => {
    if (!replica || !switchable || !replicaPath) {
      throw new Error(
        "fleet: hybrid boot requires a replica + switchable store + replicaPath (bug: prepareFleetNode multi-writer path must provide them)",
      );
    }
    await pgStore.setupSchema(); // idempotent (readOnly skips the writer lock); C7 self-sufficiency
    const reconciled = await reconcileReplicaIdentity({ pgStore, replica, switchable, replicaPath });
    replica = reconciled.replica; // may be a freshly-rebuilt replica; `switchable` was repointed in place
    const t = new ReplicaTailer(client, pgStore, replica, { numShards, onInvalidation: invalidationSink });
    await t.start(); // READY GATE: resolves after the replica has caught up to F.
    // Read-your-own-writes (forwarded writes) AND the own-commit `beforeNotify` gate both wait on this.
    forwarder.attachTailer(t);
    return t;
  };
  // The hybrid replica tailer, once started (writer boot, or on promotion). Stopped on shutdown; NEVER
  // stopped on promotion (unlike the single-writer path). Null on a single-writer node (no replica).
  let hybridTailer: ReplicaTailer | null = null;

  // The writer lease monitor (C4). Runs ONLY while this node is the writer: constructed lazily at
  // writer boot OR on promotion (never on a sync node). A sync node's connection loss is survivable —
  // its reads keep working off the local replica (slice 2) — so `monitor` stays null and the
  // connection-lost callback below is a no-op until (if) this node becomes the writer.
  let monitor: LeaseMonitor | null = null;
  const startWriterMonitor = (): void => {
    monitor = new LeaseMonitor({
      // Heartbeat-as-probe (Fenced Frontier B1, D2): one round-trip serves liveness-probe + TTL
      // maintenance + fence verification — NEVER pg_try_advisory_lock (re-entrant on the holding
      // session). `lease.currentEpoch()` is read live so a re-promotion's epoch bump is honored.
      probe: async () => {
        // B2b, D3 (the sanctioned evolution of the B1/T3 probe): the probe's liveness question is now
        // "can I heartbeat my PRESENCE row" — heartbeat `fleet_nodes` ALWAYS. That is a plain query on
        // the pinned connection, so a genuine connection loss makes it THROW → accrues toward the
        // miss-exhaustion backstop → whole-node exit, preserving B1's exit semantics for real
        // connection loss (the LeaseMonitor stays wired for exactly that). Held shard leases are
        // heartbeated too, but ONLY when this node holds any — in the balancer world zero-held is a
        // VALID state (a node whose targets all moved away), so the old `expected === 0` throw is GONE:
        // it would wrongly self-exit a legitimately-shardless writer-ish node via miss-exhaustion.
        // B2a/B2b, D2: a superseded epoch is a PER-SHARD signal — `fencedShardIds` names exactly which
        // held shards did NOT renew, each relinquished individually without touching `onExit`.
        await lease.heartbeatPresence();
        if (lease.heldPairs().length === 0) return; // zero-held: presence beat is the whole liveness check
        const { fencedShardIds } = await lease.heartbeatAll();
        for (const fencedShardId of fencedShardIds) {
          relinquish(
            relinquishDeps,
            fencedShardId,
            "batched heartbeat found a superseded epoch",
          );
        }
      },
      onExit: (reason) => onExit(`writer lease lost: ${reason}`),
      // Probe cadence scales with the lease TTL (same knob the LeaseManager stamps expires_at from),
      // so a live writer always renews several times per TTL — a shortened TTL (e.g. the wedged-writer
      // E2E's 4000ms) must not let a HEALTHY writer's own lease expire between probes. At the default
      // 15000ms TTL this is exactly the historical 5000ms probe.
      probeMs: fleetProbeMs(lease.ttlMs),
    });
    monitor.start();
  };

  // Register the connection-lost hook ONCE, here — routed to the monitor only when this node is the
  // writer (monitor non-null). A dropped pinned connection is definitive WHOLE-NODE lease loss (the
  // advisory lock is released the instant that backend goes away, and the pinned connection is what
  // every non-commit query — heartbeats, eviction, setup — runs on), so it exits immediately. This is
  // the ONE loss signal `relinquish` never handles: there is no "just this shard" reading of losing
  // the connection every shard's bookkeeping depends on.
  client.onConnectionLost?.(() => monitor?.connectionLost());
  // B2b, D2: a dead PER-SHARD commit connection is that shard's fence, and ONLY that shard's — the
  // shard's session-scoped advisory lock died WITH the connection (so `relinquish` must skip
  // `releaseShardLock`: there is no live connection left to run the unlock on, and the lock is already
  // gone), but every other shard's commit connection — and this node's writer status — is unaffected.
  client.onShardConnectionLost?.((shardId) =>
    relinquish(relinquishDeps, shardId, "commit connection lost", { connectionLost: true }),
  );

  /**
   * ROLE-ARM this node as a writer-ish node (B2b, D3 — the armWriter SPLIT). Runs at writer boot AND on
   * promotion. Unlike B2a's `armWriter`, this NO LONGER hard-loops an acquire-all over slots 1…N-1
   * (that would fence a live peer in a multi-writer fleet). Instead:
   *   1. `balancer.acquireTargetsNow()` — a single un-damped pass acquiring only this node's CURRENT
   *      rendezvous TARGET shards that are orphaned/expired/missing. In a single-node fleet the target
   *      set is EVERY shard, so this acquires all N — byte-identical steady state to B2a's acquire-all
   *      (the E2E single-node scenarios are that proof). In a multi-node fleet it acquires only this
   *      node's share; the balancer's periodic beat does all ongoing (re)distribution.
   *   2. `seed=true` (fresh writer boot only): seed ALL now-held frontiers up to the store's max BEFORE
   *      ready (the F1×N fix). Promotion passes `seed=false` — the frontiers are already live.
   *   3. Install the per-shard epoch-fenced commit guard.
   *   4. Start the idle-shard closer / frontier-lag monitor and wire a coalesced beat to local commits.
   */
  const armWriter = async (seed: boolean): Promise<void> => {
    await balancer.acquireTargetsNow();
    if (seed) await lease.seedFrontierAll(await pgStore.maxTimestamp());
    // B2b, D2: a guard-discovered fence relinquishes JUST that shard — never routes to
    // `monitor`/`onExit`. The aborting commit's own `FencedError` still propagates to its caller
    // (OCC-retryable) regardless; relinquish is the side effect, not a swallow.
    installCommitGuard(pgStore, lease, (fencedShardId, reason) =>
      relinquish(relinquishDeps, fencedShardId, reason),
    );
    // Idle-shard closing only matters when N>1 (with a single shard nothing else can pin F, and the
    // closer would needlessly advance the lone frontier past real commits via `nextval`). At N=1 the
    // monitor is read-only — health stats without mutating the frontier — so single-shard behavior is
    // byte-identical to B1.
    const closeIdle = numShards > 1;
    // The idle-frontier closer takes each shard's commit mutex before bumping it (the frontier-
    // inversion fix), via the runtime's per-shard exclusion seam over the same `ShardedTransactor`
    // that this writer's commits run on. Only consulted when `closeIdle` is true.
    frontierMonitor = new FrontierMonitor(lease, {
      closeIdle,
      runExclusiveOnShard: (shardId, fn) => runtime.tryRunExclusiveOnShard(shardId, fn),
    });
    frontierMonitor.start();
    // Coalesced idle-close on each LOCAL commit: a commit on one shard schedules a ~10ms beat so idle
    // sibling shards un-pin F promptly instead of waiting out the 100ms periodic beat. `?.` — a stub
    // runtime in unit tests may omit the fan-out adapter; the periodic beat is the correctness path.
    if (closeIdle) {
      unsubscribeCommits = runtime.writeFanoutAdapter?.subscribe(() => frontierMonitor?.triggerCoalesced()) ?? null;
    }
  };

  // Writer boot: store already writable, forwarder promoted, drivers running. Role-arm this node as a
  // writer-ish node (B2b, D3): `armWriter(true)` acquires its rendezvous targets NOW (= all N shards
  // in a single-node fleet, so all N frontier rows exist + are seeded BEFORE ready — the F1×N fix and
  // the byte-identity path), seeds all held frontiers, installs the commit guard, and starts the idle-
  // closer. Then arm the writer lease monitor (writer from the first tick) and START the balancer,
  // which maintains placement (acquire orphaned targets on failover, gracefully release non-targets
  // as peers join) from here on.
  if (forwarder.isLocalWriter()) {
    // Fleet B3 — HYBRID writer boot (multi-writer): stand up the replica read path (the REAL tailer)
    // BEFORE arming the writer half, so queries serve from the replica from the ready tick on. A fresh
    // single-node writer boot seeds all N frontier rows in `armWriter` (below), so the tailer's ready
    // gate here sees F = 0 (partial `shard_leases`) and resolves immediately; the poll loop then
    // catches the replica up as `armWriter`/commits advance F. On a PRE-LOADED upgrade this is a
    // bounded one-beat-early ready (accepted de-minimis, B2a-T4; it self-heals as the replica catches
    // up). Single-writer boot (multi-writer off): no replica, reads hit the primary as shipped.
    if (multiWriter) hybridTailer = await startHybridTailer();
    await armWriter(true);
    startWriterMonitor();
    balancer.start();
    // C7: mint the deployment id once, now that `bootProject` has run `pgStore.setupSchema()`
    // (this runs AFTER `prepareFleetNode` — `persistence_globals` doesn't exist before that).
    // Race-safe no-op if it's already set (e.g. this writer restarted, or a sync node minted it
    // first while this node was still booting). Sync nodes read this to detect a foreign-primary
    // replica file and rebuild rather than serve it. On a hybrid boot `startHybridTailer`'s reconcile
    // may already have mint-adopted it (writer lost the race) — this stays a race-safe no-op then.
    await pgStore.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, crypto.randomUUID());
    return {
      role: () => "writer",
      writerUrl: async () => (await lease.read())?.writerUrl ?? "",
      onPromoted: (cb) => promotedCbs.push(cb),
      frontierStats: () => frontierMonitor?.stats() ?? null,
      isLocalWriter: (shardId) => forwarder.isLocalWriter(shardId),
      stop: async () => {
        monitor?.stop();
        balancer.stop();
        frontierMonitor?.stop();
        unsubscribeCommits?.();
        lease.stop();
        await hybridTailer?.stop();
        // Hybrid writer boot: this node owns the replica (queryStore) lifecycle — serve closes the
        // WRITE store (`pgStore`), never the switchable, so close it here after the tailer stops.
        if (hybridTailer) await switchable?.close();
      },
    };
  }

  // Sync boot invariant: prepareFleetNode's sync branch always provides all three.
  if (!replica || !switchable || !replicaPath) {
    throw new Error(
      "fleet: sync node start requires a replica + switchable store + replicaPath (bug: prepareFleetNode sync boot must provide them)",
    );
  }

  // C7: make this node SELF-SUFFICIENT on a fresh database — run the idempotent Postgres DDL here,
  // before anything below reads the shared tables. A sync node's own `bootProject` ran
  // `setupSchema()` on the LOCAL replica only (slice 2 made its runtime store the
  // `SwitchableDocStore` over the replica — slice 1, where the runtime store was `pgStore` itself,
  // had this covered as a side effect, and slice 2 silently lost it); on a fresh multi-node
  // CONCURRENT first boot the writer's `bootProject` may still be mid-flight, so nothing has
  // necessarily created `persistence_globals`/`documents`/`indexes` on Postgres yet when the stamp
  // check below (or the tailer's first `maxTimestamp()`) reads them. Read-only contract: the store
  // is `readOnly` here, so `setupSchema()` runs the `CREATE ... IF NOT EXISTS` DDL but skips the
  // writer advisory lock (see `PostgresDocStore.setupSchema`) — safe for any number of followers to
  // run concurrently with the writer's own DDL.
  await pgStore.setupSchema();

  // C7: reconcile the replica's deployment-id stamp against the primary's — post-DDL-guaranteed by
  // the `setupSchema()` call directly above — and always BEFORE the tailer starts (a foreign or
  // pre-C7 replica must be rebuilt before a single row is tailed onto it). Deferred here from
  // `prepareFleetNode` for exactly this reason — see `reconcileReplicaIdentity`'s doc comment.
  const reconciled = await reconcileReplicaIdentity({ pgStore, replica, switchable, replicaPath });
  replica = reconciled.replica; // may be a freshly-rebuilt replica; `switchable` was repointed in place

  // Sync boot: verbatim-apply the primary's MVCC log onto the local replica AND drive cross-process
  // reactive fan-out from the SAME applied batch. `start()` gates on bootstrap catch-up, so this
  // node isn't reported ready (serve prints its ready line only after `startFleetNode` returns)
  // until the replica has caught up to the FENCED FRONTIER F (Fenced Frontier B1, D5 — the tailer
  //
  // F1 note: a sync node never seeds `frontier_ts` itself — it doesn't hold the epoch, so it
  // structurally can't (see `LeaseManager.seedFrontier`'s epoch fencing). If THIS node wins the boot
  // race and starts tailing before any writer has ever seeded the frontier (e.g. against a database
  // that was populated single-node, pre-`--fleet`), its ready gate targets whatever F is on the row
  // at that moment — 0, if no writer has booted yet — and it reports ready with an empty replica
  // exactly like the bug this fix addresses. That's an accepted, BOUNDED window: it heals the moment
  // ANY fleet writer boots (the writer-boot seed above), not on the far looser "first post-upgrade
  // commit" the old code silently relied on. Widening the sync node's own ready gate to wait for
  // frontier >= the primary's live max is deliberately NOT done — it would either dead-lock forever
  // on a fleet with no writer yet, or duplicate the writer's own seed logic on the read-only side.
  // reads `shard_leases.frontier_ts` itself, via the SAME `client` passed below, rather than
  // `pgStore.maxTimestamp()`; nothing extra to wire here) — a fresh follower never serves a read
  // that's arbitrarily behind, and never pulls a commit that raced past the last fence check. On
  // each applied batch: advance the oracle, translate written keys/docs into point ranges, and
  // push the transition into the sync handler.
  const tailer = new ReplicaTailer(client, pgStore, replica, {
    // B2a: the ready gate is F = min(frontier_ts) over all N shard rows, and the tailer refuses to
    // treat a partial `shard_leases` (count < numShards) as ready.
    numShards,
    // Same sink the writer-ish derive-only listener uses (D5/T5-c) — observe the ts + fan invalidation
    // into the sync handler; only the replica-apply (this tailer's default mode) differs.
    onInvalidation: invalidationSink,
  });
  await tailer.start(); // READY GATE: resolves only after the replica has caught up to the primary.
  // Enable read-your-own-writes: a client that wrote through this node waits for the replica's
  // watermark to reach that write's commitTs before its next read is served off the replica. On a
  // HYBRID node this same wait ALSO backs the own-commit `beforeNotify` gate (D2) once promoted.
  forwarder.attachTailer(tailer);
  // Fleet B3: on a HYBRID (multi-writer) sync node this same tailer KEEPS RUNNING across promotion
  // (the promotion below adds the writer half without stopping it), so track it as `hybridTailer` for
  // the shutdown path. On a single-writer sync node it's stopped/closed by `promoteFleetNode` instead.
  if (multiWriter) hybridTailer = tailer;

  // Read-only frontier-lag monitor so /api/health reports the fleet frontier + pinning shard even on
  // a sync node. It holds no leases, so `closeIdle:false` — it must NOT allocate `nextval` (only the
  // writer drives the frontier); it just observes whether F is advancing. Replaced by the writer's
  // idle-closing monitor if this node is promoted (armWriter stops this one first).
  frontierMonitor = new FrontierMonitor(lease, { closeIdle: false });
  frontierMonitor.start();

  // The CRITICAL PROMOTION ORDER, wrapped by C5 error policy — runs at most once, whichever trigger
  // fires first: the shipped DEFAULT-shard `acquireLoop` election (below), OR the balancer's
  // generalized trigger (a sync node whose rendezvous targets include an orphaned NON-default shard —
  // routed here via `doPromote`, B2b, D3). The shared `promoting` guard (declared at the top) makes
  // the two triggers idempotent at the node level.
  const triggerPromotion = (): void => {
    if (promoting) return;
    promoting = true;
    void runPromotion({
      // The lease row (default shard) is already upserted by the tryAcquire() inside acquireLoop when
      // the election path fires; the balancer path promotes first, then acquires its targets below.
      promote: async () => {
        if (multiWriter) {
          // Fleet B3 — HYBRID promotion: ADD the writer half WITHOUT tearing down the read path. The
          // runtime WRITE store is ALREADY `pgStore` (a hybrid's queries route to `queryStore`=replica),
          // so there is NO `switchable.swapTo`; the ReplicaTailer KEEPS RUNNING (queries keep serving
          // from the replica, and foreign + own commits keep being invalidated with NO handoff gap — so
          // none of B2b's `seedWm`/derive-only-listener machinery is needed here), and the forwarder
          // KEEPS its tailer (forwarded writes to shards this node still doesn't own keep their RYOW
          // wait). Deliberately NOT `promoteFleetNode`: its swap + `tailer.stop()` + `replica.close()`
          // are single-writer-only, and its `observeTimestamp(maxTimestamp())` would push the QUERY
          // oracle above the replica watermark and read holes (only the tailer's own post-apply sink may
          // advance it — D1). Just make the store writable and arm the writer half beside the tailer.
          pgStore.setWritable();
          frontierMonitor?.stop();
          unsubscribeCommits?.();
          unsubscribeCommits = null;
          await armWriter(false);
          writerish = true;
          // "Drivers follow the default shard": `armWriter`'s default-shard acquisition (re)started them
          // if this node took the default ring; stop them if it promoted for a NON-default shard only.
          if (lease.currentEpoch(DEFAULT_SHARD) === null) void runtime.stopDriversOnly();
          return;
        }
        // Single-writer FAILOVER promotion (multi-writer off): the shipped CRITICAL PROMOTION ORDER —
        // swap the runtime store from the replica to the (now writable) primary, stop the tailer + close
        // the replica (this node reads the primary directly from here on), observe the primary max onto
        // the write oracle, start drivers. No replica read path survives, so nothing tails afterward.
        // `replica` is a `let` reassigned inside `startHybridTailer` (a nested closure), which defeats
        // TS control-flow narrowing here — but the sync-boot invariant above threw unless it was
        // present, and `reconcileReplicaIdentity` reassigned it to a non-null store, so it is defined.
        await promoteFleetNode({ runtime, pgStore, switchable, forwarder, tailer, replica: replica! });
        // Swap the read-only frontier monitor for the writer's idle-closing one, and acquire this
        // node's rendezvous targets. `seed=false`: promotion never re-seeds frontiers (they're already
        // live — a dead writer's high-water is preserved through the epoch-bumping re-acquire).
        // `armWriter` also installs the per-shard commit guard (closes over `monitor` by reference, so
        // a fence AFTER `startMonitor` runs still reaches the now-non-null monitor).
        frontierMonitor?.stop();
        unsubscribeCommits?.();
        unsubscribeCommits = null;
        await armWriter(false);
        // Now writer-ish: the already-running balancer's next beat will acquire/release to converge.
        writerish = true;
        if (lease.currentEpoch(DEFAULT_SHARD) === null) void runtime.stopDriversOnly();
      },
      startMonitor: startWriterMonitor,
      firePromoted,
      onExit,
    });
  };
  // The balancer's generalized promotion trigger routes here (was a no-op until now).
  doPromote = triggerPromotion;
  // The shipped DEFAULT-shard election path (fast failover — grabs the freed advisory lock the instant
  // the prior writer dies, without waiting out any presence TTL) also triggers the same promotion.
  lease.acquireLoop(() => triggerPromotion());

  // Start the balancer on the sync node too: it heartbeats this node's presence (its liveness signal —
  // a shardless sync node has no shard_leases row and no LeaseMonitor), and requests promotion when
  // its rendezvous share includes an orphaned non-default shard. Its first beat fires after ~2s.
  balancer.start();

  return {
    role: () => (forwarder.isLocalWriter() ? "writer" : "sync"),
    writerUrl: async () => (await lease.read())?.writerUrl ?? "",
    onPromoted: (cb) => promotedCbs.push(cb),
    frontierStats: () => frontierMonitor?.stats() ?? null,
    isLocalWriter: (shardId) => forwarder.isLocalWriter(shardId),
    stop: async () => {
      monitor?.stop(); // disarm writer self-exit BEFORE the connection is closed (if promoted)
      balancer.stop();
      frontierMonitor?.stop();
      unsubscribeCommits?.();
      lease.stop();
      await tailer.stop();
      // Fleet B3: a HYBRID sync node's runtime WRITE store is `pgStore` (serve closes THAT on
      // shutdown), and its promotion never swaps the replica out — so serve never closes the
      // switchable/replica (the queryStore). Close it here, after the tailer stops writing to it. A
      // single-writer sync node's runtime store IS the switchable (serve closes it) or it was closed
      // by `promoteFleetNode` on promotion, so this node must NOT close it in that mode (double close).
      if (multiWriter) await switchable?.close();
      // This node owns the Postgres store's lifecycle (it's not the serve runtime store for a
      // single-writer sync node). Close it here so the pg connection is released; `NodePgClient.close()`
      // is idempotent, so a later `switchable.close()` (single-writer, if promotion swapped it in) OR
      // serve's own `store.close()` on `pgStore` (hybrid) is a safe no-op.
      await pgStore.close();
    },
  };
}
