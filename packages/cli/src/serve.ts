/**
 * `stackbase serve` — the production server. Unlike `dev`: requires a persistent admin key,
 * binds 0.0.0.0, never writes codegen (the mounted functions directory must already contain
 * _generated/), and shuts down gracefully on SIGTERM/SIGINT. Shares the boot core with dev via
 * bootProject().
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PostgresDocStore } from "@stackbase/docstore-postgres";
import type { DevServer } from "./server";
import { ProcessRuntimeHost } from "./server";
import {
  bootProject,
  isPostgresUrl,
  isObjectStoreBootFailFast,
  loadDashboard,
  resolveNumShards,
  parseNumShards,
  makePgClient,
} from "./boot";
import { applyDeploy } from "./deploy-apply";
import { httpWakeHost } from "./wake-host";
import { resolveFunctionsDir, ensureFunctionsDirExists } from "./functions-dir";
import type { DeploySchema } from "./schema-diff";
import type { SchemaJsonLike } from "@stackbase/admin";
import type { DocStore } from "@stackbase/docstore";
import type { EmbeddedRuntime, WriteRouter, EmbeddedWriteFanoutAdapter } from "@stackbase/runtime-embedded";
import type { FleetHandles } from "./http-handler";

/**
 * Structural mirrors of `@stackbase/fleet`'s public surface. Declared locally (not imported) so
 * core `packages/cli` keeps ZERO static dependency on the enterprise `@stackbase/fleet` package —
 * it's loaded only via dynamic `import()` in fleet mode. Keep these in sync with `ee/packages/fleet`.
 * The engine seam types (`WriteRouter`/`EmbeddedWriteFanoutAdapter`) ARE core, so they're imported;
 * `FleetHandles` lives in `./http-handler` (where the proxy consumes it).
 */
/** The `createEmbeddedRuntime` option deltas `prepareFleetNode` computes (threaded via `bootProject`). */
export interface FleetRuntimeOptions {
  store: DocStore;
  writeRouter: WriteRouter;
  deferDrivers: boolean;
  fanoutAdapter?: EmbeddedWriteFanoutAdapter;
  /** Shards B2a: number of shards this node runs — threaded into `createEmbeddedRuntime` (>1 builds a
   *  `ShardedTransactor` over the pooled store for per-shard parallel commits). */
  numShards: number;
  /** Fleet B3 hybrid (multi-writer): the replica-backed query store — queries route here while
   *  mutations commit to `store` (the primary). Threaded straight into `createEmbeddedRuntime`. */
  queryStore?: DocStore;
  /** Receipted Outbox (verdict §(c) placement): the authoritative receipts store the Connect handshake
   *  classifies/prunes against — the PRIMARY on a sync node (whose `store` is the receipt-less replica).
   *  Threaded straight into `createEmbeddedRuntime`; absent outside a fleet / on a writer boot. */
  receiptsStore?: DocStore;
  /** Fleet B3 hybrid RYOW: awaited in the runtime's fan-out drain before a local commit's
   *  subscription re-runs (wired to the fleet forwarder's replica-catch-up wait). */
  beforeNotify?: (commitTs: bigint) => Promise<void>;
  /** Fleet B4 (T4): group commit — resolved fleet-side from `STACKBASE_GROUP_COMMIT` (mirrors how
   *  `@stackbase/fleet`'s `node.ts` resolves `STACKBASE_FLEET_MULTI_WRITER`), threaded straight
   *  into `createEmbeddedRuntime` via `bootProject`'s `fleet.groupCommit`. Unset → `false`. */
  groupCommit?: boolean;
  /** Triggers D1: the stable-prefix accessor for `DriverContext.readLog` — `min(shard_leases.frontier_ts)`
   *  in a fleet (the log tail is gap-free only below the fenced frontier). Threaded straight into
   *  `createEmbeddedRuntime`; unset outside a fleet → `readLog` falls back to `store.maxTimestamp()`. */
  stablePrefix?: () => Promise<bigint | null>;
}

/** `prepareFleetNode`'s result. `client`/`lease`/`forwarder`/`replica`/`switchable` are opaque here
 *  — only handed back into `startFleetNode`; the runtime option deltas are what `bootProject`
 *  consumes. `pgStore` is the Postgres store (writer runtime store, or a sync node's tail source). */
export interface FleetPrep {
  client: unknown;
  pgStore: DocStore;
  replica?: unknown;
  switchable?: unknown;
  /** Sync only: `replica`'s on-disk path — threaded through to `startFleetNode`, which now runs the
   *  C7 deployment-id reconcile (deferred there from `prepareFleetNode` so it reads Postgres only
   *  after THIS node's own boot has run — see `@stackbase/fleet`'s `node.ts`). */
  replicaPath?: string;
  lease: unknown;
  forwarder: unknown;
  role: "sync" | "writer";
  /** Shards B2a: shard count decided at boot — threaded to `startFleetNode` (acquire-all, seed-all,
   *  per-shard guard, idle closer, tailer count gate). */
  numShards: number;
  runtimeOptions: FleetRuntimeOptions;
}

