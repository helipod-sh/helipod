/**
 * The shared boot core for `stackbase dev` and `stackbase serve`: load the project, compose
 * app + components, open the SQLite store, build the embedded runtime + admin API. Neither writes
 * codegen nor starts a server — the callers own those (dev writes _generated + watches; serve
 * hardens + serves).
 */
import { mkdirSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NodeSqliteAdapter, BunSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { NodePgClient, BunSqlClient, PostgresDocStore, type PgClient } from "@stackbase/docstore-postgres";
import type { DocStore } from "@stackbase/docstore";
import {
  createEmbeddedRuntime,
  type EmbeddedRuntime,
  type WriteRouter,
  type EmbeddedWriteFanoutAdapter,
} from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, browseTableModule, systemModules, verifyAdminKey } from "@stackbase/admin";
import type { GeneratedBundle } from "@stackbase/codegen";
import type { ComponentDefinition, Driver, WakeHost } from "@stackbase/component";
import type { RegisteredFunction } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { BlobStore } from "@stackbase/blobstore";
import type { ObjectStore } from "@stackbase/objectstore";
import { shardIdList, DEFAULT_SHARD } from "@stackbase/id-codec";
import {
  storageContextProvider,
  storageReaper,
  storageModules,
  storageRoutes,
  type StorageRoute,
  type StorageRouteDeps,
} from "@stackbase/storage";
import { receiptsReaper } from "@stackbase/receipts";
import { makeBlobStore, isS3Config, resolveStorageConfig, type StorageConfig } from "./blobstore-select";
import { resolveObjectStore } from "./objectstore-select";
import { ReplicaWriteForwarder } from "./replica-forward";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { detectRuntime } from "./dev-options";
import type { ProjectArtifacts, LoadedProject } from "./project";

/** True when `s` looks like a `postgres://`/`postgresql://` connection string (pure — no I/O). */
export function isPostgresUrl(s: string | undefined): boolean {
  return !!s && /^postgres(ql)?:\/\//.test(s);
}

/**
 * Build the `PgClient` for a postgres `--database-url`/`STACKBASE_DATABASE_URL`. Under the Bun
 * runtime (the single-binary/`serve` production runtime) uses `BunSqlClient` — native `Bun.SQL`,
 * ~10-17% faster than the `pg` driver; under Node (or any non-Bun host) falls back to `NodePgClient`.
 * Both implement the same `PgClient` seam, so `PostgresDocStore` and everything downstream is
 * unaffected by which one gets picked.
 */
export function makePgClient(connectionString: string): PgClient {
  return detectRuntime() === "bun" ? new BunSqlClient({ connectionString }) : new NodePgClient({ connectionString });
}

export function makeStore(opts: { dataPath: string; databaseUrl?: string }): DocStore {
  if (isPostgresUrl(opts.databaseUrl)) {
    return new PostgresDocStore(makePgClient(opts.databaseUrl!));
  }
  mkdirSync(dirname(resolve(opts.dataPath)), { recursive: true });
  const adapter =
    detectRuntime() === "bun" ? new BunSqliteAdapter({ path: opts.dataPath }) : new NodeSqliteAdapter({ path: opts.dataPath });
  return new SqliteDocStore(adapter);
}

// ── Tier 3 Slice 6 (Task 6.3): the object-storage writer node ──────────────────────────────────
// `stackbase serve --object-store <url>` boots a single-shard (shard "0") writer node whose store is
// the Tier 3 object-storage substrate (`@stackbase/objectstore-substrate`) instead of the usual
// SQLite/Postgres store. Mirrors the fleet-store-bypass shape: `bootLoaded`'s `store = opts.fleet?.
// store ?? objectStoreOverride ?? makeStore(...)`. The substrate is an ENTERPRISE (`ee/`) package —
// core `packages/cli` keeps ZERO static/type dependency on it (same discipline `serve.ts`'s
// `FleetModule` applies to `@stackbase/fleet`): the shapes below are hand-declared structural
// mirrors, loaded only via a dynamic, non-literal `import()` so `tsc`/bundlers never resolve it
// either. A deployment that never sets `--object-store` pays nothing — the import is never reached.

/** The subset of `ObjectStoreDocStore`'s API this module drives directly (`acquire`/`heartbeat`/
 *  `release`, plus the full `DocStore` surface every other boot code path already expects). */
export interface ObjectStoreWriterStore extends DocStore {
  acquire(opts: {
    writerId: string;
    leaseTtlMs: number;
    now: number;
  }): Promise<{ acquired: true } | { acquired: false; heldBy: string; expiresAt: number }>;
  heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void>;
  release(): void;
  /** Tier 3 Slice 6, Task 6.5: the graceful-shutdown variant of `release()` — best-effort CAS-clears
   *  the lease in the bucket itself so a challenger's `acquire()` takes over immediately instead of
   *  waiting out the full TTL. See `ObjectStoreDocStore.relinquish()`'s doc. */
  relinquish(): Promise<void>;
  /** Tier 3 Slice 7, Task 7.1/7.2: best-effort, self-fencing reclamation of superseded segments/
   *  snapshots. Driven automatically on a cadence by the gc-driver (Task 7.3) once registered. */
  gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }>;
}

/** Structural mirror of `@stackbase/objectstore-substrate`'s public surface this module needs. */
export interface ObjectStoreSubstrateModule {
  ObjectStoreDocStore: {
    open(opts: { objectStore: ObjectStore; shard: string; local: SqliteDocStore }): Promise<ObjectStoreWriterStore>;
  };
  /** Tier 3 multi-shard single-node serve: the N-lane composite DocStore — routes writes by
   *  `shardId` to the owning lane, fans reads out + merges across lanes (k-way merge for ordered
   *  index scans). Constructed over a `Map<shardId, ObjectStoreDocStore>` when `--shards N` (N>1). */
  ShardedObjectStoreDocStore: new (
    lanes: ReadonlyMap<string, DocStore>,
    opts?: { defaultShard?: string },
  ) => DocStore;
  ensureGlobals(
    objectStore: ObjectStore,
    globals: { deploymentId: string; numShards: number },
  ): Promise<{ deploymentId: string; numShards: number }>;
  leaseHeartbeatDriver(
    store: { heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void> },
    opts: { leaseTtlMs: number; heartbeatMs: number; onFenced?: (e: Error) => void },
  ): Driver;
  gcDriver(
    store: { gc(): Promise<{ deletedSegments: number; deletedSnapshots: number }> },
    opts: { sweepMs: number },
  ): Driver;
  /** Tier 3 Slice 8, Task 8.2: the replica reactive-tailer wiring helper (Task 8.1). `runtime` is
   *  typed as the real `EmbeddedRuntime` here (already a core, non-enterprise import in this
   *  module) rather than the ee package's own narrower structural mirror — `EmbeddedRuntime`
   *  satisfies it, and the real substrate module accepts anything shaped like it at runtime. */
  startReplicaReactiveTailer(opts: {
    runtime: EmbeddedRuntime;
    objectStore: ObjectStore;
    shard: string;
    local: SqliteDocStore;
    consumerId: string;
    pollMs?: number;
  }): { stop(): Promise<void> };
  /** Tier 3 Slice 8, Task 8.2: deregister a departed consumer's watermark (shutdown). */
  removeConsumer(objectStore: ObjectStore, shard: string, consumerId: string): Promise<void>;
  /** Object-storage reshard (offline): change a STOPPED deployment's shard count N→M by physically
   *  re-partitioning each doc's current state to `shardIdForKeyValue(doc[shardKey], M)`'s lane. */
  reshardObjectStore(opts: {
    objectStore: ObjectStore;
    toShards: number;
    now: number;
    shardKeyFor: (tableNumber: number) => string | null;
    makeLocal: () => SqliteDocStore;
  }): Promise<{ fromShards: number; toShards: number; movedDocs: number; perLaneCounts: Record<string, number> }>;
}

export const OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE =
  "stackbase: --object-store requires @stackbase/objectstore-substrate — install it (bun add @stackbase/objectstore-substrate).";

/**
 * True when `e` is one of this module's object-store fail-fast BOOT errors — the ee-package-missing
 * gate (`OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE`), `acquireWithRetry`'s "held by '<writer>' until …"
 * timeout, and every `resolveObjectStore` parse/validation throw (bad scheme, missing bucket,
 * missing credentials, unparseable URL) — all of which share the `"stackbase: --object-store"` /
 * `"stackbase: invalid --object-store"` message prefix. `serveCommand` uses this to print a clean
 * `✗ <message>` instead of a raw stack trace for these KNOWN, actionable misconfigurations.
 *
 * Deliberately narrow: it does NOT match `assertCasSupported()`'s runtime bucket-connectivity
 * errors (a live AWS SDK network/permissions failure, unprefixed) — those are left to surface with
 * their full stack, since misclassifying a genuine crash as a tidy one-liner would hide the real
 * cause.
 */
export function isObjectStoreBootFailFast(e: unknown): e is Error {
  return e instanceof Error && /^stackbase: (--object-store|invalid --object-store)\b/.test(e.message);
}

/** Dynamic-import gate for the ee substrate package (mirrors `serve.ts`'s `@stackbase/fleet` gate:
 *  an indirect (non-literal) specifier so `tsc` never statically resolves the enterprise package). */
export async function loadObjectStoreSubstrateModule(): Promise<ObjectStoreSubstrateModule> {
  try {
    const specifier: string = "@stackbase/objectstore-substrate";
    return (await import(specifier)) as unknown as ObjectStoreSubstrateModule;
  } catch {
    throw new Error(OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE);
  }
}

