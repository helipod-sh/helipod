/**
 * Boot a Helipod `EmbeddedRuntime` INSIDE a Durable Object, over the DO's own SQLite.
 *
 * This is the DO-shaped counterpart to the CLI's `bootLoaded` — but deliberately lean and
 * workerd-safe: it uses NONE of `bootLoaded`'s node/fs machinery (no `NodeSqliteAdapter`, no
 * blobstore-fs, no object-store/fleet/replica). It reuses the SHIPPED PURE pieces:
 *   - `loadProject` (via `@helipod/cli/project`, the subpath that does NOT pull `node:http`) to
 *     compose the statically-bundled `{ schema, modules }` + components into catalog/moduleMap/
 *     tableNumbers/contextProviders/drivers/bootSteps/routes (§4.2 — bundling replaces the dir scan);
 *   - `new SqliteDocStore(new DoSqliteAdapter({ sql, transactionSync }))` for storage (Slice 2);
 *   - `createEmbeddedRuntime` for the engine itself;
 *   - `AdminApi` for the `/_admin/*` + dashboard-browse routes.
 *
 * FILE STORAGE (`ctx.storage`) is wired HERE when a `blobStore` is injected (an R2-backed
 * `@helipod/blobstore-r2` on the DO — the engine stays blob-store-neutral, same story as the
 * `DocStore`). The `_storage` TABLE always exists (loadProject injects it) so schemas that reference
 * `Id<"_storage">` compile regardless; with a `blobStore`, the byte-moving provider (`ctx.storage`),
 * the orphan reaper (riding the wake seam), and the `/api/storage/*` serve routes are all composed —
 * exactly as the container `boot.ts` does. WITHOUT a `blobStore` (no R2 binding), file storage is
 * inert (metadata-only calls to `ctx.storage` have no provider) — byte-less deployments are unchanged.
 *
 * Byte I/O never runs in the transactor turn: the provider's writes are metadata-only, and the actual
 * `blobStore.store`/`read` happens in the DO's `fetch` handler serving `/api/storage/*` (§8.9's rule).
 */
import { SqliteDocStore } from "@helipod/docstore-sqlite";
import { DoSqliteAdapter, type SqlStorageLike, type TransactionSyncFn } from "@helipod/docstore-do-sqlite";
import { D1DocStore, type D1Client } from "@helipod/docstore-d1";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@helipod/runtime-embedded";
import { InMemoryLogSink } from "@helipod/executor";
import { AdminApi, systemModules, browseTableModule, verifyAdminKey } from "@helipod/admin";
import { loadProject, type LoadedProject, type ProjectArtifacts } from "@helipod/cli/project";
import type { ComponentDefinition, WakeHost } from "@helipod/component";
import type { BlobStore } from "@helipod/blobstore";
import type { JSONValue, SchemaDefinitionJSON } from "@helipod/values";
import {
  storageContextProvider,
  storageReaper,
  storageModules,
  storageRoutes,
  type StorageRoute,
  type StorageRouteDeps,
} from "@helipod/storage";
import { globalReactivityPollerDriver } from "./global-reactivity-driver";

