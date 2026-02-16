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
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
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
import type { ComponentDefinition, Driver } from "@stackbase/component";
import type { RegisteredFunction } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { BlobStore } from "@stackbase/blobstore";
import type { ObjectStore } from "@stackbase/objectstore";
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
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { detectRuntime } from "./dev-options";
import type { ProjectArtifacts, LoadedProject } from "./project";

/** True when `s` looks like a `postgres://`/`postgresql://` connection string (pure — no I/O). */
export function isPostgresUrl(s: string | undefined): boolean {
  return !!s && /^postgres(ql)?:\/\//.test(s);
}

export function makeStore(opts: { dataPath: string; databaseUrl?: string }): DocStore {
  if (isPostgresUrl(opts.databaseUrl)) {
    return new PostgresDocStore(new NodePgClient({ connectionString: opts.databaseUrl! }));
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
}

/** Structural mirror of `@stackbase/objectstore-substrate`'s public surface this module needs. */
export interface ObjectStoreSubstrateModule {
  ObjectStoreDocStore: {
    open(opts: { objectStore: ObjectStore; shard: string; local: SqliteDocStore }): Promise<ObjectStoreWriterStore>;
  };
  ensureGlobals(
    objectStore: ObjectStore,
    globals: { deploymentId: string; numShards: number },
  ): Promise<{ deploymentId: string; numShards: number }>;
  leaseHeartbeatDriver(
    store: { heartbeat(opts: { now: number; leaseTtlMs: number }): Promise<void> },
    opts: { leaseTtlMs: number; heartbeatMs: number; onFenced?: (e: Error) => void },
  ): Driver;
}

export const OBJECTSTORE_SUBSTRATE_ERR_NO_PACKAGE =
  "stackbase: --object-store requires @stackbase/objectstore-substrate — install it (bun add @stackbase/objectstore-substrate).";

/** Dynamic-import gate for the ee substrate package (mirrors `serve.ts`'s `@stackbase/fleet` gate:
 *  an indirect (non-literal) specifier so `tsc` never statically resolves the enterprise package). */
async function loadObjectStoreSubstrateModule(): Promise<ObjectStoreSubstrateModule> {
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
}): Promise<{ store: ObjectStoreWriterStore; drivers: Driver[]; release: () => Promise<void> }> {
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

  // Slice-4 carried note I1: adopt the bucket's existing deployment identity (never overwrite it) —
  // a fresh deployment mints one here (non-determinism is fine at this CLI-adjacent layer).
  const globals = await substrate.ensureGlobals(resolved.objectStore, { deploymentId: randomUUID(), numShards: 1 });

  const local = makeLocalSqliteStore(opts.dataPath);
  const store = await substrate.ObjectStoreDocStore.open({ objectStore: resolved.objectStore, shard: "0", local });
  // Pre-seed the runtime's own deployment-id global on the just-materialized LOCAL store so
  // `createEmbeddedRuntime` adopts the bucket's identity instead of minting a fresh one (see the
  // constant's doc comment above).
  await store.writeGlobalIfAbsent(RUNTIME_DEPLOYMENT_ID_GLOBAL_KEY, globals.deploymentId);

  await acquireWithRetry(store, {
    writerId,
    leaseTtlMs,
    timeoutMs: acquireTimeoutMs,
    ...(opts.acquirePollIntervalMs !== undefined ? { pollIntervalMs: opts.acquirePollIntervalMs } : {}),
  });

  const heartbeat = substrate.leaseHeartbeatDriver(store, {
    leaseTtlMs,
    heartbeatMs,
    onFenced: (e) => opts.onFenced?.(e),
  });

  return { store, drivers: [heartbeat], release: () => store.relinquish() };
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
   * Tier 3 Slice 6: set only when `objectStoreUrl` was given — relinquishes this node's shard-0
   * write lease (Task 6.5: `store.relinquish()`, which best-effort CAS-clears the lease IN THE
   * BUCKET, not just in-process — see `ObjectStoreDocStore.relinquish()`'s doc — so a challenger
   * takes over immediately instead of waiting out the full TTL). `serve.ts`'s shutdown calls this
   * AFTER `server.close()` (which stops the lease-heartbeat driver) and BEFORE `store.close()`.
   */
  objectStoreRelease?: () => Promise<void>;
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

export async function bootLoaded(opts: {
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
}): Promise<BootResult> {
  const { project, generated } = push(opts.loaded, opts.components);
  const logSink = new InMemoryLogSink();

  if (opts.objectStoreUrl !== undefined && opts.fleet) {
    throw new Error("stackbase: --object-store cannot be combined with --fleet (Tier 2) — pick one write-scaling story.");
  }
  // Tier 3 Slice 6: ee-gate → resolve → adopt globals → materialize → acquire the shard-0 lease
  // BEFORE anything else boots — a failed acquire (another live writer holds it) must fail the whole
  // boot fast, not leave a runtime half-constructed over a store this process doesn't own.
  const objectStoreNode =
    opts.objectStoreUrl !== undefined
      ? await buildObjectStoreWriterNode({
          objectStoreUrl: opts.objectStoreUrl,
          dataPath: opts.dataPath,
          onFenced: opts.objectStoreOnFenced,
          leaseTtlMs: opts.objectStoreLeaseTtlMs,
          heartbeatMs: opts.objectStoreHeartbeatMs,
          acquireTimeoutMs: opts.objectStoreAcquireTimeoutMs,
          acquirePollIntervalMs: opts.objectStoreAcquirePollIntervalMs,
          writerId: opts.objectStoreWriterId,
        })
      : undefined;
  const store = opts.fleet?.store ?? objectStoreNode?.store ?? makeStore({ dataPath: opts.dataPath, databaseUrl: opts.databaseUrl });

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
  } else if (objectStoreNode) {
    // Tier 3 Slice 6 scope boundary: single-shard-node only. The substrate's own per-shard lease
    // concept ("shard 0" over the bucket) is a DIFFERENT axis from the engine's ShardedTransactor
    // `numShards` — composing the two (an N-lane ShardedTransactor over one object-storage shard) is
    // an explicitly deferred follow-on ("multi-shard single node"), not built here.
    await store.setupSchema();
    numShards = 1;
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
      // Tier 3 Slice 6: the lease-heartbeat driver (renews shard-0's lease on cadence; stops +
      // signals via `objectStoreOnFenced` on a fence). Empty outside the object-store path.
      ...(objectStoreNode?.drivers ?? []),
      ...project.drivers,
    ],
    // Fleet (Tier 2): route writes to the lease-holder when not the writer, defer drivers until
    // promotion, and (writer boot) fan out commits cross-process via pg_notify.
    ...(opts.fleet?.writeRouter ? { writeRouter: opts.fleet.writeRouter } : {}),
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
  });

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
    ...(objectStoreNode ? { objectStoreRelease: objectStoreNode.release } : {}),
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

