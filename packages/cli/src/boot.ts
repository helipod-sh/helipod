/**
 * The shared boot core for `stackbase dev` and `stackbase serve`: load the project, compose
 * app + components, open the SQLite store, build the embedded runtime + admin API. Neither writes
 * codegen nor starts a server — the callers own those (dev writes _generated + watches; serve
 * hardens + serves).
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { NodeSqliteAdapter, BunSqliteAdapter, SqliteDocStore } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { InMemoryLogSink } from "@stackbase/executor";
import { AdminApi, browseTableModule, systemModules, verifyAdminKey } from "@stackbase/admin";
import type { GeneratedBundle } from "@stackbase/codegen";
import type { ComponentDefinition } from "@stackbase/component";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { detectRuntime } from "./dev-options";
import type { ProjectArtifacts } from "./project";

export function makeStore(dataPath: string): SqliteDocStore {
  mkdirSync(dirname(resolve(dataPath)), { recursive: true });
  const adapter = detectRuntime() === "bun" ? new BunSqliteAdapter({ path: dataPath }) : new NodeSqliteAdapter({ path: dataPath });
  return new SqliteDocStore(adapter);
}

export interface BootResult {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  project: ProjectArtifacts;
  generated: GeneratedBundle;
  store: SqliteDocStore;
  logSink: InMemoryLogSink;
  /** The boot-time component set (from stackbase.config.ts) — `applyDeploy` re-composes against it. */
  components: ComponentDefinition[];
}

export async function bootProject(opts: { convexDir: string; dataPath: string; adminKey: string }): Promise<BootResult> {
  const loaded = await loadConvexDir(opts.convexDir);
  const config = await loadConfig(dirname(opts.convexDir));
  const { project, generated } = push(loaded, config.components);
  const logSink = new InMemoryLogSink();
  const store = makeStore(opts.dataPath);
  const runtime = await createEmbeddedRuntime({
    store,
    catalog: project.catalog,
    logSink,
    modules: project.moduleMap,
    systemModules: systemModules(),
    adminModules: { "_admin:browseTable": browseTableModule },
    verifyAdmin: (key: string) => verifyAdminKey(opts.adminKey, key),
    componentNames: project.componentNames,
    contextProviders: project.contextProviders,
    tableNumbers: project.tableNumbers,
    bootSteps: project.bootSteps,
    drivers: project.drivers,
  });
  const adminApi = new AdminApi({
    runtime,
    schemaJson: project.schemaJson,
    tableNumbers: project.tableNumbers,
    manifest: project.manifest,
    logSink,
    catalog: project.catalog,
  });
  return { runtime, adminApi, project, generated, store, logSink, components: config.components };
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
