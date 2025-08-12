/**
 * The shared boot core for `stackbase dev` and `stackbase serve`: load the project, compose
 * app + components, open the SQLite store, build the embedded runtime + admin API. Neither writes
 * codegen nor starts a server — the callers own those (dev writes _generated + watches; serve
 * hardens + serves).
 */
import { mkdirSync, readFileSync, accessSync, constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { NodeSqliteAdapter, BunSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { NodePgClient, PostgresDocStore } from "@stackbase/docstore-postgres";
import type { DocStore } from "@stackbase/docstore";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, browseTableModule, systemModules, verifyAdminKey } from "@stackbase/admin";
import type { GeneratedBundle } from "@stackbase/codegen";
import type { ComponentDefinition } from "@stackbase/component";
import type { RegisteredFunction } from "@stackbase/executor";
import type { JSONValue } from "@stackbase/values";
import type { BlobStore } from "@stackbase/blobstore";
import {
  storageContextProvider,
  storageReaper,
  storageModules,
  storageRoutes,
  type StorageRoute,
  type StorageRouteDeps,
} from "@stackbase/storage";
import { makeBlobStore, isS3Config, resolveStorageConfig, type StorageConfig } from "./blobstore-select";
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
 * Warn (never fail) when S3-shaped settings (`STACKBASE_STORAGE_ENDPOINT`/`REGION`/`PUBLIC_URL`, or
 * their `--storage-endpoint`/etc. flag equivalents) are present but no bucket was configured —
 * `isS3Config`/`makeBlobStore` silently fall back to local FS storage in that case, which is the
 * right default behavior but a silent one: an operator who set the endpoint/region and forgot the
 * bucket would otherwise get FS storage with no indication anything was ignored.
 */
export function warnIfS3ConfigIgnored(storage: StorageConfig | undefined): void {
  if (isS3Config(storage)) return;
  const ignored = storage?.endpoint !== undefined || storage?.region !== undefined || storage?.publicBaseUrl !== undefined;
  if (!ignored) return;
  process.stderr.write(
    "⚠ S3 storage settings (STACKBASE_STORAGE_ENDPOINT/REGION/PUBLIC_URL or --storage-endpoint/etc.) are set, " +
      "but no bucket was provided — S3 config is being IGNORED and storage is falling back to local FS. " +
      "Set STACKBASE_STORAGE_BUCKET (or --storage-bucket) to actually use S3.\n",
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
}): Promise<BootResult> {
  const { project, generated } = push(opts.loaded, opts.components);
  const logSink = new InMemoryLogSink();
  const store = makeStore({ dataPath: opts.dataPath, databaseUrl: opts.databaseUrl });

  // File storage is always on. Blobs sit beside the SQLite file (`<dataDir>/storage`); the signing
  // key is the deployment admin key (already fail-fasted-if-unset by `serve`). The `_storage` table
  // itself was injected into the composed schema/catalog/tableNumbers in `loadProject`.
  const dataDir = dirname(resolve(opts.dataPath));
  const storageConfig = resolveStorageConfig(process.env, opts.storage);
  warnIfS3ConfigIgnored(storageConfig);
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
    contextProviders: [storageContextProvider(blobStore, { signingKey: opts.adminKey }), ...project.contextProviders],
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: [storageReaper(blobStore), ...project.drivers],
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
  return { runtime, adminApi, project, generated, store, logSink, components: opts.components, blobStore, storageRoutes: routes };
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