export interface DurableObjectBootInput {
  /** The statically-bundled app: its schema default-export + `path:name → module` map (§4.2). */
  loaded: LoadedProject;
  /** Composed components (`@helipod/scheduler`/`workflow`/`triggers` …), from `helipod.config.ts`.
   *  Fixed at build time on a DO — adding/removing components needs a redeploy (like the single binary). */
  components?: ComponentDefinition[];
  /** `ctx.storage.sql`. */
  sql: SqlStorageLike;
  /** `ctx.storage.transactionSync` (bind it to `ctx.storage`). */
  transactionSync: TransactionSyncFn;
  /** The deployment admin key (gates `/_admin/*` + `/_admin/wake` + `SetAdminAuth`). Also the storage
   *  capability-token signing key (same as the container path — see `storageContextProvider`). */
  adminKey: string;
  /** The R2-backed (or any) `BlobStore` for file storage. Injected by the DO host (`env.R2` →
   *  `@helipod/blobstore-r2`), never imported — the engine stays blob-store-neutral. Absent → file
   *  storage is inert (no `ctx.storage` provider, no reaper, no `/api/storage/*` routes). */
  blobStore?: BlobStore;
  /** M2b: the Cloudflare D1 binding (`env.DB`) for `.global()` tables, wired here into a `D1DocStore`
   *  (built from `project.schemaJson`, since this layer holds it) and passed to `createEmbeddedRuntime`
   *  as `globalStore`. Absent + no `.global()` table declared → unchanged, D1 untouched. Absent WITH a
   *  `.global()` table declared → `bootDurableObjectRuntime` throws (fail-fast; see below). */
  d1?: D1Client;
  /** Storage upload-URL / capability-token TTL override (ms). Defaults to the provider's 1h. */
  storageUploadTtlMs?: number;
  /** Storage orphan-reaper sweep cadence override (ms). Defaults to the reaper's 60s. */
  storageReaperSweepMs?: number;
  /** M2c: `GlobalReactivityPoller` cadence override (ms) — how often a `.global()` table with a live
   *  subscriber is polled for a version bump. Defaults to the driver's 2000ms. Only meaningful when
   *  `d1` is also set; ignored otherwise (no `.global()` tables → no poller wired at all). */
  globalReactivityPollMs?: number;
  /** The host's single alarm (the DO's `setAlarm`), for driver wake (scheduler/triggers). Optional —
   *  a DO without composed drivers needs no wake. */
  wakeHost?: WakeHost;
  /** Stretch pure-backstop cadences so an idle DO isn't cold-woken every 30s (§ wake-seam). */
  backstopMs?: (defaultMs: number) => number;
  /** Injected clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export interface DurableObjectBoot {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  store: SqliteDocStore;
  project: ProjectArtifacts;
  logSink: InMemoryLogSink;
  adminKey: string;
  /** Engine-owned `/api/storage/*` handlers — present only when a `blobStore` was injected. Empty
   *  otherwise. The DO host matches these ahead of the pure dispatcher (see `host.ts`). */
  storageRoutes: StorageRoute[];
  /** Reserved routes contributed by composed components (e.g. auth's OAuth callbacks). Always wired —
   *  independent of file storage. Matched after storage routes, before user routes. */
  componentRoutes: StorageRoute[];
}

/**
 * Compose + open the store + build the runtime. Intended to run inside the DO constructor's
 * `blockConcurrencyWhile` (so no request interleaves a half-built runtime). Throws loudly on a
 * schema/component error — the caller must catch it and surface it (a throw here would otherwise
 * brick the DO; §8.4).
 */
