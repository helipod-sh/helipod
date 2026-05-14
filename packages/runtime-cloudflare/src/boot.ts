/**
 * Boot a Stackbase `EmbeddedRuntime` INSIDE a Durable Object, over the DO's own SQLite.
 *
 * This is the DO-shaped counterpart to the CLI's `bootLoaded` — but deliberately lean and
 * workerd-safe: it uses NONE of `bootLoaded`'s node/fs machinery (no `NodeSqliteAdapter`, no
 * blobstore-fs, no object-store/fleet/replica). It reuses the SHIPPED PURE pieces:
 *   - `loadProject` (via `@stackbase/cli/project`, the subpath that does NOT pull `node:http`) to
 *     compose the statically-bundled `{ schema, modules }` + components into catalog/moduleMap/
 *     tableNumbers/contextProviders/drivers/bootSteps/routes (§4.2 — bundling replaces the dir scan);
 *   - `new SqliteDocStore(new DoSqliteAdapter({ sql, transactionSync }))` for storage (Slice 2);
 *   - `createEmbeddedRuntime` for the engine itself;
 *   - `AdminApi` for the `/_admin/*` + dashboard-browse routes.
 *
 * FILE STORAGE (`ctx.storage`) is wired HERE when a `blobStore` is injected (an R2-backed
 * `@stackbase/blobstore-r2` on the DO — the engine stays blob-store-neutral, same story as the
 * `DocStore`). The `_storage` TABLE always exists (loadProject injects it) so schemas that reference
 * `Id<"_storage">` compile regardless; with a `blobStore`, the byte-moving provider (`ctx.storage`),
 * the orphan reaper (riding the wake seam), and the `/api/storage/*` serve routes are all composed —
 * exactly as the container `boot.ts` does. WITHOUT a `blobStore` (no R2 binding), file storage is
 * inert (metadata-only calls to `ctx.storage` have no provider) — byte-less deployments are unchanged.
 *
 * Byte I/O never runs in the transactor turn: the provider's writes are metadata-only, and the actual
 * `blobStore.store`/`read` happens in the DO's `fetch` handler serving `/api/storage/*` (§8.9's rule).
 */
import { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { DoSqliteAdapter, type SqlStorageLike, type TransactionSyncFn } from "@stackbase/docstore-do-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, systemModules, browseTableModule, verifyAdminKey } from "@stackbase/admin";
import { loadProject, type LoadedProject, type ProjectArtifacts } from "@stackbase/cli/project";
import type { ComponentDefinition, WakeHost } from "@stackbase/component";
import type { BlobStore } from "@stackbase/blobstore";
import type { JSONValue } from "@stackbase/values";
import {
  storageContextProvider,
  storageReaper,
  storageModules,
  storageRoutes,
  type StorageRoute,
  type StorageRouteDeps,
} from "@stackbase/storage";

export interface DurableObjectBootInput {
  /** The statically-bundled app: its schema default-export + `path:name → module` map (§4.2). */
  loaded: LoadedProject;
  /** Composed components (`@stackbase/scheduler`/`workflow`/`triggers` …), from `stackbase.config.ts`.
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
   *  `@stackbase/blobstore-r2`), never imported — the engine stays blob-store-neutral. Absent → file
   *  storage is inert (no `ctx.storage` provider, no reaper, no `/api/storage/*` routes). */
  blobStore?: BlobStore;
  /** Storage upload-URL / capability-token TTL override (ms). Defaults to the provider's 1h. */
  storageUploadTtlMs?: number;
  /** Storage orphan-reaper sweep cadence override (ms). Defaults to the reaper's 60s. */
  storageReaperSweepMs?: number;
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
    drivers: blobStore
      ? [
          storageReaper(blobStore, input.storageReaperSweepMs !== undefined ? { sweepMs: input.storageReaperSweepMs } : undefined),
          ...project.drivers,
        ]
      : project.drivers,
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