/** The slice of `@stackbase/fleet` serve consumes (via dynamic import). */
export interface FleetModule {
  prepareFleetNode(deps: {
    databaseUrl: string;
    advertiseUrl: string;
    adminKey: string;
    dataDir: string;
    /** Lease TTL in ms — the failover-clock knob (see `@stackbase/fleet`'s `node.ts`). Threaded from
     *  `STACKBASE_FLEET_LEASE_TTL_MS`; undefined → the fleet default (15000). Ops/test tuning. */
    leaseTtlMs?: number;
    /** Shards B2a: shard count (default 8 in the fleet package). T5 owns the persist-once/env story;
     *  serve threads a plain number (undefined → fleet default). */
    numShards?: number;
  }): Promise<FleetPrep>;
  startFleetNode(deps: {
    client: unknown;
    pgStore: DocStore;
    runtime: EmbeddedRuntime;
    lease: unknown;
    forwarder: unknown;
    replica?: unknown;
    switchable?: unknown;
    replicaPath?: string;
    /** Shards B2a: from `FleetPrep.numShards` — drives the acquire-all/seed-all/idle-closer. */
    numShards?: number;
  }): Promise<FleetHandles>;
}

export interface ServeOptions {
  functionsDir: string;
  dataPath: string;
  ip: string;
  port: number;
  dashboard: boolean;
  /** A static web UI directory to serve at the site root (`index.html` + assets), exactly as `dev`'s
   *  `--web` does. Unset → no web UI (today's behavior). Lets a self-hosted `serve` host an app's own
   *  frontend on the SAME origin as its sync WebSocket, so a `location.host`-relative client needs no
   *  backend-URL config and never makes a cross-origin `/api/sync` connection. */
  webDir?: string;
  /** Enable `POST /_admin/deploy` (`stackbase deploy`'s hot-swap target). Off by default — a running
   * `serve` only accepts live code changes when explicitly opted in. */
  allowDeploy: boolean;
  /** Postgres connection string (flag wins over `STACKBASE_DATABASE_URL`); unset → SQLite. */
  databaseUrl?: string;
  /** File-storage backend flag overrides (`--storage-bucket`/`--storage-endpoint`; win over env). */
  storageBucket?: string;
  storageEndpoint?: string;
  /** Test-only: shorten the pending-upload TTL / orphan-reaper sweep so a reap is observable in a
   * test's timescale. Unset → the storage defaults (1h TTL, 60s sweep). Not surfaced as CLI flags. */
  storageUploadTtlMs?: number;
  storageReaperSweepMs?: number;
  /** Tier 2: run this node as part of a symmetric fleet (writer-or-sync, decided at boot by the
   *  Postgres write lease). Requires a Postgres `databaseUrl` and an `advertiseUrl`. Optional so
   *  existing (non-fleet) `ServeOptions` literals need no change; `resolveServeOptions` always sets it. */
  fleet?: boolean;
  /** The URL other fleet nodes reach THIS node at (recorded on the lease when it's the writer, and
   *  the target sync nodes forward writes / proxy httpActions to). Flag wins over env. */
  advertiseUrl?: string;
  /** Tier 3: run this node's store as the object-storage substrate (single-shard writer over the
   *  given bucket/dir) instead of SQLite/Postgres — `s3://…`/`s3+http(s)://…`/`file://…`/a bare path,
   *  see `objectstore-select.ts`'s grammar doc. Mutually exclusive with `fleet`. Flag wins over env. */
  objectStoreUrl?: string;
  /** Tier 3 Slice 7, Task 7.3: the object-store writer's gc-driver sweep cadence (ms), from
   *  `STACKBASE_OBJECTSTORE_GC_MS`. Unset → `boot.ts`'s `DEFAULT_OBJECTSTORE_GC_MS` (~60s). Ignored
   *  unless `objectStoreUrl` is set. */
  objectStoreGcMs?: number;
  /** Tier 3 multi-shard single-node serve: the number of object-storage lanes a `--object-store`
   *  WRITER owns (`--shards N`, or `STACKBASE_FLEET_SHARDS`). Unset / `1` → single-shard (shard "0"),
   *  unchanged. `> 1` → this node owns all `shardIdList(N)` lanes. Requires `--object-store`; invalid
   *  with `--replica` (replicas are single-shard) or `--fleet` (its own shard resolution). Validated
   *  in `serveCommand`. Flag (`--shards`) wins over `STACKBASE_FLEET_SHARDS` env. */
  objectStoreShards?: number;
  /** Tier 3 Slice 8, Task 8.2: boot this node as a READ-ONLY REPLICA of `objectStoreUrl`'s shard
   *  (materialize + tail, no write lease — every mutation is rejected) instead of a writer. REQUIRES
   *  `objectStoreUrl` (validated in `serveCommand`, before `startServe` is ever called). Optional so
   *  existing (non-replica) `ServeOptions` literals need no change; `resolveServeOptions` always
   *  sets it. Flag (`--replica`) wins over `STACKBASE_REPLICA` env. */
  replica?: boolean;
  /** Tier 3 Slice 8 follow-on (replica write-forwarding): the writer node's URL — when set on a
   *  `--replica` boot, every mutation/action FORWARDS here instead of being rejected. Ignored
   *  unless `replica` is also set. Flag (`--writer-url`) wins over `STACKBASE_WRITER_URL` env. */
  writerUrl?: string;
  /** The wake seam's host endpoint (`--wake-url`, wins over `STACKBASE_WAKE_URL`) — for a host that
   *  STOPS THE PROCESS between requests, so `setTimeout` never fires and every driver goes dead.
   *  Set → `serve` builds an HTTP `WakeHost` that POSTs the next wake's absolute `atMs` here (on
   *  Cloudflare, the container's Outbound-Worker hostname, which the Worker turns into a Durable
   *  Object alarm). Unset (every existing deployment) → no wake host, plain `setTimeout`. */
  wakeUrl?: string;
  /** Floor for every driver's BACKSTOP poll cadence, ms (`--backstop-min-ms`, wins over
   *  `STACKBASE_BACKSTOP_MIN_MS`) — `backstopMs = (d) => Math.max(d, n)`. Unset → identity (the
   *  drivers' own 30s/60s). Set where each wake costs a cold start: on Cloudflare a 30s backstop is
   *  a container boot every 30s forever. */
  backstopMinMs?: number;
}