/** Bounded retry over `store.acquire(...)` (Task 6.3): `acquire()` is a single attempt that returns
 *  `{acquired:false, heldBy, expiresAt}` when a DIFFERENT live writer currently holds the shard —
 *  this polls until acquired or `timeoutMs` elapses, then fails fast with a clear "held by" message.
 *  A crashed predecessor's lease simply expires on its own (no CAS involved in expiry), so a fresh
 *  boot's retry loop takes over automatically once `timeoutMs` covers the remaining TTL — no manual
 *  intervention needed for the common failover case. Exported for direct unit testing (no bucket
 *  needed — a fake `{acquire}` is enough). */
export async function acquireWithRetry(
  store: Pick<ObjectStoreWriterStore, "acquire">,
  opts: { writerId: string; leaseTtlMs: number; timeoutMs: number; pollIntervalMs?: number; now?: () => number },
): Promise<void> {
  const now = opts.now ?? Date.now;
  const pollIntervalMs = opts.pollIntervalMs ?? 1000;
  const deadline = now() + opts.timeoutMs;
  let last: { heldBy: string; expiresAt: number } | undefined;
  for (;;) {
    const result = await store.acquire({ writerId: opts.writerId, leaseTtlMs: opts.leaseTtlMs, now: now() });
    if (result.acquired) return;
    last = { heldBy: result.heldBy, expiresAt: result.expiresAt };
    if (now() >= deadline) {
      throw new Error(
        `stackbase: --object-store shard "0" held by '${last.heldBy}' until ${new Date(last.expiresAt).toISOString()} — ` +
          `timed out after ${opts.timeoutMs}ms waiting for the lease to free up. If '${last.heldBy}' crashed, its lease ` +
          `will expire on its own and a retry will take over; otherwise stop that writer before starting this one.`,
      );
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/** Construct the concrete `SqliteDocStore` the substrate's `ObjectStoreDocStore.open()` needs as its
 *  local materialize target — the same adapter-selection logic as `makeStore`'s SQLite branch, but
 *  narrowly typed to `SqliteDocStore` (not the widened `DocStore`) since `open()` calls SQLite-
 *  specific methods (`dumpCurrentState`) the generic `DocStore` interface doesn't declare. Always
 *  SQLite regardless of `--database-url` — the object-store path's local cache is never Postgres. */
function makeLocalSqliteStore(dataPath: string): SqliteDocStore {
  mkdirSync(dirname(resolve(dataPath)), { recursive: true });
  const adapter =
    detectRuntime() === "bun" ? new BunSqliteAdapter({ path: dataPath }) : new NodeSqliteAdapter({ path: dataPath });
  return new SqliteDocStore(adapter);
}

/** A throwaway in-memory `SqliteDocStore` (runtime-appropriate adapter) — the `objectstore reshard`
 *  tool's per-lane materialization/commit target (`reshardObjectStore`'s `makeLocal`). Exported so the
 *  reshard command can hand it in without re-deriving the Bun-vs-Node adapter pick. */
export function makeInMemorySqliteStore(): SqliteDocStore {
  const adapter =
    detectRuntime() === "bun" ? new BunSqliteAdapter({ path: ":memory:" }) : new NodeSqliteAdapter({ path: ":memory:" });
  return new SqliteDocStore(adapter);
}

/** Mirrors `@stackbase/runtime-embedded`'s own private `DEPLOYMENT_ID_GLOBAL_KEY` (and
 *  `@stackbase/fleet`'s exported `FLEET_DEPLOYMENT_ID_KEY`) — the same well-known magic string, not
 *  otherwise exported for cross-package reuse (fleet re-declares its own copy too). `createEmbeddedRuntime`
 *  reads-or-mints this global on `options.store` right after boot; pre-seeding it here (carried note
 *  I1) makes a fresh local materialization ADOPT the bucket's `FleetGlobals.deploymentId` instead of
 *  the runtime minting a brand-new one — which would otherwise flip every outbox client to
 *  `known:false` on a from-scratch node. `writeGlobalIfAbsent` no-ops if this dataPath already carries
 *  a value (a same-node restart) — never overwrite an existing stamp. */
const RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY = "fleet:deploymentId";

/** Default lease TTL (ms) — mirrors `@stackbase/fleet`'s own default (`STACKBASE_FLEET_LEASE_TTL_MS`
 *  unset case). Overridable via `bootLoaded`'s `objectStoreLeaseTtlMs` (tests only; not a CLI flag). */
export const DEFAULT_OBJECTSTORE_LEASE_TTL_MS = 15000;
/** Default heartbeat cadence (ms) — comfortably under the lease TTL (see `leaseHeartbeatDriver`'s own
 *  `heartbeatMs < leaseTtlMs` assertion). */
export const DEFAULT_OBJECTSTORE_HEARTBEAT_MS = 5000;
/** Default gc-driver sweep cadence (ms) — Tier 3 Slice 7, Task 7.3. gc() is best-effort/idempotent/
 *  self-fencing (Task 7.1), so there's no correctness ratio to enforce against the lease TTL the way
 *  the heartbeat has — this is purely a reclamation-latency-vs-sweep-cost tradeoff, mirroring
 *  `storageReaper`'s own 60s default. Overridable via `STACKBASE_OBJECTSTORE_GC_MS` (env, production
 *  tuning) or `bootLoaded`'s `objectStoreGcMs` option (tests). */
export const DEFAULT_OBJECTSTORE_GC_MS = 60000;

/**
 * Build (ee-gate → resolve → adopt globals → materialize → acquire) a Tier 3 object-storage writer
 * node's store (Task 6.3). Returns the store to use at the `opts.fleet?.store ?? …` seam, any extra
 * drivers to register (the lease-heartbeat), and a `release` handle for graceful shutdown — which
 * calls `store.relinquish()` (Task 6.5), NOT the in-process-only `store.release()`, so a challenger
 * can take over the shard immediately instead of waiting out the full lease TTL. Throws (fail-fast)
 * on: a CAS-unsupported object store, `@stackbase/objectstore-substrate` not installed, or a
 * bounded-retry acquire timeout (another live writer holds the shard).
 */
async function buildObjectStoreWriterNode(opts: {
  objectStoreUrl: string;
  dataPath: string;
  onFenced?: (e: Error) => void;
  leaseTtlMs?: number;
  heartbeatMs?: number;
  acquireTimeoutMs?: number;
  /** Test-only: shorten `acquireWithRetry`'s poll cadence (default 1000ms) so a short-`leaseTtlMs`
   *  takeover test doesn't wait a full second per retry. Not surfaced as a CLI flag. */
  acquirePollIntervalMs?: number;
  writerId?: string;
  /** Tier 3 Slice 7, Task 7.3: the gc-driver's sweep cadence — unset → `DEFAULT_OBJECTSTORE_GC_MS`. */
  gcMs?: number;
  /** Tier 3 multi-shard single-node serve: the number of object-storage lanes this ONE node owns.
   *  Unset / `<= 1` → the shipped single-shard path (one `ObjectStoreDocStore` over shard "0",
   *  byte-identical to before). `> 1` → this node opens+acquires+heartbeats+gcs EVERY lane in
   *  `shardIdList(shards)` (`["default","s1",…]`) and composes them behind a
   *  `ShardedObjectStoreDocStore`; the engine's `numShards`-sized `ShardedTransactor` then routes
   *  each write to its owning lane and reads fan out + merge across all lanes. */
  shards?: number;
}): Promise<{ store: DocStore; drivers: Driver[]; release: () => Promise<void>; numShards: number }> {
  const resolved = resolveObjectStore(opts.objectStoreUrl);
  if (resolved === null) {
    throw new Error(`stackbase: --object-store "${opts.objectStoreUrl}" did not resolve to a store (empty/unset value?).`);
  }
  await resolved.objectStore.assertCasSupported();

  const substrate = await loadObjectStoreSubstrateModule();
  const writerId = opts.writerId ?? randomUUID();
  const leaseTtlMs = opts.leaseTtlMs ?? DEFAULT_OBJECTSTORE_LEASE_TTL_MS;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_OBJECTSTORE_HEARTBEAT_MS;
  // A crashed predecessor's lease is only reclaimable once it expires — give the retry window enough
  // room to actually observe that (leaseTtlMs) plus a margin for polling/clock skew, unless overridden.
  const acquireTimeoutMs = opts.acquireTimeoutMs ?? leaseTtlMs + 5000;
  const gcMs = opts.gcMs ?? DEFAULT_OBJECTSTORE_GC_MS;

  // Slice-4 carried note I1: adopt the bucket's existing deployment identity (never overwrite it) —
  // a fresh deployment mints one here (non-determinism is fine at this CLI-adjacent layer). The
  // `numShards` passed is the DESIRED count for a FRESH bucket (from `--shards`); `ensureGlobals`
  // ADOPTS an existing bucket's count, so the RETURN value is authoritative below.
  const desiredShards = opts.shards && opts.shards > 1 ? opts.shards : 1;
  const globals = await substrate.ensureGlobals(resolved.objectStore, {
    deploymentId: randomUUID(),
    numShards: desiredShards,
  });

  // The bucket's PERSISTED shard count is authoritative — a resharded bucket (its globals set by
  // `objectstore reshard`) boots the right lanes without the operator re-specifying `--shards`. A
  // `--shards` that disagrees fails fast (reshard the bucket to change the count, never silently
  // mis-open lanes against the existing layout). The lane bucket prefixes: `numShards === 1` → the
  // single "0" lane (born-single-shard OR resharded-to-1 — one unambiguous layout per count);
  // `> 1` → the canonical `shardIdList` ids (identity with the engine's routing shardIds).
  const numShards = globals.numShards;
  if (opts.shards !== undefined && opts.shards !== numShards) {
    throw new Error(
      `stackbase: --shards ${opts.shards} disagrees with the bucket's persisted shard count ${numShards} — ` +
        `reshard the bucket (\`stackbase objectstore reshard --object-store <url> --dir <convex> --shards ${opts.shards}\`) ` +
        `to change it, or drop --shards.`,
    );
  }
  const shardIds: string[] = numShards > 1 ? [...shardIdList(numShards)] : ["0"];

  // Build ONE lane: open (materialize its own local SQLite) → seed the runtime's deployment-id
  // global so `createEmbeddedRuntime` adopts the bucket's identity → acquire its lease → arm its
  // heartbeat + gc drivers. Each lane is an independent `s{shardId}/…` prefix + local file.
  const buildLane = async (
    shardId: string,
    laneDataPath: string,
  ): Promise<{ lane: ObjectStoreWriterStore; heartbeat: Driver; gc: Driver }> => {
    const local = makeLocalSqliteStore(laneDataPath);
    const lane = await substrate.ObjectStoreDocStore.open({ objectStore: resolved.objectStore, shard: shardId, local });
    await lane.writeGlobalIfAbsent(RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY, globals.deploymentId);
    await acquireWithRetry(lane, {
      writerId,
      leaseTtlMs,
      timeoutMs: acquireTimeoutMs,
      ...(opts.acquirePollIntervalMs !== undefined ? { pollIntervalMs: opts.acquirePollIntervalMs } : {}),
    });
    const heartbeat = substrate.leaseHeartbeatDriver(lane, {
      leaseTtlMs,
      heartbeatMs,
      onFenced: (e) => opts.onFenced?.(e),
    });
    // Tier 3 Slice 7, Task 7.3: the periodic reclamation driver — self-fencing/best-effort (Task 7.1),
    // so it needs no `onFenced`-style shutdown wiring the way the heartbeat does.
    const gc = substrate.gcDriver(lane, { sweepMs: gcMs });
    return { lane, heartbeat, gc };
  };

  // Lanes are built SEQUENTIALLY (each acquire may retry against a crashed predecessor's TTL, and a
  // fresh multi-shard node acquiring all lanes serially is fine at boot). Single-shard keeps the
  // exact `opts.dataPath`; multi-shard gives each lane its own `<dataPath>.<shardId>` local file.
  const built: Array<{ shardId: string; lane: ObjectStoreWriterStore; heartbeat: Driver; gc: Driver }> = [];
  for (const shardId of shardIds) {
    const laneDataPath = numShards > 1 ? `${opts.dataPath}.${shardId}` : opts.dataPath;
    built.push({ shardId, ...(await buildLane(shardId, laneDataPath)) });
  }

  const drivers = built.flatMap((b) => [b.heartbeat, b.gc]);
  // Graceful shutdown relinquishes EVERY owned lane's bucket lease (best-effort, in parallel) so a
  // successor takes each over immediately rather than waiting out the TTL — see `relinquish()`'s doc.
  const release = async (): Promise<void> => {
    await Promise.all(built.map((b) => b.lane.relinquish()));
  };

  if (numShards === 1) return { store: built[0]!.lane, drivers, release, numShards };

  // Multi-shard: compose the lanes behind the routing/merging `ShardedObjectStoreDocStore`. Its
  // default lane ("default") is `shardIdList(N)[0]` — always present — and is where deployment-level
  // globals/receipts resolve (a single source of truth), matching `ensureGlobals`' own default.
  const lanes = new Map<string, DocStore>(built.map((b) => [b.shardId, b.lane]));
  const store = new substrate.ShardedObjectStoreDocStore(lanes, { defaultShard: DEFAULT_SHARD });
  return { store, drivers, release, numShards };
}

// ── Tier 3 Slice 8 (Task 8.2): the object-storage REPLICA node ─────────────────────────────────
// `stackbase serve --object-store <url> --replica` boots a read-scaled REPLICA instead of a writer:
// it MATERIALIZES the shard from the bucket (`ObjectStoreDocStore.open`, same as the writer) but
// NEVER `acquire()`s the write lease, and runs no heartbeat/gc drivers — only the Task 8.1 reactive-
// tailer wiring helper (`startReplicaReactiveTailer`), started AFTER the runtime is built (its sink
// needs the runtime; see `replica-wiring.ts`'s module doc for the chicken-and-egg). Mutation
// rejection is then FREE: `commitWriteBatch` already throws "not the lease owner" for an
// unacquired store — `wrapReplicaWriteRejection` below only improves that message's wording.

/** Tier 3 Slice 8, Task 8.2: the DX-clear message a mutation sees when routed to a `--replica`
 *  node, in place of the substrate's internal "not the lease owner" wording (accurate, but not
 *  meaningful to an app developer who doesn't know the substrate's lease vocabulary). See
 *  `wrapReplicaWriteRejection`'s doc. */
export const REPLICA_WRITE_REJECTED_MESSAGE =
  "stackbase: this node is a read replica (--replica) — it holds no write lease and cannot commit " +
  "mutations. Send writes to the primary/writer node.";

const LEASE_OWNER_REJECTION_RE = /not the lease owner/;

/**
 * Decorate `store` so `commitWrite`/`commitWriteBatch` re-throw `REPLICA_WRITE_REJECTED_MESSAGE` in
 * place of `ObjectStoreDocStore`'s internal "not the lease owner" error — every other error (a
 * genuine bug, a validation failure) and every other `DocStore` method (reads, globals, close, …)
 * pass through UNCHANGED.
 *
 * Implemented as a `Proxy` whose `get` trap `.bind(target)`s every forwarded function to the REAL
 * underlying instance rather than the proxy itself — required because `ObjectStoreDocStore` uses a
 * genuine JS private method internally (`#maybeSnapshotBestEffort`, called from inside its own
 * `commitWriteBatch`); invoking a method with `this` bound to a Proxy instead of the real instance
 * would throw ("cannot read private member from an object whose class did not declare it") the
 * moment that private access executes. `.bind(target)` sidesteps the hazard without needing to
 * enumerate `DocStore`'s ~20 methods by hand (mirroring `ObjectStoreDocStore`'s own "everything
 * else: forward" section, but generically, over whatever `DocStore` happens to declare).
 */
export function wrapReplicaWriteRejection(store: DocStore): DocStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (prop !== "commitWrite" && prop !== "commitWriteBatch") return bound;
      return async (...args: unknown[]): Promise<unknown> => {
        try {
          return await bound(...args);
        } catch (e) {
          if (e instanceof Error && LEASE_OWNER_REJECTION_RE.test(e.message)) {
            throw new Error(REPLICA_WRITE_REJECTED_MESSAGE);
          }
          throw e;
        }
      };
    },
  });
}

