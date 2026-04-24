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
 * FILE STORAGE IS OUT OF SCOPE for Slice 3 (§8.9): a DO has no local FS blob store and byte I/O
 * can't run in the transactor turn; `ctx.storage`/`_storage` byte handling on a DO is a later slice.
 * The `_storage` TABLE still exists (loadProject injects it) so schemas that reference `Id<"_storage">`
 * compile — only the byte-moving provider/reaper are absent. The fixture app avoids file storage.
 */
import { SqliteDocStore } from "@stackbase/docstore-sqlite";
import { DoSqliteAdapter, type SqlStorageLike, type TransactionSyncFn } from "@stackbase/docstore-do-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, systemModules, browseTableModule, verifyAdminKey } from "@stackbase/admin";
import { loadProject, type LoadedProject, type ProjectArtifacts } from "@stackbase/cli/project";
import type { ComponentDefinition, WakeHost } from "@stackbase/component";

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
  /** The deployment admin key (gates `/_admin/*` + `/_admin/wake` + `SetAdminAuth`). */
  adminKey: string;
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

  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    modules: project.moduleMap,
    systemModules: systemModules(),
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(input.adminKey, key),
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
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

  return { runtime, adminApi, store, project, logSink, adminKey: input.adminKey };
}