/**
 * Race `promise` against a `ms`-millisecond timeout, resolving to `undefined` (never rejecting)
 * if the timeout wins OR if `promise` itself rejects — used only for genuinely best-effort work
 * (Task 6.6 F1: `objectStoreRelease()`'s bucket CAS at shutdown) where an unbounded hang or a
 * swallowed failure are both acceptable outcomes, so the caller never needs a `try`/`catch`. The
 * loser keeps running in the background (unobserved) — fine here since `objectStoreRelease()`
 * itself never throws (its underlying `relinquish()` swallows CAS errors by design) and the
 * process exits shortly after either way.
 */
export function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolveOuter) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolveOuter();
      }
    }, ms);
    promise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolveOuter();
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolveOuter();
        }
      },
    );
  });
}

/** Bound on `objectStoreRelease()` at shutdown (Task 6.6 F1) — `relinquish()` is a live bucket CAS
 *  call with no timeout of its own; an unreachable bucket at shutdown could otherwise hang on the
 *  AWS SDK's socket timeout, delaying `process.exit(0)` past a container's grace period (→ SIGKILL,
 *  skipping the rest of graceful shutdown too). Timing out here is SAFE: the release is best-effort
 *  — the lease TTL-expires on its own regardless — so an abandoned relinquish just means the next
 *  writer's takeover waits out the full TTL instead of being immediate, not any data-safety loss. */
export const OBJECTSTORE_RELINQUISH_TIMEOUT_MS = 2000;

/** Fail-fast messages for `--fleet` misconfiguration (asserted verbatim by `fleet-flags.test.ts`). */
export const FLEET_ERR_NO_DB =
  "fleet mode requires --database-url (Postgres) — set --database-url postgres://… or STACKBASE_DATABASE_URL.";
export const FLEET_ERR_NO_ADVERTISE =
  "fleet mode requires --advertise-url (or STACKBASE_ADVERTISE_URL) — the URL other fleet nodes reach this node at, e.g. --advertise-url http://10.0.0.2:3000";
export const FLEET_ERR_NO_PACKAGE =
  "fleet mode requires @stackbase/fleet — install it (bun add @stackbase/fleet).";

/**
 * Validate `--fleet` prerequisites. Pure — no I/O; the dynamic-import check (FLEET_ERR_NO_PACKAGE)
 * happens later in `serveCommand`. Only call this when `fleet` is set.
 */
export function validateFleetOptions(opts: {
  fleet?: boolean;
  databaseUrl?: string;
  advertiseUrl?: string;
}): { ok: true; databaseUrl: string; advertiseUrl: string } | { ok: false; error: string } {
  if (!isPostgresUrl(opts.databaseUrl)) return { ok: false, error: FLEET_ERR_NO_DB };
  const advertiseUrl = opts.advertiseUrl?.trim();
  if (!advertiseUrl) return { ok: false, error: FLEET_ERR_NO_ADVERTISE };
  return { ok: true, databaseUrl: opts.databaseUrl!, advertiseUrl };
}

/** Parse `STACKBASE_FLEET_LEASE_TTL_MS` — a positive finite integer of ms, else undefined (the fleet
 *  default applies). Kept here (not in `@stackbase/fleet`) so the env read stays at serve's config
 *  boundary, alongside the other fleet flags; the fleet package receives a validated number. */
function parseLeaseTtlMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Shards B2a (T5): resolve (and, on a fresh deployment, persist) NUM_SHARDS BEFORE
 * `prepareFleetNode` runs — it needs the final count up front to size the per-shard
 * commit-connection pool, well before `bootProject`'s `createEmbeddedRuntime` ever calls
 * `setupSchema()` on the real runtime store. Opens its own short-lived PgClient (via `makePgClient` —
 * `BunSqlClient` under Bun, `NodePgClient` elsewhere; no commit pool — this is a one-shot KV
 * read/maybe-write, not a shard writer) against the SAME database
 * `--database-url`/`STACKBASE_DATABASE_URL` names, runs `setupSchema()` (idempotent DDL only —
 * `readOnly: true` skips just the writer-lock/ts-seq seeding, not the DDL, so `persistence_globals`
 * is guaranteed to exist afterward even on a brand-new database) and delegates to the shared
 * `resolveNumShards` (same persist-once/mismatch-fail-fast contract non-fleet boot uses in
 * `boot.ts`). Any fleet node — writer or sync — can safely do this: `getGlobal`/
 * `writeGlobalIfAbsent` are plain KV ops, not gated by the store's read-only flag.
 */
async function resolveFleetNumShards(databaseUrl: string, envValue: number | undefined): Promise<number> {
  const client = makePgClient(databaseUrl);
  try {
    const probe = new PostgresDocStore(client, { readOnly: true });
    await probe.setupSchema();
    return await resolveNumShards(probe, envValue);
  } finally {
    await client.close();
  }
}

export function resolveServeOptions(args: string[]): ServeOptions {
  // The raw `--dir` flag value, captured but NOT defaulted here — "" means "not given", handled
  // identically to `undefined` by `resolveFunctionsDir` (called later, in `serveCommand`, which also
  // consults `functionsDir` in stackbase.config.ts). Resolving eagerly here would bake a literal
  // default in before the config file is ever consulted, silently winning over it — see T3 controller
  // note on the `codegenCommand` gap this whole task exists to close.
  let functionsDir = "";
  let dataPath = process.env.STACKBASE_DATA_DIR ? join(process.env.STACKBASE_DATA_DIR, "db.sqlite") : "./data/db.sqlite";
  let ip = "0.0.0.0";
  let port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let dashboard = process.env.STACKBASE_DASHBOARD?.trim().toLowerCase() !== "off";
  let allowDeploy = process.env.STACKBASE_ALLOW_DEPLOY === "1";
  let webDir = process.env.STACKBASE_WEB_DIR;
  let databaseUrl = process.env.STACKBASE_DATABASE_URL;
  let storageBucket: string | undefined;
  let storageEndpoint: string | undefined;
  let fleet = process.env.STACKBASE_FLEET === "1" || process.env.STACKBASE_FLEET?.trim().toLowerCase() === "true";
  let advertiseUrl = process.env.STACKBASE_ADVERTISE_URL;
  let objectStoreUrl = process.env.STACKBASE_OBJECT_STORE;
  let replica = /^(1|true|yes)$/i.test(process.env.STACKBASE_REPLICA ?? "");
  let writerUrl = process.env.STACKBASE_WRITER_URL;
  // The wake seam (both env-or-flag, flag wins — `objectStoreUrl`'s exact shape above). Unset →
  // no wake host + identity backstops, i.e. byte-for-byte today's behavior.
  let wakeUrl = process.env.STACKBASE_WAKE_URL;
  let backstopMinMs = parseLeaseTtlMs(process.env.STACKBASE_BACKSTOP_MIN_MS);
  // Tier 3 multi-shard single-node serve: object-storage writer lane count. Set ONLY by the
  // `--shards` flag here; the `STACKBASE_FLEET_SHARDS` env fallback is applied AFTER the flag loop
  // and ONLY when `--object-store` is present — otherwise a plain `--fleet` boot (which legitimately
  // reads `STACKBASE_FLEET_SHARDS` for its OWN shard count via `resolveFleetNumShards`) would trip
  // the object-store-only `--shards` validation below.
  let objectStoreShards: number | undefined;
  // Tier 3 Slice 7, Task 7.3: gc-driver cadence — env-only (no CLI flag), mirroring how
  // STACKBASE_FLEET_LEASE_TTL_MS is a pure ops/test tuning knob with no flag equivalent.
  // `parseLeaseTtlMs`'s "positive finite number, else undefined" parse is generic, not lease-specific.
  const objectStoreGcMs = parseLeaseTtlMs(process.env.STACKBASE_OBJECTSTORE_GC_MS);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) functionsDir = args[++i] as string;
    else if (a === "--data" && args[i + 1]) dataPath = args[++i] as string;
    else if (a === "--ip" && args[i + 1]) ip = args[++i] as string;
    else if (a === "--port" && args[i + 1]) port = Number(args[++i]);
    else if (a === "--no-dashboard") dashboard = false;
    else if (a === "--allow-deploy") allowDeploy = true;
    else if (a === "--database-url" && args[i + 1]) databaseUrl = args[++i] as string;
    else if (a === "--storage-bucket" && args[i + 1]) storageBucket = args[++i] as string;
    else if (a === "--storage-endpoint" && args[i + 1]) storageEndpoint = args[++i] as string;
    else if (a === "--fleet") fleet = true;
    else if (a === "--advertise-url" && args[i + 1]) advertiseUrl = args[++i] as string;
    else if (a === "--object-store" && args[i + 1]) objectStoreUrl = args[++i] as string;
    else if (a === "--replica") replica = true;
    else if (a === "--writer-url" && args[i + 1]) writerUrl = args[++i] as string;
    else if (a === "--shards" && args[i + 1]) objectStoreShards = Number(args[++i]);
    else if (a === "--wake-url" && args[i + 1]) wakeUrl = args[++i] as string;
    else if (a === "--backstop-min-ms" && args[i + 1]) backstopMinMs = parseLeaseTtlMs(args[++i]);
    else if (a === "--web" && args[i + 1]) webDir = args[++i] as string;
  }
  // `STACKBASE_FLEET_SHARDS` env fallback — ONLY for an object-store boot (never a fleet boot; see
  // the `objectStoreShards` declaration above). The `--shards` flag, if given, always wins.
  if (objectStoreShards === undefined && objectStoreUrl !== undefined) {
    objectStoreShards = parseNumShards(process.env.STACKBASE_FLEET_SHARDS);
  }
  return {
    functionsDir,
    dataPath,
    ip,
    port,
    dashboard,
    ...(webDir !== undefined ? { webDir } : {}),
    allowDeploy,
    databaseUrl,
    storageBucket,
    storageEndpoint,
    fleet,
    advertiseUrl,
    ...(objectStoreUrl !== undefined ? { objectStoreUrl } : {}),
    ...(objectStoreGcMs !== undefined ? { objectStoreGcMs } : {}),
    ...(objectStoreShards !== undefined ? { objectStoreShards } : {}),
    replica,
    ...(writerUrl !== undefined ? { writerUrl } : {}),
    ...(wakeUrl !== undefined ? { wakeUrl } : {}),
    ...(backstopMinMs !== undefined ? { backstopMinMs } : {}),
  };
}