/** Test-only default when `bootLoaded`'s `objectStoreReplicaConsumerId` is unset — a per-process
 *  random id so N replicas over one bucket never collide on the same `s{shard}/consumers/{id}` key. */
function defaultReplicaConsumerId(): string {
  return `replica-${randomUUID()}`;
}

/** Default poll interval (ms) for a replica's reactive tailer (Task 8.2) — mirrors
 *  `ObjectStoreReplicaTailer`'s own shipped default. Overridable via `bootLoaded`'s
 *  `objectStoreReplicaPollMs` (tests only; not a CLI flag). */
export const DEFAULT_OBJECTSTORE_REPLICA_POLL_MS = 1000;

/**
 * Build (ee-gate → resolve → adopt globals → materialize, NO acquire) a Tier 3 object-storage
 * REPLICA node's store (Task 8.2, design record §7/§8; multi-shard generalization
 * `docs/superpowers/plans/2026-02-20-multi-shard-replicas.md`). Unlike `buildObjectStoreWriterNode`,
 * this never calls `acquire()` — the returned store rejects every mutation for free (the class doc's
 * "the neat part"), surfaced via `wrapReplicaWriteRejection`'s clear DX message.
 *
 * The lane count is read from the bucket's `globals.numShards` (authoritative — a replica has no
 * `--shards` flag): `numShards === 1` opens the single "0" lane (byte-identical to the shipped path);
 * `> 1` opens one materialize-only lane per `shardIdList(numShards)` id and composes them behind the
 * shipped `ShardedObjectStoreDocStore` read composite. Every mutation is single-lane, so the N lanes
 * are tailed INDEPENDENTLY (no cross-lane ordering); `observeTimestamp` is monotonic-max so the N
 * per-lane tailers advancing the same runtime's oracle is safe.
 *
 * Returns the store to use at `bootLoaded`'s store seam, its `numShards` (so `bootLoaded` sizes the
 * runtime's `ShardedTransactor`/composite to match, exactly like the writer path), plus
 * `attachTailer(runtime)` — call this AFTER `createEmbeddedRuntime` builds the replica's own runtime
 * (the tailer's sink needs it; see `replica-wiring.ts`'s module doc for why this can't be a driver
 * passed INTO the runtime itself). `attachTailer` starts one `startReplicaReactiveTailer` PER LANE and
 * returns a `release()` handle that stops every tailer AND `removeConsumer`s every lane's watermark
 * (so a departed replica stops pinning ANY lane's writer gc) — the shutdown handle `bootLoaded` threads
 * out as `BootResult.objectStoreRelease`, same field the writer path uses (mutually exclusive by
 * construction — `serve.ts` calls whichever one boot actually built, identically either way).
 */
