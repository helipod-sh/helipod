/**
 * `stackbase serve` — the production server. Unlike `dev`: requires a persistent admin key,
 * binds 0.0.0.0, never writes codegen (the mounted convex/ must already contain _generated/),
 * and shuts down gracefully on SIGTERM/SIGINT. Shares the boot core with dev via bootProject().
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import type { DevServer } from "./server";
import { startDevServer } from "./server";
import { bootProject, isPostgresUrl, loadDashboard, resolveNumShards, parseNumShards } from "./boot";
import { applyDeploy } from "./deploy-apply";
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
  convexDir: string;
  dataPath: string;
  ip: string;
  port: number;
  dashboard: boolean;
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
}

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
 * `setupSchema()` on the real runtime store. Opens its own short-lived `NodePgClient` (no commit
 * pool — this is a one-shot KV read/maybe-write, not a shard writer) against the SAME database
 * `--database-url`/`STACKBASE_DATABASE_URL` names, runs `setupSchema()` (idempotent DDL only —
 * `readOnly: true` skips just the writer-lock/ts-seq seeding, not the DDL, so `persistence_globals`
 * is guaranteed to exist afterward even on a brand-new database) and delegates to the shared
 * `resolveNumShards` (same persist-once/mismatch-fail-fast contract non-fleet boot uses in
 * `boot.ts`). Any fleet node — writer or sync — can safely do this: `getGlobal`/
 * `writeGlobalIfAbsent` are plain KV ops, not gated by the store's read-only flag.
 */
async function resolveFleetNumShards(databaseUrl: string, envValue: number | undefined): Promise<number> {
  const client = new NodePgClient({ connectionString: databaseUrl });
  try {
    const probe = new PostgresDocStore(client, { readOnly: true });
    await probe.setupSchema();
    return await resolveNumShards(probe, envValue);
  } finally {
    await client.close();
  }
}

export function resolveServeOptions(args: string[]): ServeOptions {
  let convexDir = "convex";
  let dataPath = process.env.STACKBASE_DATA_DIR ? join(process.env.STACKBASE_DATA_DIR, "db.sqlite") : "./data/db.sqlite";
  let ip = "0.0.0.0";
  let port = process.env.PORT ? Number(process.env.PORT) : 3000;
  let dashboard = process.env.STACKBASE_DASHBOARD?.trim().toLowerCase() !== "off";
  let allowDeploy = process.env.STACKBASE_ALLOW_DEPLOY === "1";
  let databaseUrl = process.env.STACKBASE_DATABASE_URL;
  let storageBucket: string | undefined;
  let storageEndpoint: string | undefined;
  let fleet = process.env.STACKBASE_FLEET === "1" || process.env.STACKBASE_FLEET?.trim().toLowerCase() === "true";
  let advertiseUrl = process.env.STACKBASE_ADVERTISE_URL;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" && args[i + 1]) convexDir = args[++i] as string;
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
  }
  return { convexDir, dataPath, ip, port, dashboard, allowDeploy, databaseUrl, storageBucket, storageEndpoint, fleet, advertiseUrl };
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
  },
): Promise<{ server: DevServer; store: DocStore; runtime: EmbeddedRuntime; fleet?: FleetHandles; role?: "sync" | "writer" }> {
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

  const { runtime, adminApi, project, store, components, storageRoutes } = await bootProject({
    convexDir: opts.convexDir,
    dataPath: opts.dataPath,
    adminKey: opts.adminKey,
    databaseUrl: opts.databaseUrl,
    storage: { bucket: opts.storageBucket, endpoint: opts.storageEndpoint },
    ...(opts.storageUploadTtlMs !== undefined ? { storageUploadTtlMs: opts.storageUploadTtlMs } : {}),
    ...(opts.storageReaperSweepMs !== undefined ? { storageReaperSweepMs: opts.storageReaperSweepMs } : {}),
    ...(prep ? { fleet: prep.runtimeOptions } : {}),
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

  // `server` is assigned below by `startDevServer`; `setRoutes` only runs on a LATER deploy
  // request, by which time it is set. `current` reads AdminApi's live schema — no serve-side
  // bookkeeping to keep in sync.
  let server: DevServer;
  const deploy = opts.allowDeploy
    ? {
        apply: (files: Array<{ path: string; code: string }>) =>
          applyDeploy(
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
            },
            files,
          ),
      }
    : undefined;
  server = await startDevServer(
    runtime,
    { port: opts.port, ip: opts.ip, admin: { api: adminApi, key: opts.adminKey }, dashboard, routes: project.routes, storageRoutes, deploy, fleet },
  );
  return { server, store, runtime, fleet, role: prep?.role };
}

/** CLI wrapper: flags → fail-fast → startServe → signal handlers → run forever. */
export async function serveCommand(args: string[]): Promise<number> {
  const opts = resolveServeOptions(args);
  const adminKey = process.env.STACKBASE_ADMIN_KEY?.trim();
  if (!adminKey) {
    process.stderr.write("✗ STACKBASE_ADMIN_KEY is required for `serve` — set it to a strong secret.\n");
    return 1;
  }
  if (!existsSync(join(opts.convexDir, "_generated", "server.ts"))) {
    process.stderr.write(
      `✗ ${opts.convexDir}/_generated not found — run \`stackbase codegen --dir ${opts.convexDir}\` and commit _generated/ before deploying.\n`,
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

  const { server, store, role, fleet } = await startServe({ ...opts, adminKey, fleetModule, fleetConfig });
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "stackbase serve",
      url: server.url,
      dir: opts.convexDir,
      data: opts.dataPath,
      dashboard: opts.dashboard,
      allowDeploy: opts.allowDeploy,
      // Additive: present only in fleet mode. Task 7's 2-process E2E asserts each node's role here.
      ...(role ? { fleet: true, role } : {}),
    }) + "\n",
  );

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stdout.write(JSON.stringify({ level: "info", msg: "shutting down" }) + "\n");
    // Stop the fleet node (lease acquire loop / replica tailer) before the store closes.
    if (fleet) await fleet.stop();
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  return new Promise<number>(() => {
    // Run until a signal exits the process.
  });
}