export async function bootDurableObjectRuntime(input: DurableObjectBootInput): Promise<DurableObjectBoot> {
  const components = input.components ?? [];
  const project = loadProject(input.loaded, components);
  const logSink = new InMemoryLogSink();

  const store = new SqliteDocStore(new DoSqliteAdapter({ sql: input.sql, transactionSync: input.transactionSync }));
  // Idempotent DDL — safe to call on every cold wake; `createEmbeddedRuntime` also calls it.
  await store.setupSchema();

  // M2b: `.global()` tables → a D1-backed store. Constructed here (we hold `project.schemaJson`) and
  // handed to the runtime pre-built, mirroring the primary store above. `applyDdl` is create-only +
  // idempotent, safe on every cold wake. WITHOUT a `d1` binding, a `.global()` table would otherwise
  // fail confusingly deep inside its first mutation (`requireGlobalTxn` in the kernel) — fail fast at
  // boot instead, with a clear message naming the actual gap.
  //
  // `D1DocStore` is handed ONLY the `.global()`-table slice of the schema, not the whole app schema:
  // it DDLs (`CREATE TABLE`/`CREATE INDEX`) every table its schema contains, and D1 must never host a
  // sharded/root table's own DDL (wasted, and can outright fail — e.g. an empty-fields index, legal on
  // the primary MVCC store, is not valid `CREATE INDEX ... ()` SQL). Safe: the kernel/`GlobalTxn` only
  // ever address this store by a `.global()` table's name (routed via `meta.mode === "global"`).
  let globalStore: D1DocStore | undefined;
  if (input.d1) {
    globalStore = new D1DocStore(input.d1, globalOnlySchema(project.schemaJson));
    await globalStore.applyDdl();
  } else if (schemaHasGlobalTable(project.schemaJson)) {
    throw new Error(
      "this app declares a .global() table but no D1 binding (env.DB) is configured on the Durable Object",
    );
  }

  // File storage (`ctx.storage`) — composed ONLY when a `blobStore` is injected (an R2 binding on the
  // DO). Mirrors the container `boot.ts`: the `_storage:*` built-ins go in BOTH `modules` (reached by
  // the action-mode facade's `invoke` and the reaper's `runFunction`) and `systemModules` (reached by
  // the `/api/storage/*` routes' `runSystem`, the trusted path `_admin` uses), the `ctx.storage`
  // provider is PREPENDED to the composed providers, and the orphan reaper is prepended to the drivers
  // (it rides the SAME wake seam scheduler/triggers use on the DO). Absent → byte-less, unchanged.
  const blobStore = input.blobStore;
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    modules: blobStore ? { ...project.moduleMap, ...storageModules } : project.moduleMap,
    systemModules: blobStore ? { ...systemModules(), ...storageModules } : systemModules(),
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(input.adminKey, key),
    componentNames: project.componentNames,
    contextProviders: blobStore
      ? [
          storageContextProvider(blobStore, {
            signingKey: input.adminKey,
            ...(input.storageUploadTtlMs !== undefined ? { uploadTtlMs: input.storageUploadTtlMs } : {}),
          }),
          ...project.contextProviders,
        ]
      : project.contextProviders,
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    ...(globalStore ? { globalStore } : {}),
    // M2c: the global-reactivity poller rides the SAME wake seam as the storage reaper/scheduler/
    // triggers below — additive, only composed when a `globalStore` exists (no D1 binding / no
    // `.global()` table → this array is byte-identical to before Task 6). Ordered ahead of
    // `project.drivers` for the same reason `storageReaper` is: an engine-owned driver, not a
    // component's.
    drivers: [
      ...(blobStore
        ? [storageReaper(blobStore, input.storageReaperSweepMs !== undefined ? { sweepMs: input.storageReaperSweepMs } : undefined)]
        : []),
      ...(globalStore
        ? [
            globalReactivityPollerDriver(
              globalStore.readVersions.bind(globalStore),
              input.globalReactivityPollMs !== undefined ? { intervalMs: input.globalReactivityPollMs } : undefined,
            ),
          ]
        : []),
      ...project.drivers,
    ],
    // Single-shard by mandate (roadmap Global Constraints). Sharding is Slice 6.
    numShards: 1,
    // Decision 6 / §8.1: no process-shaped `setInterval` sweep, no per-session ping heartbeat.
    disableSyncBackgroundTimers: true,
    // The wake seam: a DO stops between requests, so driver timers fire via `runtime.fireDueTimers()`
    // off the DO alarm, not `setTimeout`. Absent → the engine's `setTimeout` default (harmless in a
    // DO that never idles, but a real DO should always pass a wakeHost when it has drivers).
    ...(input.wakeHost ? { wakeHost: input.wakeHost } : {}),
    ...(input.backstopMs ? { backstopMs: input.backstopMs } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  const adminApi = new AdminApi({
    runtime,
    schemaJson: project.schemaJson,
    tableNumbers: project.tableNumbers,
    manifest: project.manifest,
    logSink,
    catalog: project.catalog,
  });

  // Engine-owned `/api/storage/*` handlers — only when file storage is composed. The routes reach the
  // privileged `_storage:_finalize`/`_get` built-ins via `runSystem` (trusted, like `_admin`), which
  // reads `systemModules` (unaffected by any later `setModules` swap — a DO has none anyway). No
  // `checkRead` is wired (authz composition on a DO is a forward gap), so `handleServe` falls back to
  // the capability-token check for private files — same default as the container path.
  const routesForStorage: StorageRoute[] = blobStore
    ? storageRoutes(blobStore, {
        runMutation: async (path, args) => (await runtime.runSystem(path, args as JSONValue)).value,
        runQuery: async (path, args) => (await runtime.runSystem(path, args as JSONValue)).value,
        signingKey: input.adminKey,
      } satisfies StorageRouteDeps)
    : [];

  // Component-contributed reserved routes (e.g. auth's OAuth callbacks) — always wired, independent of
  // file storage. Bind each declared component httpAction to the runtime and shape it as an
  // engine-owned `StorageRoute`. The raw `Authorization: Bearer <token>` is passed straight through as
  // `identity` (no resolution — same convention `httpAction`/storage use). Mirrors the container path.
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

  return { runtime, adminApi, store, project, logSink, adminKey: input.adminKey, storageRoutes: routesForStorage, componentRoutes };
}

/** True when the composed schema declares at least one `.global()` table — drives the fail-fast
 *  check above (a `.global()` table with no D1 binding must never silently become "unavailable"). */
function schemaHasGlobalTable(schemaJson: SchemaDefinitionJSON): boolean {
  return Object.values(schemaJson.tables).some((t) => t.global === true);
}

/** The `.global()`-only slice of the composed schema — see the `D1DocStore` construction above for
 *  why the full app schema must never be handed to it. */
function globalOnlySchema(schemaJson: SchemaDefinitionJSON): SchemaDefinitionJSON {
  const tables: SchemaDefinitionJSON["tables"] = {};
  for (const [name, t] of Object.entries(schemaJson.tables)) {
    if (t.global === true) tables[name] = t;
  }
  return { tables, schemaValidation: schemaJson.schemaValidation };
}