async function buildObjectStoreReplicaNode(opts: {
  objectStoreUrl: string;
  dataPath: string;
  /** Test-only: force a deterministic consumer-watermark id. Unset → `defaultReplicaConsumerId()`. */
  consumerId?: string;
  /** Test-only: shorten the tailer's poll cadence. Unset → `DEFAULT_OBJECTSTORE_REPLICA_POLL_MS`. */
  pollMs?: number;
}): Promise<{
  store: DocStore;
  numShards: number;
  attachTailer: (runtime: EmbeddedRuntime) => () => Promise<void>;
}> {
  const resolved = resolveObjectStore(opts.objectStoreUrl);
  if (resolved === null) {
    throw new Error(`stackbase: --object-store "${opts.objectStoreUrl}" did not resolve to a store (empty/unset value?).`);
  }
  await resolved.objectStore.assertCasSupported();

  const substrate = await loadObjectStoreSubstrateModule();
  const objectStore = resolved.objectStore;

  // Same adopt-not-mint identity discipline as the writer path (see `RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY`'s
  // doc comment) — a replica must NEVER mint a fresh deploymentId; it always adopts whatever the bucket
  // (established by the writer, or an earlier node) already carries. The RETURNED count is authoritative:
  // a multi-shard bucket (writer `--shards N`, or `objectstore reshard`) boots the right lanes here.
  const globals = await substrate.ensureGlobals(objectStore, { deploymentId: randomUUID(), numShards: 1 });
  const numShards = globals.numShards;
  const shardIds: string[] = numShards > 1 ? [...shardIdList(numShards)] : ["0"];

  // Open + MATERIALIZE each lane (NO acquire — Tier 3 Slice 4's `open()` claims no ownership). Each lane
  // gets its own local SQLite file: `<dataPath>.<shardId>` for multi-shard; the bare `dataPath` for the
  // byte-identical single "0" lane.
  const lanes: Array<{ shardId: string; store: DocStore; local: SqliteDocStore }> = [];
  for (const shardId of shardIds) {
    const laneDataPath = numShards > 1 ? `${opts.dataPath}.${shardId}` : opts.dataPath;
    const local = makeLocalSqliteStore(laneDataPath);
    const laneStore = await substrate.ObjectStoreDocStore.open({ objectStore, shard: shardId, local });
    await laneStore.writeGlobalIfAbsent(RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY, globals.deploymentId);
    lanes.push({ shardId, store: laneStore, local });
  }

  // Single lane → the store directly (byte-identical). Multi-shard → the shipped fan-out+merge composite,
  // whose default lane is `shardIdList(N)[0] === "default"` (where deployment-level globals resolve).
  const composite: DocStore =
    numShards === 1
      ? lanes[0]!.store
      : new substrate.ShardedObjectStoreDocStore(new Map(lanes.map((l) => [l.shardId, l.store])), {
          defaultShard: DEFAULT_SHARD,
        });
  const store = wrapReplicaWriteRejection(composite);

  const baseConsumerId = opts.consumerId ?? defaultReplicaConsumerId();
  const pollMs = opts.pollMs ?? DEFAULT_OBJECTSTORE_REPLICA_POLL_MS;
  // Per-lane watermark id: the BARE `baseConsumerId` for the single "0" lane (byte-compat — the shipped
  // replica E2E asserts `s0/consumers/<id>`); `${baseConsumerId}:${shardId}` per lane for multi-shard,
  // so each lane's watermark lives under its own `s{shard}/consumers/` and floors only THAT lane's gc.
  const laneConsumerId = (shardId: string): string => (numShards === 1 ? baseConsumerId : `${baseConsumerId}:${shardId}`);

  return {
    store,
    numShards,
    attachTailer: (runtime: EmbeddedRuntime) => {
      // One tailer per lane, all driving the SAME runtime's reactive fan-out.
      const handles = lanes.map((l) =>
        substrate.startReplicaReactiveTailer({
          runtime,
          objectStore,
          shard: l.shardId,
          local: l.local,
          consumerId: laneConsumerId(l.shardId),
          pollMs,
        }),
      );
      return async () => {
        await Promise.all(handles.map((h) => h.stop()));
        await Promise.all(lanes.map((l) => substrate.removeConsumer(objectStore, l.shardId, laneConsumerId(l.shardId))));
      };
    },
  };
}

// ── Shards B2a (T5): NUM_SHARDS first-boot config ──────────────────────────────────────────────
// Decided ONCE, at first boot, and immutable after: `STACKBASE_FLEET_SHARDS` (or the fleet
// default of 8) is persisted via `writeGlobalIfAbsent` the first time the store is writable; every
// later boot reads the persisted value back and fails fast if an explicitly-set env value now
// disagrees with it (resharding online isn't supported — that's B5's offline tool).

/** Default shard count when neither `STACKBASE_FLEET_SHARDS` nor a persisted value is present.
 *  Mirrors `@stackbase/fleet`'s own `DEFAULT_NUM_SHARDS` (kept as an independent literal here —
 *  core `packages/cli` has zero static dependency on the enterprise `@stackbase/fleet` package). */
export const DEFAULT_NUM_SHARDS = 8;

/** The `persistence_globals` key the resolved shard count is stamped under (same store contract —
 *  SQLite/Postgres, fleet/non-fleet — `getGlobal`/`writeGlobalIfAbsent` all implement it). */
export const NUM_SHARDS_GLOBAL_KEY = "fleet:numShards";

/** Parse `STACKBASE_FLEET_SHARDS` — a positive integer, else undefined (falls through to the
 *  persisted value, or the default on a fresh deployment). Mirrors `serve.ts`'s
 *  `parseLeaseTtlMs` shape for the other fleet-adjacent env knob. */
export function parseNumShards(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : undefined;
}

/**
 * Parse `STACKBASE_GROUP_COMMIT` (Fleet B4) — a boolean env flag, same `1`/`true`/`yes`
 * (case-insensitive) shape `@stackbase/fleet`'s `fleetMultiWriterEnabled` uses for
 * `STACKBASE_FLEET_MULTI_WRITER`. This is just the token PARSER (truthy = `1`/`true`/`yes`); the
 * single-node DEFAULT when the var is unset is store-conditional — see `resolveGroupCommit`. Unlike `STACKBASE_FLEET_
 * SHARDS`, group commit needs no persist-once story: it's a per-boot transactor construction choice,
 * not a durable invariant the log depends on, so a plain env read (no `resolveNumShards`-style
 * mismatch-fail-fast) is the right shape.
 */
export function groupCommitEnabled(raw: string | undefined): boolean {
  return /^(1|true|yes)$/i.test(raw ?? "");
}

/**
 * Resolve the single-node (non-fleet) group-commit default. An explicit `STACKBASE_GROUP_COMMIT`
 * always wins (either direction). When it is unset, the default is STORE-CONDITIONAL: ON for
 * Postgres, OFF for SQLite. Rationale (benchmark, `docs/dev/research/writes-benchmark.md`): group
 * commit batches concurrent commits into one fsync — a strict win on fsync-bound Postgres (+39% at
 * 8 clients, +58% at 64, and byte-identical latency at 1 client thanks to the opportunistic "batch
 * of 1 when idle" design, so no low-traffic regression) but a ~8% loss on CPU-bound in-memory
 * SQLite (nothing to amortize, pure pipeline overhead). Fleet B4 gated auto-enable on a single
 * GLOBAL 2× threshold and missed (1.63×), shipping dark-off; the per-store data shows the win is
 * store-dependent, so a store-conditional default is the correct refinement (scoped to the
 * single-node path — the fleet path still threads its own `STACKBASE_GROUP_COMMIT` read).
 */
export function resolveGroupCommit(opts: { envRaw: string | undefined; databaseUrl: string | undefined }): boolean {
  const raw = opts.envRaw;
  if (raw !== undefined && raw !== "") return groupCommitEnabled(raw); // explicit override, either way
  return isPostgresUrl(opts.databaseUrl); // default: ON for Postgres, OFF for SQLite
}

/** Build the fail-fast message for a `STACKBASE_FLEET_SHARDS` value that disagrees with what's
 *  already persisted — named verbatim so tests can assert on it without re-deriving the string. */
export function numShardsMismatchError(envValue: number, persisted: number): Error {
  return new Error(
    `stackbase: STACKBASE_FLEET_SHARDS=${envValue} conflicts with the shard count already persisted ` +
      `for this deployment (${persisted}, set at first boot). The shard count is immutable after ` +
      `first boot — changing it live isn't supported; resharding is a planned offline tool (B5). ` +
      `Unset STACKBASE_FLEET_SHARDS, or set it to ${persisted} to match the existing deployment.`,
  );
}