export async function bootProject(opts: {
  convexDir: string;
  dataPath: string;
  adminKey: string;
  databaseUrl?: string;
  storage?: StorageConfig;
  storageUploadTtlMs?: number;
  storageReaperSweepMs?: number;
  /** Tier 2 fleet wiring (see `bootLoaded`'s `fleet`). Absent for dev / non-fleet serve. */
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
    /** Fleet B4: group commit — resolved fleet-side, threaded straight into `createEmbeddedRuntime`. */
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
  /** Tier 3 Slice 6 object-storage writer node wiring (see `bootLoaded`'s matching opts). */
  objectStoreUrl?: string;
  objectStoreOnFenced?: (e: Error) => void;
  objectStoreLeaseTtlMs?: number;
  objectStoreHeartbeatMs?: number;
  objectStoreAcquireTimeoutMs?: number;
  objectStoreAcquirePollIntervalMs?: number;
  objectStoreWriterId?: string;
}): Promise<BootResult> {
  const loaded = await loadConvexDir(opts.convexDir);
  const config = await loadConfig(dirname(opts.convexDir));
  return bootLoaded({
    loaded,
    components: config.components,
    dataPath: opts.dataPath,
    adminKey: opts.adminKey,
    databaseUrl: opts.databaseUrl,
    storage: opts.storage,
    ...(opts.storageUploadTtlMs !== undefined ? { storageUploadTtlMs: opts.storageUploadTtlMs } : {}),
    ...(opts.storageReaperSweepMs !== undefined ? { storageReaperSweepMs: opts.storageReaperSweepMs } : {}),
    ...(opts.fleet ? { fleet: opts.fleet } : {}),
    ...(opts.objectStoreUrl !== undefined ? { objectStoreUrl: opts.objectStoreUrl } : {}),
    ...(opts.objectStoreOnFenced ? { objectStoreOnFenced: opts.objectStoreOnFenced } : {}),
    ...(opts.objectStoreLeaseTtlMs !== undefined ? { objectStoreLeaseTtlMs: opts.objectStoreLeaseTtlMs } : {}),
    ...(opts.objectStoreHeartbeatMs !== undefined ? { objectStoreHeartbeatMs: opts.objectStoreHeartbeatMs } : {}),
    ...(opts.objectStoreAcquireTimeoutMs !== undefined ? { objectStoreAcquireTimeoutMs: opts.objectStoreAcquireTimeoutMs } : {}),
    ...(opts.objectStoreAcquirePollIntervalMs !== undefined
      ? { objectStoreAcquirePollIntervalMs: opts.objectStoreAcquirePollIntervalMs }
      : {}),
    ...(opts.objectStoreWriterId !== undefined ? { objectStoreWriterId: opts.objectStoreWriterId } : {}),
  });
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