/**
 * Adapt `AdminApi.getSchema()`'s `SchemaJsonLike` (the data-browser's schema shape) into
 * `DeploySchema["schemaJson"]` (the schema-diff's narrower, required-`documentType` shape) —
 * `AdminApi`'s live schema always carries a real `documentType` for app tables, this just narrows
 * the type safely instead of asserting it.
 */
function toDeploySchema(schemaJson: SchemaJsonLike): DeploySchema["schemaJson"] {
  const tables: DeploySchema["schemaJson"]["tables"] = {};
  for (const [name, t] of Object.entries(schemaJson.tables)) {
    const dt = t.documentType;
    tables[name] = { documentType: dt && dt.type === "object" ? dt : { type: "object", value: {} } };
  }
  return { tables };
}

/** Testable core: boot + start the server. No signals, no exit, does not block. In fleet mode the
 *  caller injects the dynamically-imported `@stackbase/fleet` module + resolved config so this core
 *  stays free of the enterprise dependency. */
export async function startServe(
  opts: ServeOptions & {
    adminKey: string;
    fleetModule?: FleetModule;
    fleetConfig?: { databaseUrl: string; advertiseUrl: string; leaseTtlMs?: number; numShards?: number };
    /** Tier 3 Slice 6: called once, synchronously, the moment the object-store lease-heartbeat driver
     *  detects this node has been fenced. `serveCommand` wires this to trigger graceful shutdown; a
     *  direct `startServe` test caller may omit it (the driver just logs and stops on its own). */
    onObjectStoreFenced?: (e: Error) => void;
  },
): Promise<{
  server: DevServer;
  store: DocStore;
  runtime: EmbeddedRuntime;
  fleet?: FleetHandles;
  role?: "sync" | "writer";
  /** Tier 3 Slice 6: set only when `--object-store` was given — relinquish this node's shard-0
   *  lease (Task 6.5: bucket-clearing `store.relinquish()`, for immediate takeover, not just the
   *  in-process `release()`). Caller must call this AFTER `server.close()` (stops the heartbeat
   *  driver) and BEFORE `store.close()` — see `serveCommand`'s shutdown. */
  objectStoreRelease?: () => Promise<void>;
}> {
  // The wake seam's backstop policy, resolved once here so the closure captures a plain number
  // rather than re-reading (and re-narrowing) `opts` on every driver call.
  const backstopFloorMs = opts.backstopMinMs;

  // Fleet: decide writer-vs-sync via ONE lease tryAcquire BEFORE the runtime is built — its result
  // (writable store, fan-out adapter, deferred drivers, forwarder role) are createEmbeddedRuntime inputs.
  const prep =
    opts.fleet && opts.fleetModule && opts.fleetConfig
      ? await opts.fleetModule.prepareFleetNode({
          ...opts.fleetConfig,
          adminKey: opts.adminKey,
          // A sync node's local replica lives beside the data file (same dir the SQLite store uses).
          dataDir: dirname(resolve(opts.dataPath)),
        })
      : undefined;

  const { runtime, adminApi, project, store, components, storageRoutes, componentRoutes, objectStoreRelease, replicaWriterUrl } =
    await bootProject({
      functionsDir: opts.functionsDir,
      dataPath: opts.dataPath,
      adminKey: opts.adminKey,
      databaseUrl: opts.databaseUrl,
      storage: { bucket: opts.storageBucket, endpoint: opts.storageEndpoint },
      ...(opts.storageUploadTtlMs !== undefined ? { storageUploadTtlMs: opts.storageUploadTtlMs } : {}),
      ...(opts.storageReaperSweepMs !== undefined ? { storageReaperSweepMs: opts.storageReaperSweepMs } : {}),
      ...(prep ? { fleet: prep.runtimeOptions } : {}),
      ...(opts.objectStoreUrl !== undefined ? { objectStoreUrl: opts.objectStoreUrl } : {}),
      ...(opts.onObjectStoreFenced ? { objectStoreOnFenced: opts.onObjectStoreFenced } : {}),
      ...(opts.objectStoreGcMs !== undefined ? { objectStoreGcMs: opts.objectStoreGcMs } : {}),
      ...(opts.replica ? { replica: opts.replica } : {}),
      ...(opts.writerUrl !== undefined ? { writerUrl: opts.writerUrl } : {}),
      ...(opts.objectStoreShards !== undefined ? { objectStoreShards: opts.objectStoreShards } : {}),
      // The wake seam (`--wake-url`/`--backstop-min-ms`): a host that stops the process between
      // requests. Both unset (every existing deployment) → no keys, plain `setTimeout` + the drivers'
      // own 30s/60s backstops.
      ...(opts.wakeUrl !== undefined ? { wakeHost: httpWakeHost(opts.wakeUrl) } : {}),
      ...(backstopFloorMs !== undefined ? { backstopMs: (d: number) => Math.max(d, backstopFloorMs) } : {}),
    });
  // No embedded key (0.0.0.0 bind): the dashboard SPA prompts the operator for the admin key.
  const dashboard = opts.dashboard ? loadDashboard(undefined) : undefined;

  // Start the fleet node (sync: replica tailer + acquire loop; writer: already live) BEFORE the HTTP
  // server, so its handles exist to pass in. The http layer reads `role()` live per request, so
  // there's no ordering hazard with promotion.
  const fleet =
    prep && opts.fleetModule
      ? await opts.fleetModule.startFleetNode({
          client: prep.client,
          pgStore: prep.pgStore,
          runtime,
          lease: prep.lease,
          forwarder: prep.forwarder,
          replica: prep.replica,
          switchable: prep.switchable,
          replicaPath: prep.replicaPath,
          numShards: prep.numShards,
        })
      : undefined;

  // `server` is assigned below by `host.serve`; `setRoutes` only runs on a LATER deploy
  // request, by which time it is set. `current` reads AdminApi's live schema — no serve-side
  // bookkeeping to keep in sync.
  let server: DevServer;
  // The modules from the last successful push this server lifetime — starts empty, so the first
  // deploy after (re)start is a full push and every later one is a true delta. Holds code (for
  // reconstructing `unchanged` entries) — NEVER serialized to the wire.
  let currentPushedModules = new Map<string, { code: string; sha: string }>();
  const deploy = opts.allowDeploy
    ? {
        apply: async (
          payload:
            | { files: Array<{ path: string; code: string }> }
            | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> },
        ) => {
          const result = await applyDeploy(
            {
              runtime,
              adminApi,
              setRoutes: (r) => server.setRoutes(r),
              components,
              current: () => {
                const live = adminApi.getSchema();
                return { schemaJson: toDeploySchema(live.schemaJson), tableNumbers: live.tableNumbers };
              },
              deployRoot: join(process.cwd(), ".stackbase-deploy"),
              currentModules: currentPushedModules,
            },
            payload,
          );
          if (!result.ok) return result; // { ok:false, kind, error } — wire-safe (no Map)
          currentPushedModules = result.modules; // update state; strip the Map from the wire result
          return { ok: true as const, rev: result.rev, functions: result.functions };
        },
        modules: (): Record<string, string> =>
          Object.fromEntries([...currentPushedModules].map(([p, v]) => [p, v.sha])),
      }
    : undefined;
  // Reach serving through the RuntimeHost seam (Slice 1) — serve() never touches Bun.serve/node:http.
  server = await new ProcessRuntimeHost().serve(
    runtime,
    {
      port: opts.port,
      ip: opts.ip,
      ...(opts.webDir !== undefined ? { webDir: opts.webDir } : {}),
      admin: { api: adminApi, key: opts.adminKey },
      dashboard,
      routes: project.routes,
      storageRoutes,
      componentRoutes,
      deploy,
      fleet,
      ...(replicaWriterUrl !== undefined ? { replicaWriterUrl } : {}),
    },
  );
  return { server, store, runtime, fleet, role: prep?.role, ...(objectStoreRelease ? { objectStoreRelease } : {}) };
}