/**
 * Resolve NUM_SHARDS against `store`'s persisted `fleet:numShards` global: a persisted value wins
 * (immutable after first boot) — an explicitly-set `envValue` that disagrees fails fast, naming
 * both. No persisted value → `envValue ?? DEFAULT_NUM_SHARDS`, persisted now via
 * `writeGlobalIfAbsent` so every later boot (fleet or not) sees the same count. `store` must
 * already have run `setupSchema()` (the `persistence_globals` table must exist) — `getGlobal`/
 * `writeGlobalIfAbsent` are plain KV ops, not gated by a `DocStore`'s writer/read-only mode (a
 * fleet sync node's read-only Postgres client can call this too; see `serve.ts`'s fleet wiring,
 * which resolves before any node's writer-vs-sync election).
 *
 * Guards a concurrent-first-boot race (two nodes racing `writeGlobalIfAbsent` on a fresh
 * deployment with disagreeing envs): if this call loses the race (`writeGlobalIfAbsent` returns
 * false — a peer's row landed first), it re-reads the now-persisted value and re-applies the same
 * mismatch check against it, so a genuine env disagreement still fails fast instead of silently
 * running with whichever value happened to land in Postgres.
 */
export async function resolveNumShards(
  store: Pick<DocStore, "getGlobal" | "writeGlobalIfAbsent">,
  envValue: number | undefined,
): Promise<number> {
  const persistedRaw = await store.getGlobal(NUM_SHARDS_GLOBAL_KEY);
  if (persistedRaw !== null) {
    const persisted = Number(persistedRaw);
    if (envValue !== undefined && envValue !== persisted) throw numShardsMismatchError(envValue, persisted);
    return persisted;
  }
  const resolved = envValue ?? DEFAULT_NUM_SHARDS;
  const wrote = await store.writeGlobalIfAbsent(NUM_SHARDS_GLOBAL_KEY, String(resolved));
  if (wrote) return resolved;
  // Lost a concurrent first-boot race — adopt whichever value actually landed, and still enforce
  // the mismatch check against OUR env (agreeing with our own losing guess no longer matters).
  const raced = Number(await store.getGlobal(NUM_SHARDS_GLOBAL_KEY));
  if (envValue !== undefined && envValue !== raced) throw numShardsMismatchError(envValue, raced);
  return raced;
}

export interface BootResult {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  project: ProjectArtifacts;
  generated: GeneratedBundle;
  store: DocStore;
  logSink: InMemoryLogSink;
  /** The boot-time component set (from stackbase.config.ts) — `applyDeploy` re-composes against it. */
  components: ComponentDefinition[];
  /** The always-on file-storage byte backend (FS or S3), shared by the provider/reaper/routes. */
  blobStore: BlobStore;
  /**
   * The engine-owned `/api/storage/*` handlers (upload/confirm/serve). Reserved-path routes the
   * server splices into its dispatch (NOT user `http.ts` routes) — see `server.ts`.
   */
  storageRoutes: StorageRoute[];
  /**
   * Reserved engine routes contributed by composed components (e.g. `@stackbase/auth`'s
   * `/api/auth/oauth/*`), each bound to `runtime.runHttpAction` and shaped as an engine-owned
   * `StorageRoute` `{method,pathPrefix,handler}` so `server.ts` dispatches them exactly like the
   * always-on storage routes. Fixed at boot (the component set is fixed at boot — only functions/
   * schema hot-swap), so no `setRoutes` live-swap is needed. Empty when no component declares routes.
   */
  componentRoutes: StorageRoute[];
  /**
   * Set only when `objectStoreUrl` was given — the object-store node's graceful-shutdown handle.
   * `serve.ts`'s shutdown calls this AFTER `server.close()` and BEFORE `store.close()`. Two shapes,
   * mutually exclusive by construction (at most one of `replica`/writer ever built this boot):
   *   - Writer (Tier 3 Slice 6, Task 6.5): `store.relinquish()`, which best-effort CAS-clears the
   *     lease IN THE BUCKET, not just in-process — see `ObjectStoreDocStore.relinquish()`'s doc —
   *     so a challenger takes over immediately instead of waiting out the full TTL.
   *   - Replica (Tier 3 Slice 8, Task 8.2): stops the reactive-tailer wiring helper (Task 8.1) and
   *     `removeConsumer`s this replica's watermark, so a departed replica stops pinning the
   *     writer's gc — see `buildObjectStoreReplicaNode`'s doc.
   */
  objectStoreRelease?: () => Promise<void>;
  /**
   * Tier 3 Slice 8 follow-on (replica write-forwarding): set only when this boot is a
   * `--replica` configured with `--writer-url` (i.e. a `ReplicaWriteForwarder` was wired in as
   * the runtime's `writeRouter`). `serve.ts` threads this straight through to
   * `startDevServer`'s `replicaWriterUrl` option, which arms `/api/run`'s single-hop defensive
   * guard (`http-handler.ts`). Absent whenever `--writer-url` is unset (the pre-existing
   * reject-with-message replica behavior, unchanged) or this isn't a replica boot at all.
   */
  replicaWriterUrl?: string;
}

/**
 * Merge the always-on `_storage:*` privileged built-ins into a function map. The `_storage` modules
 * must live in the runtime's `modules` map (not just `systemModules`) because the action-mode
 * `ctx.storage.store` reaches them through the trusted `invoke`, and the reaper driver through
 * `runFunction` — both resolve `modules`. Since `setModules` (dev reload / `stackbase deploy`)
 * REPLACES `modules` wholesale, every such swap must re-apply this so storage survives a hot-swap.
 */
export function withStorageModules(map: Record<string, RegisteredFunction>): Record<string, RegisteredFunction> {
  return { ...map, ...storageModules };
}

/**
 * Fail fast when S3-shaped settings (`STACKBASE_STORAGE_ENDPOINT`/`REGION`/`PUBLIC_URL`, or their
 * `--storage-endpoint`/etc. flag equivalents) are present but no bucket was configured. Those
 * settings only make sense for the S3 backend, which is selected SOLELY by `STACKBASE_STORAGE_BUCKET`
 * (`isS3Config`) — so their presence without a bucket is an unambiguous misconfiguration by an
 * operator who intended S3 but forgot the bucket. Silently falling back to local FS in that case is
 * a data-durability footgun: uploads land on ephemeral local disk (gone on the next container
 * recreate) instead of the object store the operator configured. Refuse to boot with an actionable
 * error rather than start in a silently-wrong state. The AWS credential vars (`AWS_ACCESS_KEY_ID`/
 * `AWS_SECRET_ACCESS_KEY`) are intentionally NOT treated as S3 intent — they're commonly present for
 * unrelated reasons, so keying off them would false-positive on plain FS deployments.
 */
export function assertStorageConfigCoherent(storage: StorageConfig | undefined): void {
  if (isS3Config(storage)) return;
  const s3Shaped = storage?.endpoint !== undefined || storage?.region !== undefined || storage?.publicBaseUrl !== undefined;
  if (!s3Shaped) return;
  throw new Error(
    "stackbase: S3 storage settings (STACKBASE_STORAGE_ENDPOINT/REGION/PUBLIC_URL or --storage-endpoint/etc.) " +
      "are set, but no bucket was provided — the S3 backend is selected only by STACKBASE_STORAGE_BUCKET " +
      "(or --storage-bucket). Set the bucket to use S3, or unset the other storage settings to use local FS. " +
      "Refusing to boot rather than silently store uploads on local disk.",
  );
}

/**
 * Fail fast if the FS file-storage dir can't be created/written — an operator misconfiguration
 * (read-only mount, wrong owner) must surface as a clear boot error, never a silent-later failure
 * on the first upload. Skipped for the S3 backend (no local dir).
 */
function ensureStorageDirWritable(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
  } catch (e) {
    throw new Error(
      `stackbase: file-storage directory "${dir}" is not creatable/writable — ${e instanceof Error ? e.message : String(e)}. ` +
        `Point --data at a writable location, or configure S3 storage (set STACKBASE_STORAGE_BUCKET).`,
    );
  }
}

/**
 * Every input the boot core takes. `bootProject` DERIVES its own options from this type (rather than
 * re-declaring them) and forwards them with a spread — see `BootProjectOptions`'s doc for why that
 * matters. Adding an option here therefore reaches `bootProject`'s public surface automatically; the
 * only keys that don't are the two `bootProject` produces itself (`loaded`/`components`).
 */
