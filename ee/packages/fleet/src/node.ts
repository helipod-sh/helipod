/* Stackbase Enterprise. Licensed under the Stackbase Commercial License — see ee/LICENSE. */
/**
 * Fleet node composition (Task 6). Two entry points `stackbase serve --fleet` calls around the
 * shared `bootProject` boot core:
 *
 *  - `prepareFleetNode` — constructs the Postgres client + read-only store, sets up the lease
 *    table, and makes ONE `tryAcquire()` attempt. Its result decides the whole boot: acquired →
 *    a WRITER (writable store, drivers on, forwarder pre-promoted); not acquired → a SYNC replica
 *    (read-only store, drivers deferred, writes forwarded). BOTH roles get the pg_notify-wrapping
 *    `NotifyingFanoutAdapter` — a sync node's is inert until (if) it's later promoted, at which
 *    point its commits immediately wake the remaining followers instead of degrading them to the
 *    poll fallback for good. It returns the exact `createEmbeddedRuntime` option deltas the caller
 *    threads through `bootProject`.
 *
 *  - `startFleetNode` — called AFTER the runtime is built. For a sync node it starts the commit
 *    tailer (cross-process reactive fan-out) and the lease acquire loop, and on promotion runs the
 *    CRITICAL PROMOTION ORDER. For a writer node it just returns handles (already promoted).
 *
 * The HTTP layer consumes `FleetHandles`: `role()` decides whether to proxy public httpActions to
 * the writer, `writerUrl()` is that proxy target, `onPromoted()` lets it drop the proxy once this
 * node becomes the writer.
 */
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import {
  InMemoryWriteFanoutAdapter,
  type EmbeddedRuntime,
  type EmbeddedWriteFanoutAdapter,
  type WriteRouter,
} from "@stackbase/runtime-embedded";
import { keySuccessor, serializeKeyRange, indexKeyspaceId, type SerializedKeyRange } from "@stackbase/index-key-codec";
import { decodeStorageIndexId, encodeStorageTableId } from "@stackbase/id-codec";
import { LeaseManager } from "./lease";
import { CommitTailer, NotifyingFanoutAdapter, type DerivedInvalidation } from "./commit-notifier";
import { WriteForwarder } from "./forwarder";

/**
 * Convert a single written `(indexId, key)` pair into the sync handler's point range
 * `[key, keySuccessor(key))` — the exact same half-open encoding `RangeSet.addKey` uses for a
 * point read/write, so a follower's derived write range overlaps a subscription's recorded read
 * range under `rangesOverlap`.
 *
 * `indexId` here is the Postgres `indexes.index_id` column — the STORAGE index id produced by
 * `encodeStorageIndexId`, format `"<tableNumber>/<indexName>"` (e.g. `"10001/by_creation"`). That
 * is NOT the same string as the engine's keyspace id (`indexKeyspaceId`'s `"index:<table>:<name>"`
 * / `tableKeyspaceId`'s `"table:<table>"`, see `packages/index-key-codec/src/keyspace.ts`), which is
 * what `SerializedKeyRange.keyspace` — and `rangesOverlap` — actually compare on. So the storage id
 * must be decoded back into its parts and the keyspace REBUILT with the engine's own helper; feeding
 * the raw storage id straight through silently produces ranges that can never overlap anything.
 */
export function keyToPointRange(indexId: string, key: Uint8Array): SerializedKeyRange {
  const { tableNumber, indexName } = decodeStorageIndexId(indexId);
  const keyspace = indexKeyspaceId(encodeStorageTableId(tableNumber), indexName);
  return serializeKeyRange({ keyspace, start: key, end: keySuccessor(key) });
}

export interface FleetHandles {
  role(): "sync" | "writer";
  /** The current writer's URL — the proxy target for public httpActions handled on a sync node. */
  writerUrl(): Promise<string>;
  /** Register a callback fired once, when this node is promoted from sync to writer. */
  onPromoted(cb: () => void): void;
  stop(): Promise<void>;
}

/** The createEmbeddedRuntime option deltas the caller threads through `bootProject`. */
export interface FleetRuntimeOptions {
  store: PostgresDocStore;
  writeRouter: WriteRouter;
  deferDrivers: boolean;
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
}