/** CLI wrapper: flags → fail-fast → startServe → signal handlers → run forever. */
export async function serveCommand(args: string[]): Promise<number> {
  const opts = resolveServeOptions(args);
  const adminKey = process.env.STACKBASE_ADMIN_KEY?.trim();
  // Admin key first: an operator missing BOTH the key and the functions directory should see the
  // key error, not have it masked by a directory error — this is the more fundamental misconfiguration
  // and was already serve's first fail-fast check before this task.
  if (!adminKey) {
    process.stderr.write("✗ STACKBASE_ADMIN_KEY is required for `serve` — set it to a strong secret.\n");
    return 1;
  }
  // Resolve the functions directory (flag > stackbase.config.ts `functionsDir` > DEFAULT_FUNCTIONS_DIR)
  // and fail loudly — with the migrate hint — if it doesn't exist at all, before falling through to
  // the narrower "_generated/ missing" check below (which assumes the directory itself is real).
  const { functionsDir } = await resolveFunctionsDir(opts.functionsDir || undefined, process.cwd());
  if (!ensureFunctionsDirExists(functionsDir)) return 1;
  opts.functionsDir = functionsDir;
  if (!existsSync(join(opts.functionsDir, "_generated", "server.ts"))) {
    process.stderr.write(
      `✗ ${opts.functionsDir}/_generated not found — run \`stackbase codegen --dir ${opts.functionsDir}\` and commit _generated/ before deploying.\n`,
    );
    return 1;
  }

  if (opts.fleet && opts.objectStoreUrl !== undefined) {
    process.stderr.write(
      "✗ --object-store cannot be combined with --fleet (Tier 2) — pick one write-scaling story.\n",
    );
    return 1;
  }

  // Tier 3 Slice 8, Task 8.2: `--replica` only makes sense over an object-storage bucket — fail
  // fast, synchronously, before any boot work starts (mirrors the fleet+object-store mutual-
  // exclusion check just above).
  if (opts.replica && opts.objectStoreUrl === undefined) {
    process.stderr.write(
      "✗ --replica requires --object-store — a replica materializes from an object-storage bucket; " +
        "set --object-store <url> (or STACKBASE_OBJECT_STORE).\n",
    );
    return 1;
  }

  // Tier 3 multi-shard single-node serve: `--shards N` (N>1) is an object-storage WRITER concept —
  // reject the combinations that can't mean it, rather than silently ignoring it.
  if (opts.objectStoreShards !== undefined && opts.objectStoreShards > 1) {
    if (opts.objectStoreUrl === undefined) {
      process.stderr.write(
        "✗ --shards N (N>1) requires --object-store — it sizes the object-storage writer's lane count; " +
          "set --object-store <url>, or drop --shards.\n",
      );
      return 1;
    }
    if (opts.replica) {
      process.stderr.write(
        "✗ --shards cannot be combined with --replica — a replica is single-shard (it tails shard 0); " +
          "run the multi-shard WRITER with --shards and point replicas at it.\n",
      );
      return 1;
    }
    if (!Number.isInteger(opts.objectStoreShards)) {
      process.stderr.write(`✗ --shards must be a positive integer, got "${opts.objectStoreShards}".\n`);
      return 1;
    }
  }

  // Tier 3 Slice 8 follow-on (replica write-forwarding): `--writer-url` only means something on a
  // replica — fail fast rather than silently ignore it (which would look like forwarding is
  // configured when it isn't).
  if (opts.writerUrl !== undefined && !opts.replica) {
    process.stderr.write(
      "✗ --writer-url only applies to --replica (it's the writer this replica forwards mutations/" +
        "actions to) — pass --replica too, or drop --writer-url (or STACKBASE_WRITER_URL).\n",
    );
    return 1;
  }

  // Fleet mode: validate prerequisites and load the enterprise package (dynamic import only —
  // never a static dependency of core cli), failing fast with actionable messages.
  let fleetModule: FleetModule | undefined;
  let fleetConfig: { databaseUrl: string; advertiseUrl: string; leaseTtlMs?: number; numShards?: number } | undefined;
  if (opts.fleet) {
    const v = validateFleetOptions(opts);
    if (!v.ok) {
      process.stderr.write(`✗ ${v.error}\n`);
      return 1;
    }
    try {
      // Indirect specifier (typed `string`, not a literal) so tsc does NOT statically resolve
      // `@stackbase/fleet` — core cli has no static/type dependency on the enterprise package; it's
      // resolved at runtime via the workspace link. See package.json (fleet is deliberately absent).
      const fleetSpecifier: string = "@stackbase/fleet";
      fleetModule = (await import(fleetSpecifier)) as unknown as FleetModule;
    } catch {
      process.stderr.write(`✗ ${FLEET_ERR_NO_PACKAGE}\n`);
      return 1;
    }
    // `STACKBASE_FLEET_SHARDS` (Shards B2a, T5): NUM_SHARDS, persisted once at first boot and
    // immutable after — resolved BEFORE `prepareFleetNode` (which needs the final count up front
    // to size the per-shard commit pool). A mismatch against the persisted count fails boot fast.
    let numShards: number;
    try {
      numShards = await resolveFleetNumShards(v.databaseUrl, parseNumShards(process.env.STACKBASE_FLEET_SHARDS));
    } catch (e) {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    // `STACKBASE_FLEET_LEASE_TTL_MS` (ops/test tuning): the lease TTL in ms, the single knob the
    // whole failover clock scales from inside `@stackbase/fleet` (heartbeat + acquire cadences are
    // derived from it). Unset → the fleet default (15000ms, behavior-identical to the historical
    // constants). Only a positive finite number is honored; anything else falls through to the
    // default. The wedged-writer E2E sets this to 4000 so failover completes in a test's timescale.
    fleetConfig = {
      databaseUrl: v.databaseUrl,
      advertiseUrl: v.advertiseUrl,
      leaseTtlMs: parseLeaseTtlMs(process.env.STACKBASE_FLEET_LEASE_TTL_MS),
      numShards,
    };
  }

  // Tier 3 Slice 6: a forward-reference trampoline — `startServe` needs `onObjectStoreFenced` BEFORE
  // it resolves (so it can thread it into the lease-heartbeat driver at boot), but `shutdown` (which
  // the fence should trigger) can only be defined AFTER `startServe` resolves (it closes over
  // `server`/`store`/`objectStoreRelease`, all part of `startServe`'s result). The indirection lets a
  // fence detected mid-boot-window-adjacent still trigger a real graceful shutdown once one exists.
  let triggerObjectStoreFencedShutdown: (() => void) | undefined;
  let booted: Awaited<ReturnType<typeof startServe>>;
  try {
    booted = await startServe({
      ...opts,
      adminKey,
      fleetModule,
      fleetConfig,
      onObjectStoreFenced: (e) => {
        process.stderr.write(`✗ object-store lease lost — shutting down: ${e.message}\n`);
        triggerObjectStoreFencedShutdown?.();
      },
    });
  } catch (e) {
    // Task 6.6 F2: mirror the fleet path's clean-message UX for the object-store boot fail-fasts
    // (ee-package missing, acquire-timeout "held by", bad --object-store URL/creds) — these are
    // KNOWN, actionable misconfigurations, not crashes. Anything else (a genuine bug) is NOT
    // swallowed here — rethrow so it surfaces with its full stack via `bin.ts`'s catch-all, same as
    // before this fix, rather than being misreported as a tidy one-liner.
    if (isObjectStoreBootFailFast(e)) {
      process.stderr.write(`✗ ${e.message}\n`);
      return 1;
    }
    throw e;
  }
  const { server, store, role, fleet, objectStoreRelease } = booted;
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "stackbase serve",
      url: server.url,
      dir: opts.functionsDir,
      data: opts.dataPath,
      dashboard: opts.dashboard,
      allowDeploy: opts.allowDeploy,
      // Additive: present only in fleet mode. Task 7's 2-process E2E asserts each node's role here.
      ...(role ? { fleet: true, role } : {}),
      // Additive: present only in object-store mode (Tier 3 Slice 6).
      ...(opts.objectStoreUrl !== undefined ? { objectStore: true } : {}),
      // Additive: present only for a read-only replica node (Tier 3 Slice 8, Task 8.2).
      ...(opts.replica ? { replica: true } : {}),
      // Additive: present only when this replica forwards writes (Tier 3 Slice 8 follow-on).
      ...(opts.writerUrl !== undefined ? { writerUrl: opts.writerUrl } : {}),
    }) + "\n",
  );

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ level: "info", msg: "shutting down" }) + "\n");
    // Stop the fleet node (lease acquire loop / replica tailer) before the store closes.
    if (fleet) await fleet.stop();
    // `server.close()` stops every registered driver first (including the object-store
    // lease-heartbeat driver, if any) — release the lease only AFTER that, so a heartbeat tick can
    // never race a voluntary release into a spurious "fenced" log during normal shutdown.
    await server.close();
    // Task 6.5: this calls `store.relinquish()`, which best-effort CAS-clears the lease in the
    // bucket itself — awaited so a challenger's takeover on the next poll is genuinely immediate,
    // not merely started-and-abandoned by an unhandled shutdown-time rejection.
    // Task 6.6 F1: bounded — see `raceWithTimeout`'s doc comment. An unreachable bucket must not be
    // able to hang shutdown past the container's grace period; timing out here is safe because the
    // release is best-effort (the lease TTL-expires on its own either way).
    if (objectStoreRelease) await raceWithTimeout(objectStoreRelease(), OBJECTSTORE_RELINQUISH_TIMEOUT_MS);
    await store.close();
    process.exit(0);
  };
  triggerObjectStoreFencedShutdown = () => void shutdown();
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  return new Promise<number>(() => {
    // Run until a signal exits the process.
  });
}