export interface BootLoadedOptions {
  loaded: LoadedProject;
  components: ComponentDefinition[];
  dataPath: string;
  adminKey: string;
  /** Postgres connection string; when unset, falls back to the zero-config SQLite file store. */
  databaseUrl?: string;
  /** File-storage backend overrides (CLI flags win over env, resolved via `resolveStorageConfig`). */
  storage?: StorageConfig;
  /**
   * Override the pending-upload TTL (ms) the `ctx.storage` provider stamps on `expiresAt`. Unset →
   * the provider default (1h). Exists so tests can force a short reap deadline; production leaves
   * it at the default.
   */
  storageUploadTtlMs?: number;
  /**
   * Override the orphan-reaper's sweep interval (ms). Unset → the reaper default (60s). Same
   * test-only motivation as `storageUploadTtlMs`.
   */
  storageReaperSweepMs?: number;
  /**
   * Tier 2 fleet wiring (from `@stackbase/fleet`'s `prepareFleetNode`). When set, `store` is the
   * pre-constructed (read-only-until-promoted) Postgres store — used INSTEAD of `makeStore` — and
   * the runtime is built as a fleet node: writes route through `writeRouter` when this node isn't
   * the writer, drivers are deferred until promotion (`deferDrivers`), and a promoted writer's
   * commits fan out via `fanoutAdapter` (pg_notify). Absent for dev / non-fleet serve.
   */
  fleet?: {
    store: DocStore;
    writeRouter?: WriteRouter;
    deferDrivers?: boolean;
    fanoutAdapter?: EmbeddedWriteFanoutAdapter;
    /** Shards B2a: shard count — >1 builds a ShardedTransactor (per-shard parallel commits). */
    numShards?: number;
    /** Fleet B3 hybrid (multi-writer): the replica-backed query store (queries route here; mutations
     *  commit to `store`). Threaded straight into `createEmbeddedRuntime`. */
    queryStore?: DocStore;
    /** Receipted Outbox (verdict §(c) placement): the authoritative receipts store the Connect handshake
     *  classifies/prunes against — the PRIMARY on a sync node (whose `store` is the receipt-less replica),
     *  so the handshake never spuriously resets. Threaded straight into `createEmbeddedRuntime`. */
    receiptsStore?: DocStore;
    /** Fleet B3 hybrid RYOW: awaited in the runtime fan-out drain before a local commit's re-runs. */
    beforeNotify?: (commitTs: bigint) => Promise<void>;
    /** Fleet B4: group commit — resolved by `@stackbase/fleet`'s `node.ts` from its OWN
     *  `STACKBASE_GROUP_COMMIT` read (mirrors how `numShards` is resolved fleet-side, before
     *  `bootLoaded` runs) and threaded straight into `createEmbeddedRuntime`. Unset → `false`. */
    groupCommit?: boolean;
    /** Triggers D1: the stable-prefix accessor for `DriverContext.readLog` (`min(shard_leases.frontier_ts)`
     *  in a fleet). Threaded straight into `createEmbeddedRuntime`; absent outside a fleet. */
    stablePrefix?: () => Promise<bigint | null>;
    /** Receipted Outbox: fleet owns the `clientReceiptsGuard()` registration on the concrete Postgres
     *  store (in `armWriter`, before the fence) — so `createEmbeddedRuntime` must SKIP its own, which
     *  would land on a sync node's `SwitchableDocStore` and vanish on the promotion swapTo. Threaded
     *  straight into `createEmbeddedRuntime`; absent outside a fleet (the runtime owns it there). */
    externalReceiptsGuard?: boolean;
  };
  /**
   * Tier 3 Slice 6: object-storage substrate writer node. When set, `store` (at the `opts.fleet?.
   * store ?? … ?? makeStore(...)` seam below) becomes an `ObjectStoreDocStore` over this URL's
   * bucket (shard "0") instead of the usual SQLite/Postgres store — see `buildObjectStoreWriterNode`'s
   * doc comment. Mutually exclusive with `fleet` (Tier 2 and Tier 3 are alternative write-scaling
   * stories); combining both throws.
   */
  objectStoreUrl?: string;
  /** Called once, synchronously, the moment the lease-heartbeat driver detects this node has been
   *  fenced (lost the shard-0 lease to a challenger). `serve.ts` wires this to trigger graceful
   *  shutdown. Ignored when `objectStoreUrl` is unset. */
  objectStoreOnFenced?: (e: Error) => void;
  /** Test-only overrides (mirrors `storageUploadTtlMs`'s pattern) — unset → the production defaults
   *  (`DEFAULT_OBJECTSTORE_LEASE_TTL_MS`/`DEFAULT_OBJECTSTORE_HEARTBEAT_MS`/`leaseTtlMs + 5000`). */
  objectStoreLeaseTtlMs?: number;
  objectStoreHeartbeatMs?: number;
  objectStoreAcquireTimeoutMs?: number;
  objectStoreAcquirePollIntervalMs?: number;
  /** Test-only: force a deterministic writer id instead of a fresh `randomUUID()` per boot. */
  objectStoreWriterId?: string;
  /** Tier 3 Slice 7, Task 7.3: the gc-driver's sweep cadence (ms). Unset → `DEFAULT_OBJECTSTORE_GC_MS`
   *  (~60s). `serve.ts` threads `STACKBASE_OBJECTSTORE_GC_MS` in here; tests can also set it directly
   *  to force an observable reclamation on a short timescale. Ignored when `objectStoreUrl` is unset. */
  objectStoreGcMs?: number;
  /** Tier 3 multi-shard single-node serve: the number of object-storage lanes a `--object-store`
   *  WRITER node owns (`serve.ts` threads `--shards`/`STACKBASE_FLEET_SHARDS` in here). Unset / `1`
   *  → the shipped single-shard path (shard "0"), byte-identical. `> 1` → this node opens+acquires
   *  all `shardIdList(N)` lanes and composes a `ShardedObjectStoreDocStore`; the runtime's
   *  `numShards` is sized to N so the `ShardedTransactor` routes writes to the owning lane. Ignored
   *  for a `--replica` boot (a replica reads its lane count from the bucket's `globals.numShards`, not
   *  this flag — it has no `--shards` of its own) and when `objectStoreUrl` is unset. */
  objectStoreShards?: number;
  /** Tier 3 Slice 8, Task 8.2: boot this node as a READ-ONLY REPLICA of `objectStoreUrl`'s shard
   *  instead of a writer — materializes + tails, NEVER acquires the write lease (every mutation is
   *  rejected with `REPLICA_WRITE_REJECTED_MESSAGE`), and runs no heartbeat/gc drivers. Requires
   *  `objectStoreUrl` (throws if set without it — `serve.ts` also validates this at the CLI-flag
   *  level, before ever reaching here). Ignored (no-op) when `objectStoreUrl` is unset. */
  replica?: boolean;
  /** Test-only: force a deterministic consumer-watermark id for the replica's tailer. Ignored
   *  unless `replica` is set. See `buildObjectStoreReplicaNode`'s `consumerId`. */
  objectStoreReplicaConsumerId?: string;
  /** Test-only: shorten the replica's reactive-tailer poll cadence so a materialize-and-fan-out
   *  round is observable within a test's timescale. Unset → `DEFAULT_OBJECTSTORE_REPLICA_POLL_MS`
   *  (1000ms). Ignored unless `replica` is set. */
  objectStoreReplicaPollMs?: number;
  /**
   * Tier 3 Slice 8 follow-on: the writer node's URL, from `--writer-url`/`STACKBASE_WRITER_URL`.
   * When set on a `replica` boot, every mutation/action is FORWARDED here (`ReplicaWriteForwarder`,
   * wired in as `createEmbeddedRuntime`'s `writeRouter`) instead of being rejected locally.
   * Ignored unless `replica` is also set. Unset (the default) → today's unchanged reject-with-
   * `REPLICA_WRITE_REJECTED_MESSAGE` behavior.
   */
  writerUrl?: string;
  /**
   * The wake seam: the host's single alarm, for a host that STOPS THE PROCESS between requests (so
   * `setTimeout` never fires and every driver silently goes dead). `serve.ts` builds this from
   * `--wake-url`/`STACKBASE_WAKE_URL` (`httpWakeHost`); the runtime then multiplexes every driver
   * timer down to one arm. Threaded straight into `createEmbeddedRuntime`. Unset (every existing
   * deployment) → plain `setTimeout`, byte-for-byte unchanged.
   */
  wakeHost?: WakeHost;
  /**
   * The wake seam's other half: answers `DriverContext.backstopMs`, the floor/stretch applied to a
   * driver's BACKSTOP poll cadence only (never a next-work wake). `serve.ts` builds this from
   * `--backstop-min-ms`/`STACKBASE_BACKSTOP_MIN_MS`. Threaded straight into `createEmbeddedRuntime`.
   * Unset → identity (the drivers' own 30s/60s), byte-for-byte unchanged.
   */
  backstopMs?: (defaultMs: number) => number;
}

