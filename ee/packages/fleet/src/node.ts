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
import {
  InMemoryWriteFanoutAdapter,
  type EmbeddedRuntime,
  type EmbeddedWriteFanoutAdapter,
  type WriteRouter,
} from "@stackbase/runtime-embedded";
import { LeaseManager } from "./lease";
import { LeaseMonitor } from "./lease-monitor";
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

export interface FleetHandles {
  role(): "sync" | "writer";
  /** The current writer's URL — the proxy target for public httpActions handled on a sync node. */
  writerUrl(): Promise<string>;
  /** Register a callback fired once, when this node is promoted from sync to writer. */
  onPromoted(cb: () => void): void;
  stop(): Promise<void>;
}

/** The createEmbeddedRuntime option deltas the caller threads through `bootProject`. `store` is the
 *  node's RUNTIME store: the writable Postgres store for a writer, the `SwitchableDocStore` (over the
 *  local replica, until promotion swaps in the Postgres store) for a sync node. */
export interface FleetRuntimeOptions {
  store: DocStore;
  writeRouter: WriteRouter;
  deferDrivers: boolean;
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
}

export interface FleetPrep {
  client: NodePgClient;
  /** The Postgres store. Writer: the runtime store (writable). Sync: the tail source + promotion
   *  swap target (read-only until promoted) — NOT the runtime store (`runtimeOptions.store` is the
   *  `SwitchableDocStore` over the local replica for a sync node). */
  pgStore: PostgresDocStore;
  /** Sync only: the local file-backed replica the runtime reads through, and the switchable wrapper
   *  the runtime store points at. Absent for a writer boot. */
  replica?: SqliteDocStore;
  switchable?: SwitchableDocStore;
  /** Sync only: the on-disk path of `replica`, threaded through to `startFleetNode` so its C7
   *  `reconcileReplicaIdentity` call (deferred there — see that function's doc comment) can rebuild
   *  the file in place if needed. Absent for a writer boot. */
  replicaPath?: string;
  lease: LeaseManager;
  forwarder: WriteForwarder;
  role: "sync" | "writer";
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
}): Promise<FleetPrep> {
  // Tag this node's Postgres backends so they're identifiable in `pg_stat_activity` — an operator can
  // see which fleet node owns a connection, and the writer self-exit E2E targets exactly one node's
  // backends via `pg_terminate_backend(... WHERE application_name = ...)`. Derived from the advertise
  // URL's port (unique per node on a host); falls back to the whole advertise URL if it has no port.
  const applicationName = fleetApplicationName(deps.advertiseUrl);
  const client = new NodePgClient({ connectionString: deps.databaseUrl, applicationName });
  // Read-only until (and unless) this node wins the lease. A follower still runs the idempotent
  // DDL in setupSchema but does NOT contend for the writer advisory lock (see PostgresDocStore).
  const pgStore = new PostgresDocStore(client, { readOnly: true });
  const lease = new LeaseManager(client, { advertiseUrl: deps.advertiseUrl });
  const forwarder = new WriteForwarder(lease, { adminKey: deps.adminKey, selfUrl: deps.advertiseUrl });

  // EVERY fleet node — writer or sync — gets the pg_notify-wrapping fan-out adapter, not just the
  // node that wins the lease at boot. A sync node never commits (`InMemoryWriteFanoutAdapter.publish`
  // is only ever invoked by a LOCAL commit), so wrapping it here is inert until this node is
  // eventually promoted (see the promotion order in `startFleetNode`) — at which point its commits
  // immediately NOTIFY the remaining followers instead of leaving them degraded to the `pollMs`
  // fallback in the tailer for the rest of the process lifetime.
  const fanoutAdapter = new NotifyingFanoutAdapter(new InMemoryWriteFanoutAdapter(), client);

  await lease.setup();
  const acquired = await lease.tryAcquire();

  if (acquired) {
    // Writer boot: make the Postgres store writable and promote the forwarder so writes execute
    // locally. The runtime runs directly on the writable Postgres store — no replica, no switchable.
    pgStore.setWritable();
    forwarder.promote();
    // C7: the deployment-id mint (writeGlobalIfAbsent) needs `persistence_globals` to already
    // exist, which `bootProject`'s `createEmbeddedRuntime` only creates via `store.setupSchema()`
    // AFTER this function returns — so the mint itself happens in `startFleetNode`'s writer
    // branch, not here. See that comment for the full rationale.
    return {
      client,
      pgStore,
      lease,
      forwarder,
      role: "writer",
      runtimeOptions: {
        store: pgStore,
        writeRouter: forwarder,
        deferDrivers: false,
        fanoutAdapter,
      },
    };
  }

  // Sync boot: the runtime store is a local file-backed replica behind a SwitchableDocStore. The
  // read-only Postgres store is the tail source + promotion swap target only. Drivers deferred until
  // (if) promoted; writes forwarded to the current writer.
  //
  // C7: the replica's deployment-id stamp is reconciled against the primary's in `startFleetNode`,
  // right before the tailer starts — NOT here. `persistence_globals` (which the reconcile reads via
  // `pgStore.getGlobal`) is only created by `store.setupSchema()` inside `bootProject`'s
  // `createEmbeddedRuntime`, which runs AFTER this function returns; reading it here would crash on a
  // concurrent multi-node first boot, before ANY node's schema DDL has run. See
  // `reconcileReplicaIdentity`'s doc comment for the full rationale.
  const replicaPath = join(deps.dataDir, REPLICA_DB_FILENAME);
  const { replica, switchable } = await openSyncReplica(replicaPath);
  return {
    client,
    pgStore,
    replica,
    switchable,
    replicaPath,
    lease,
    forwarder,
    role: "sync",
    runtimeOptions: { store: switchable, writeRouter: forwarder, deferDrivers: true, fanoutAdapter },
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
 * Wire the running fleet node. A writer node is already fully live (promoted in `prepareFleetNode`,
 * drivers started at `create()`) — it just gets handles. A sync node starts the replica tailer (its
 * `start()` catch-up is the node's ready gate) and the lease acquire loop, and promotes on acquire
 * via `promoteFleetNode`.
 */
export async function startFleetNode(deps: StartFleetNodeDeps): Promise<FleetHandles> {
  const { client, pgStore, runtime, lease, forwarder, switchable, replicaPath } = deps;
  let replica = deps.replica;
  const onExit = deps.onExit ?? defaultFleetExit;
  const promotedCbs: Array<() => void> = [];
  const firePromoted = (): void => {
    for (const cb of promotedCbs) {
      try {
        cb();
      } catch {
        // A misbehaving http-layer callback must not abort promotion.
      }
    }
  };

  // The writer lease monitor (C4). Runs ONLY while this node is the writer: constructed lazily at
  // writer boot OR on promotion (never on a sync node). A sync node's connection loss is survivable —
  // its reads keep working off the local replica (slice 2) — so `monitor` stays null and the
  // connection-lost callback below is a no-op until (if) this node becomes the writer.
  let monitor: LeaseMonitor | null = null;
  const startWriterMonitor = (): void => {
    monitor = new LeaseMonitor({
      // Plain liveness round-trip — NEVER pg_try_advisory_lock (re-entrant on the holding session).
      probe: async () => {
        await client.query("SELECT 1");
      },
      onExit: (reason) => onExit(`writer lease lost: ${reason}`),
    });
    monitor.start();
  };

  // Register the connection-lost hook ONCE, here — routed to the monitor only when this node is the
  // writer (monitor non-null). A dropped pinned connection is definitive lease loss (the advisory
  // lock is released the instant that backend goes away), so it exits immediately.
  client.onConnectionLost?.(() => monitor?.connectionLost());

  // Writer boot: nothing to start (store already writable, forwarder promoted, drivers running) —
  // except the lease monitor, since this node is the writer from the first tick.
  if (forwarder.isLocalWriter()) {
    startWriterMonitor();
    // C7: mint the deployment id once, now that `bootProject` has run `pgStore.setupSchema()`
    // (this runs AFTER `prepareFleetNode` — `persistence_globals` doesn't exist before that).
    // Race-safe no-op if it's already set (e.g. this writer restarted, or a sync node minted it
    // first while this node was still booting). Sync nodes read this to detect a foreign-primary
    // replica file and rebuild rather than serve it.
    await pgStore.writeGlobalIfAbsent(FLEET_DEPLOYMENT_ID_KEY, crypto.randomUUID());
    return {
      role: () => "writer",
      writerUrl: async () => (await lease.read())?.writerUrl ?? "",
      onPromoted: (cb) => promotedCbs.push(cb),
      stop: async () => {
        monitor?.stop();
        lease.stop();
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
  // until the replica has caught up to the primary — a fresh follower never serves a read that's
  // arbitrarily behind. On each applied batch: advance the oracle, translate written keys/docs into
  // point ranges, and push the transition into the sync handler.
  const tailer = new ReplicaTailer(client, pgStore, replica, {
    onInvalidation: async (inv: AppliedInvalidation) => {
      // Wrapped so a rejection never surfaces as an unhandled promise rejection (the tailer awaits
      // this and would leave one otherwise); reactivity is best-effort — reads stay correct.
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
    },
  });
  await tailer.start(); // READY GATE: resolves only after the replica has caught up to the primary.
  // Enable read-your-own-writes: a client that wrote through this node waits for the replica's
  // watermark to reach that write's commitTs before its next read is served off the replica.
  forwarder.attachTailer(tailer);

  let promoting = false;
  lease.acquireLoop((state) => {
    if (promoting) return;
    promoting = true;
    void state; // (writerUrl now points at us via the lease tryAcquire() just upserted)
    // C5: the promotion sequence is wrapped — any step failure exits(1) instead of leaving this node
    // stuck half-promoted with an unhandled rejection. On success the lease monitor is armed (this
    // node is now the writer) and the http layer drops its proxy.
    void runPromotion({
      // The lease row is already upserted by the tryAcquire() inside acquireLoop before this fires.
      promote: () => promoteFleetNode({ runtime, pgStore, switchable, forwarder, tailer, replica }),
      startMonitor: startWriterMonitor,
      firePromoted,
      onExit,
    });
  });

  return {
    role: () => (forwarder.isLocalWriter() ? "writer" : "sync"),
    writerUrl: async () => (await lease.read())?.writerUrl ?? "",
    onPromoted: (cb) => promotedCbs.push(cb),
    stop: async () => {
      monitor?.stop(); // disarm writer self-exit BEFORE the connection is closed (if promoted)
      lease.stop();
      await tailer.stop();
      // This node owns the Postgres store's lifecycle (it's not the serve runtime store for a sync
      // node). Close it here so the pg connection is released; `NodePgClient.close()` is idempotent,
      // so a later `switchable.close()` (if promotion had swapped it in) is a safe no-op. The
      // replica is closed either by promotion (swapped out) or by serve's `store.close()` on the
      // switchable (unpromoted) — never here, to avoid a double close.
      await pgStore.close();
    },
  };
}