export interface FleetPrep {
  client: NodePgClient;
  store: PostgresDocStore;
  lease: LeaseManager;
  forwarder: WriteForwarder;
  role: "sync" | "writer";
  runtimeOptions: FleetRuntimeOptions;
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
}): Promise<FleetPrep> {
  const client = new NodePgClient({ connectionString: deps.databaseUrl });
  // Read-only until (and unless) this node wins the lease. A follower still runs the idempotent
  // DDL in setupSchema but does NOT contend for the writer advisory lock (see PostgresDocStore).
  const store = new PostgresDocStore(client, { readOnly: true });
  const lease = new LeaseManager(client, { advertiseUrl: deps.advertiseUrl });
  const forwarder = new WriteForwarder(lease, { adminKey: deps.adminKey, selfUrl: deps.advertiseUrl });

  // EVERY fleet node — writer or sync — gets the pg_notify-wrapping fan-out adapter, not just the
  // node that wins the lease at boot. A sync node never commits (`InMemoryWriteFanoutAdapter.publish`
  // is only ever invoked by a LOCAL commit), so wrapping it here is inert until this node is
  // eventually promoted (see the promotion order in `startFleetNode`) — at which point its commits
  // immediately NOTIFY the remaining followers instead of leaving them degraded to the `pollMs`
  // fallback in `CommitTailer` for the rest of the process lifetime.
  const fanoutAdapter = new NotifyingFanoutAdapter(new InMemoryWriteFanoutAdapter(), client);

  await lease.setup();
  const acquired = await lease.tryAcquire();

  if (acquired) {
    // Writer boot: make the store writable and promote the forwarder so writes execute locally.
    store.setWritable();
    forwarder.promote();
    return {
      client,
      store,
      lease,
      forwarder,
      role: "writer",
      runtimeOptions: {
        store,
        writeRouter: forwarder,
        deferDrivers: false,
        fanoutAdapter,
      },
    };
  }

  // Sync boot: read-only store, drivers deferred until (if) promoted, writes forwarded.
  return {
    client,
    store,
    lease,
    forwarder,
    role: "sync",
    runtimeOptions: { store, writeRouter: forwarder, deferDrivers: true, fanoutAdapter },
  };
}

export interface StartFleetNodeDeps {
  client: NodePgClient;
  store: PostgresDocStore;
  runtime: EmbeddedRuntime;
  lease: LeaseManager;
  forwarder: WriteForwarder;
}

/**
 * Wire the running fleet node. A writer node is already fully live (promoted in `prepareFleetNode`,
 * drivers started at `create()`) — it just gets handles. A sync node starts the commit tailer and
 * the lease acquire loop, and promotes on acquire via the critical order below.
 */
export async function startFleetNode(deps: StartFleetNodeDeps): Promise<FleetHandles> {
  const { client, store, runtime, lease, forwarder } = deps;
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

  // Writer boot: nothing to start (store already writable, forwarder promoted, drivers running).
  if (forwarder.isLocalWriter()) {
    return {
      role: () => "writer",
      writerUrl: async () => (await lease.read())?.writerUrl ?? "",
      onPromoted: (cb) => promotedCbs.push(cb),
      stop: async () => {
        lease.stop();
      },
    };
  }

  // Sync boot: cross-process reactive fan-out. Derive what changed since our watermark straight
  // from the MVCC index log, translate written keys into point ranges, and push transitions.
  const tailer = new CommitTailer(client, store, {
    onInvalidation: async (inv: DerivedInvalidation) => {
      // Wrapped so a rejection never surfaces as an unhandled promise rejection (CommitTailer awaits
      // this and would leave one otherwise); reactivity is best-effort — reads stay correct.
      try {
        runtime.observeTimestamp(inv.newMaxTs);
        const ranges = inv.writtenKeys.map((k) => keyToPointRange(k.indexId, k.key));
        await runtime.handler.notifyWrites({
          tables: inv.writtenTables,
          ranges,
          commitTs: Number(inv.newMaxTs),
        });
      } catch (e) {
        console.error("fleet: commit invalidation failed", e);
      }
    },
  });
  await tailer.start();

  let promoting = false;
  lease.acquireLoop((state) => {
    void (async () => {
      if (promoting) return;
      promoting = true;
      // CRITICAL PROMOTION ORDER (see design §1). The lease row is already upserted by the
      // tryAcquire() inside acquireLoop before this callback fires.
      runtime.observeTimestamp(await store.maxTimestamp()); // 1. oracle past ALL history
      store.setWritable(); //                                   2. store now accepts writes
      forwarder.promote(); //                                   3. local writes execute (no forward)
      await tailer.stop(); //                                   4. writer uses its own fan-out
      await runtime.startDrivers(); //                          5. scheduler/reaper wake
      void state; // (writerUrl now points at us via the lease it just upserted)
      firePromoted(); //                                        6. http layer drops the proxy
    })();
  });

  return {
    role: () => (forwarder.isLocalWriter() ? "writer" : "sync"),
    writerUrl: async () => (await lease.read())?.writerUrl ?? "",
    onPromoted: (cb) => promotedCbs.push(cb),
    stop: async () => {
      lease.stop();
      await tailer.stop();
    },
  };
}