export async function bootLoaded(opts: BootLoadedOptions): Promise<BootResult> {
  const { project, generated } = push(opts.loaded, opts.components);
  const logSink = new InMemoryLogSink();

  if (opts.objectStoreUrl !== undefined && opts.fleet) {
    throw new Error("stackbase: --object-store cannot be combined with --fleet (Tier 2) — pick one write-scaling story.");
  }
  if (opts.replica && opts.objectStoreUrl === undefined) {
    // Defense in depth: `serve.ts` already validates this synchronously at the CLI-flag level,
    // before ever calling `bootProject`/`bootLoaded` — this only guards a direct `bootLoaded` caller
    // (e.g. a test) that sets `replica` without `objectStoreUrl`.
    throw new Error(
      "stackbase: --replica requires --object-store — a replica materializes from an object-storage bucket; pass --object-store <url>.",
    );
  }
  // Tier 3 Slice 6/8: ee-gate → resolve → adopt globals → materialize → (writer only) acquire the
  // shard-0 lease BEFORE anything else boots — a failed acquire (another live writer holds it) must
  // fail the whole boot fast, not leave a runtime half-constructed over a store this process doesn't
  // own. A `--replica` node (Task 8.2) never acquires — see `buildObjectStoreReplicaNode`.
  const objectStoreWriterNode =
    opts.objectStoreUrl !== undefined && !opts.replica
      ? await buildObjectStoreWriterNode({
          objectStoreUrl: opts.objectStoreUrl,
          dataPath: opts.dataPath,
          onFenced: opts.objectStoreOnFenced,
          leaseTtlMs: opts.objectStoreLeaseTtlMs,
          heartbeatMs: opts.objectStoreHeartbeatMs,
          acquireTimeoutMs: opts.objectStoreAcquireTimeoutMs,
          acquirePollIntervalMs: opts.objectStoreAcquirePollIntervalMs,
          writerId: opts.objectStoreWriterId,
          gcMs: opts.objectStoreGcMs,
          ...(opts.objectStoreShards !== undefined ? { shards: opts.objectStoreShards } : {}),
        })
      : undefined;
  const objectStoreReplicaNode =
    opts.objectStoreUrl !== undefined && opts.replica
      ? await buildObjectStoreReplicaNode({
          objectStoreUrl: opts.objectStoreUrl,
          dataPath: opts.dataPath,
          consumerId: opts.objectStoreReplicaConsumerId,
          pollMs: opts.objectStoreReplicaPollMs,
        })
      : undefined;
  const store =
    opts.fleet?.store ??
    objectStoreWriterNode?.store ??
    objectStoreReplicaNode?.store ??
    makeStore({ dataPath: opts.dataPath, databaseUrl: opts.databaseUrl });

  // Multi-shard replicas + write-forwarding is NOT yet supported, and fails fast rather than shipping
  // a latent disappearing-write bug. Write-forwarding relies on the G4 origin-frontier fallback
  // (`SyncProtocolHandler.pendingFrontiers`/`sweepPendingFrontiers`): a forwarded mutation commits on
  // the writer, and the replica advances the origin session's observed frontier once its tailer drains
  // past that commit ts. But a multi-shard replica runs ONE tailer PER LANE, each sweeping pending
  // frontiers with ITS OWN lane's ts — and per-lane object-store timestamps are independent counters,
  // not a shared clock. So a fast lane's sweep could satisfy a forwarded frontier owned by a lane that
  // hasn't applied the write yet → the client drops its optimistic layer while the authoritative row is
  // still absent from the replica (a transient RYOW/no-flicker violation). The tested + shipped
  // multi-shard replica config is REJECT-mode (no `--writer-url`); forwarding on a multi-shard bucket
  // needs a per-lane pending-frontier design (a future slice). Reject-mode single-shard forwarding and
  // reject-mode multi-shard are both unaffected.
  if (objectStoreReplicaNode && opts.writerUrl !== undefined && objectStoreReplicaNode.numShards > 1) {
    throw new Error(
      `stackbase: --writer-url (replica write-forwarding) is not yet supported on a multi-shard bucket ` +
        `(this bucket has ${objectStoreReplicaNode.numShards} shards) — run the replica in reject mode (drop --writer-url) ` +
        `and send writes directly to the writer, or use a single-shard deployment.`,
    );
  }
  // Tier 3 Slice 8 follow-on (replica write-forwarding): a replica boot with `--writer-url` set
  // gets a `ReplicaWriteForwarder` wired in as the runtime's `writeRouter` below — every
  // mutation/action forwards to the writer instead of attempting (and failing) a local commit.
  // Unset `writerUrl` (the default) → no writeRouter, unchanged reject-with-message behavior.
  const replicaWriteForwarder =
    objectStoreReplicaNode && opts.writerUrl !== undefined ? new ReplicaWriteForwarder(opts.writerUrl) : undefined;

  // Shards B2a (T5): resolve NUM_SHARDS. A fleet caller (`serve.ts --fleet`) has ALREADY resolved
  // + persisted its count against the durable Postgres store BEFORE `prepareFleetNode` (which needs
  // the number up front, to size the per-shard commit-connection pool) and threads it in as
  // `opts.fleet.numShards` — a sync node's `opts.fleet.store` here is its LOCAL replica, not the
  // durable store, so resolving/persisting generically against `store` below would be wrong for
  // that role. Non-fleet (dev, `serve` without `--fleet`, the single binary): resolve right here,
  // against the one store there is — `setupSchema()` is idempotent (`createEmbeddedRuntime` below
  // calls it again), so calling it early just to make `persistence_globals` queryable is safe.
  let numShards: number;
  if (opts.fleet) {
    numShards = opts.fleet.numShards ?? 1;
  } else if (objectStoreWriterNode || objectStoreReplicaNode) {
    // Tier 3 multi-shard serve: a `--object-store` WRITER owns N lanes (each its own bucket prefix +
    // local + lease/heartbeat/gc, composed behind `ShardedObjectStoreDocStore`); a `--replica` now
    // MATERIALIZES + tails the same N lanes behind the same read composite (one tailer per lane). The
    // engine's `numShards`-sized `ShardedTransactor` routes/reads over exactly the lanes each built.
    await store.setupSchema();
    // Authoritative count comes from the bucket's persisted globals (resolved inside the writer/replica
    // build, which for the writer fails fast on a `--shards` mismatch) — NOT `opts.objectStoreShards`
    // directly, so a resharded bucket boots the right `numShards` on both roles even if `--shards` is
    // omitted. Whichever role this boot built reports its lane count here.
    numShards = objectStoreWriterNode?.numShards ?? objectStoreReplicaNode?.numShards ?? 1;
  } else {
    await store.setupSchema();
    numShards = await resolveNumShards(store, parseNumShards(process.env.STACKBASE_FLEET_SHARDS));
  }

  // Fleet B4 (T4): resolve GROUP_COMMIT the same shape as `numShards` above — a fleet caller has
  // already resolved its own `STACKBASE_GROUP_COMMIT` read (mirrors `fleetMultiWriterEnabled`'s
  // pattern in `@stackbase/fleet`'s `node.ts`) and threads it in as `opts.fleet.groupCommit`; the
  // non-fleet path (dev, `serve` without `--fleet`, the single binary) reads the env var directly.
  // No persist-once story needed (see `groupCommitEnabled`'s doc comment) — a plain per-boot read.
  const groupCommit = opts.fleet
    ? (opts.fleet.groupCommit ?? false)
    : resolveGroupCommit({ envRaw: process.env.STACKBASE_GROUP_COMMIT, databaseUrl: opts.databaseUrl });

  // File storage is always on. Blobs sit beside the SQLite file (`<dataDir>/storage`); the signing
  // key is the deployment admin key (already fail-fasted-if-unset by `serve`). The `_storage` table
  // itself was injected into the composed schema/catalog/tableNumbers in `loadProject`.
  const dataDir = dirname(resolve(opts.dataPath));
  const storageConfig = resolveStorageConfig(process.env, opts.storage);
  assertStorageConfigCoherent(storageConfig);
  const blobStore = makeBlobStore({ dataPath: dataDir, storage: storageConfig });
  if (!isS3Config(storageConfig)) ensureStorageDirWritable(join(dataDir, "storage"));

  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    // `_storage:*` built-ins go in BOTH maps: `modules` (reached by the action facade's `invoke`
    // and the reaper's `runFunction`) and `systemModules` (reached by the HTTP routes' `runSystem`,
    // the same trusted path `_admin` uses). `systemModules` isn't swapped by `setModules`, so it
    // persists across reload/deploy on its own; `modules` is re-applied via `withStorageModules`.
    modules: withStorageModules(project.moduleMap),
    systemModules: { ...systemModules(), ...storageModules },
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(opts.adminKey, key),
    componentNames: project.componentNames,
    // Prepend the `ctx.storage` provider and the orphan-reaper driver to whatever components composed.
    contextProviders: [
      storageContextProvider(blobStore, {
        signingKey: opts.adminKey,
        ...(opts.storageUploadTtlMs !== undefined ? { uploadTtlMs: opts.storageUploadTtlMs } : {}),
      }),
      ...project.contextProviders,
    ],
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: [
      storageReaper(blobStore, opts.storageReaperSweepMs !== undefined ? { sweepMs: opts.storageReaperSweepMs } : undefined),
      // Receipted Outbox TTL reaper (verdict §(c) Retention): a timer-only bulk sweep of expired
      // `client_mutations` rows. Always on (every deployment has the receipts tables); no-op work when
      // no client ever wrote a receipt. Reads the SAME `store` the runtime commits to.
      receiptsReaper(store),
      // Tier 3 Slice 6: the lease-heartbeat + gc drivers (renews shard-0's lease on cadence; stops +
      // signals via `objectStoreOnFenced` on a fence). Writer-only — empty outside the object-store
      // writer path (absent entirely for a `--replica` node, Task 8.2: no heartbeat, no gc — a
      // replica holds no lease and reclaims nothing; its OWN reactive-tailer wiring is started
      // separately, below, once the runtime exists).
      ...(objectStoreWriterNode?.drivers ?? []),
      ...project.drivers,
    ],
    // Fleet (Tier 2): route writes to the lease-holder when not the writer, defer drivers until
    // promotion, and (writer boot) fan out commits cross-process via pg_notify.
    ...(opts.fleet?.writeRouter ? { writeRouter: opts.fleet.writeRouter } : {}),
    // Tier 3 Slice 8 follow-on (replica write-forwarding): mutually exclusive with `opts.fleet`
    // (guarded at the top of this function — `--object-store` + `--fleet` throws), so at most one
    // of these two `writeRouter` spreads ever contributes a key.
    ...(replicaWriteForwarder ? { writeRouter: replicaWriteForwarder } : {}),
    ...(opts.fleet?.deferDrivers ? { deferDrivers: true } : {}),
    ...(opts.fleet?.fanoutAdapter ? { fanoutAdapter: opts.fleet.fanoutAdapter } : {}),
    // Fleet B3 hybrid (multi-writer): the replica-backed query path + the own-commit RYOW drain gate.
    ...(opts.fleet?.queryStore ? { queryStore: opts.fleet.queryStore } : {}),
    // Receipted Outbox (verdict §(c) placement): route the Connect handshake's classification/ack-prune
    // to the authoritative PRIMARY receipts store on a sync node (whose `store` is the receipt-less
    // replica) — without this the handshake spuriously resets a client. Absent → the runtime uses `store`.
    ...(opts.fleet?.receiptsStore ? { receiptsStore: opts.fleet.receiptsStore } : {}),
    ...(opts.fleet?.beforeNotify ? { beforeNotify: opts.fleet.beforeNotify } : {}),
    // Triggers D1: the fleet stable-prefix bound for `readLog` (`min(shard_leases.frontier_ts)`).
    ...(opts.fleet?.stablePrefix ? { stablePrefix: opts.fleet.stablePrefix } : {}),
    // Receipted Outbox: fleet owns the receipts guard on the concrete Postgres store (armWriter,
    // before the fence) — the runtime skips its own registration so it never lands on a sync node's
    // SwitchableDocStore only to vanish on the promotion swapTo. Non-fleet → the runtime owns it.
    ...(opts.fleet?.externalReceiptsGuard ? { externalReceiptsGuard: true } : {}),
    // Shards B2a: >1 → a ShardedTransactor (per-shard parallel commits) over the store — resolved
    // above (fleet: threaded in already-resolved; non-fleet: resolved+persisted just now).
    numShards,
    // Fleet B4 (T4): route every shard's commits through the group-commit committer loop — resolved
    // above (fleet: threaded in already-resolved; non-fleet: read from STACKBASE_GROUP_COMMIT).
    groupCommit,
    // The wake seam (`serve --wake-url` / `--backstop-min-ms`): a host that stops the process between
    // requests fires driver timers via `runtime.fireDueTimers()` instead of `setTimeout`, and can
    // stretch the pure-backstop cadences so an idle app isn't cold-started every 30s. Both absent →
    // today's `setTimeout` + 30s/60s behavior, unchanged.
    ...(opts.wakeHost ? { wakeHost: opts.wakeHost } : {}),
    ...(opts.backstopMs ? { backstopMs: opts.backstopMs } : {}),
  });

  // Tier 3 Slice 8, Task 8.2: NOW that the replica's own runtime exists, start the reactive-tailer
  // wiring helper (Task 8.1) — it can't be a driver passed INTO `createEmbeddedRuntime` above
  // because its sink needs the runtime itself (chicken-and-egg; see `replica-wiring.ts`'s module
  // doc). `attachTailer` returns the shutdown handle (stop the tailer + `removeConsumer`).
  const objectStoreReplicaRelease = objectStoreReplicaNode ? objectStoreReplicaNode.attachTailer(runtime) : undefined;

  const storageRouteDeps: StorageRouteDeps = {
    // The routes reach the privileged `_storage:_finalize`/`_get` built-ins via `runSystem` (trusted,
    // like `_admin`), which reads `systemModules` — unaffected by any later `setModules` swap.
    runMutation: async (path, args) => (await runtime.runSystem(path, args as JSONValue)).value,
    runQuery: async (path, args) => (await runtime.runSystem(path, args as JSONValue)).value,
    signingKey: opts.adminKey,
    // When authz isn't composed (the default), leave `checkRead` undefined so `handleServe` falls
    // back to the capability-token check (a private file's `getUrl` embeds a valid token). See the
    // task-10 report for the authz effective-permissions bridge status.
    checkRead: makeStorageCheckRead(opts.components),
  };
  const routes = storageRoutes(blobStore, storageRouteDeps);

  // Component-contributed reserved routes (Task A3-1): bind each declared httpAction to the runtime
  // and shape it as an engine-owned `StorageRoute`. The raw `Authorization: Bearer <token>` is passed
  // straight through as `identity` (no resolution — same convention `httpAction`/storage use).
  const bearerOf = (request: Request): string | null => {
    const h = request.headers.get("authorization");
    const m = h ? /^Bearer\s+(.+)$/.exec(h) : null;
    return m ? (m[1] ?? null) : null;
  };
  const componentRoutes: StorageRoute[] = project.componentRoutes.map((r) => ({
    method: r.method,
    pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: bearerOf(request) }),
  }));

  const adminApi = new AdminApi({
    runtime,
    schemaJson: project.schemaJson,
    tableNumbers: project.tableNumbers,
    manifest: project.manifest,
    logSink,
    catalog: project.catalog,
  });
  return {
    runtime,
    adminApi,
    project,
    generated,
    store,
    logSink,
    components: opts.components,
    blobStore,
    storageRoutes: routes,
    componentRoutes,
    // Mutually exclusive by construction (Task 8.2 guards `objectStoreUrl !== undefined && !replica`
    // vs. `&& replica`) — at most one of these two spreads ever contributes a key, so `serve.ts`'s
    // shutdown can call `objectStoreRelease()` generically without knowing which node type booted.
    ...(objectStoreWriterNode ? { objectStoreRelease: objectStoreWriterNode.release } : {}),
    ...(objectStoreReplicaRelease ? { objectStoreRelease: objectStoreReplicaRelease } : {}),
    // Tier 3 Slice 8 follow-on (replica write-forwarding): threaded through so `serve.ts` can arm
    // `/api/run`'s single-hop defensive guard on THIS node (`startDevServer`'s `replicaWriterUrl`).
    ...(replicaWriteForwarder ? { replicaWriterUrl: opts.writerUrl } : {}),
  };
}

/**
 * The serve-endpoint read-authorization bridge for a PRIVATE `_storage` file. When the `authz`
 * component is composed, this would resolve the caller's effective-permissions read grant for the
 * `_storage` doc; when it isn't (the default), returns `undefined` so `handleServe` uses the
 * capability-token fallback instead of failing open.
 *
 * NOTE (task 10): the authz side is intentionally not wired yet — `components/authz` exposes only a
 * `resource:action`/scope `can()` check reachable inside a function context, with no per-`(table,id,
 * identity)` read primitive, and this boot layer holds only opaque `ComponentDefinition[]` (not the
 * authz config/context needed to evaluate it). Fabricating a permission convention here would be a
 * guess. The seam is threaded end-to-end so a real authz read-primitive can slot in without touching
 * the routes. Until then a composed-authz deployment still gates private files correctly via tokens.
 */
function makeStorageCheckRead(
  _components: ComponentDefinition[],
): StorageRouteDeps["checkRead"] {
  return undefined;
}

/**
 * `bootProject`'s options: everything `bootLoaded` takes, MINUS the two things `bootProject` exists
 * to produce itself, PLUS the `convexDir` it produces them from. Derived deliberately — never
 * re-declared.
 *
 * WHY (a trap this has already cost a full debug cycle — do not re-introduce it): `bootProject` used to
 * re-declare its own option type and forward every key BY HAND into a fresh object literal. That
 * shape drops options SILENTLY. TypeScript's excess-property check does not apply through a spread,
 * and every caller passes optional options via conditional spread
 * (`...(x !== undefined ? { k: v } : {})`, see `serve.ts`) — so a caller could hand `bootProject` a
 * key its type never declared, get ZERO diagnostics, and have the value vanish before it ever
 * reached `createEmbeddedRuntime`. That is exactly how the wake seam shipped dead: `serve.ts` built
 * a valid `httpWakeHost(--wake-url)`, `bootProject` dropped it, the runtime silently took the
 * `setTimeout` branch, and scheduled work never fired on a host that stops the process between
 * requests — with the whole suite green, because nothing type-checked or tested the seam BETWEEN
 * the two functions.
 *
 * Deriving from `BootLoadedOptions` + forwarding with a spread makes the drop structurally
 * impossible rather than merely caught: a new `bootLoaded` option is part of this type, and is
 * forwarded, the moment it is declared. The `Omit` is the ONLY exclusion list, and it is deliberate:
 * `loaded`/`components` are `bootProject`'s own outputs (`loadConvexDir`/`loadConfig`), so accepting
 * them from a caller would be meaningless. Anything else belongs here automatically.
 */
export type BootProjectOptions = Omit<BootLoadedOptions, "loaded" | "components"> & { convexDir: string };

export async function bootProject(opts: BootProjectOptions): Promise<BootResult> {
  // Destructure off ONLY what `bootProject` itself consumes/produces; `forwarded` is by construction
  // every remaining `BootLoadedOptions` key, so no option can be left behind. Keep this a spread —
  // re-introducing a hand-enumerated forward re-opens the silent-drop trap documented above (and
  // `boot-options-forwarding.test.ts` is what fails if you do).
  const { convexDir, ...forwarded } = opts;
  const loaded = await loadConvexDir(convexDir);
  const config = await loadConfig(dirname(convexDir));
  return bootLoaded({ ...forwarded, loaded, components: config.components });
}

/**
 * Load the built dashboard SPA and inject the admin key (same-origin, local-only) so it can call
 * `/_admin` without a login prompt. Returns undefined if the dashboard isn't built (→ stub).
 * Shared by `dev` (ephemeral loopback key) and `serve` (no key — the SPA prompts the operator).
 */
export function loadDashboard(adminKey: string | undefined): { distDir: string; html: string } | undefined {
  try {
    const indexPath = createRequire(import.meta.url).resolve("@stackbase/dashboard/dist");
    const distDir = dirname(indexPath);
    const raw = readFileSync(indexPath, "utf8");
    if (adminKey === undefined) return { distDir, html: raw }; // no key embedded → SPA prompts
    // Escape `<` so a key value can never break out of the inline <script> (e.g. `</script>`).
    const inject = `<script>window.__ADMIN_KEY__=${JSON.stringify(adminKey).replace(/</g, "\\u003c")}</script>`;
    return { distDir, html: raw.replace("</head>", `${inject}</head>`) };
  } catch {
    return undefined;
  }
}
