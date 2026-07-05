/**
 * Server-side apply for `helipod deploy`: write the pushed tree under a writable dir a sibling
 * chain from the engine's node_modules (so `@helipod/*` resolves), reuse loadFunctionsDir → push,
 * gate on an additive-schema diff, then ATOMICALLY swap modules/routes/schema. All validation
 * happens before the first swap, so a rejected deploy leaves the running version fully live.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { EmbeddedRuntime } from "@helipod/runtime-embedded";
import type { AdminApi } from "@helipod/admin";
import type { ComponentDefinition } from "@helipod/component";
import { sha256Hex } from "@helipod/deploy";
import { loadFunctionsDir } from "./load-modules";
import { push } from "./push-pipeline";
import { withStorageModules } from "./boot";
import { diffSchema, type DeploySchema } from "./schema-diff";
import type { ResolvedRoute } from "./project";

export interface DeployDeps {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  setRoutes: (routes: ResolvedRoute[]) => void;
  components: ComponentDefinition[];
  current: () => { schemaJson: DeploySchema["schemaJson"]; tableNumbers: Record<string, number> };
  deployRoot: string;
  /** The modules from the last successful push this server lifetime — used to resolve `unchanged`
   *  entries in a delta payload. Empty at boot (first deploy is a full push). */
  currentModules: Map<string, { code: string; sha: string }>;
}
export type DeployResult =
  | { ok: true; rev: string; functions: number; modules: Map<string, { code: string; sha: string }> }
  | { ok: false; kind: "load-error" | "schema-incompatible" | "stale-base"; error: string };

/** The wire-safe subset of `DeployResult` — identical shape minus `modules` (a `Map`, which must
 *  never cross HTTP). `serve.ts`'s `deploy.apply` closure strips it before returning; this is the
 *  type that actually travels over `/_admin/deploy`. */
export type DeployWireResult =
  | { ok: true; rev: string; functions: number }
  | { ok: false; kind: "load-error" | "schema-incompatible" | "stale-base"; error: string };

export type DeployPayload =
  | { files: Array<{ path: string; code: string }> }
  | { changed: Array<{ path: string; code: string }>; unchanged: Array<{ path: string; sha256: string }> };

export type ReconstructResult =
  | { ok: true; files: Array<{ path: string; code: string }> }
  | { ok: false; error: string };

/** Rebuild the full file tree from a legacy `{files}` OR a delta `{changed, unchanged}` payload.
 *  Each `unchanged` module is resolved from `currentModules` and its sha verified; a missing path or
 *  a sha disagreement is a `stale-base` (the client retries as a full push). The union of changed +
 *  unchanged is the complete tree, so an unreferenced current module is dropped (deletion by omission). */
export function reconstructFiles(
  payload: DeployPayload,
  currentModules: Map<string, { code: string; sha: string }>,
): ReconstructResult {
  if ("changed" in payload) {
    const files = [...(payload.changed ?? [])];
    for (const u of payload.unchanged ?? []) {
      const cur = currentModules.get(u.path);
      if (!cur) return { ok: false, error: `stale-base: server has no module "${u.path}"` };
      if (cur.sha !== u.sha256) return { ok: false, error: `stale-base: module "${u.path}" hash mismatch` };
      files.push({ path: u.path, code: cur.code });
    }
    return { ok: true, files };
  }
  return { ok: true, files: payload.files ?? [] };
}

export async function applyDeploy(
  deps: DeployDeps,
  payload: DeployPayload,
): Promise<DeployResult> {
  const rec = reconstructFiles(payload, deps.currentModules);
  if (!rec.ok) return { ok: false, kind: "stale-base", error: rec.error };
  const files = rec.files;
  const rev = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  const dir = join(deps.deployRoot, rev, "functions");

  let project;
  try {
    for (const f of files) {
      if (typeof f.path !== "string" || typeof f.code !== "string") {
        throw new Error(`invalid deploy payload: file entry must have a string "path" and "code"`);
      }
      // Reject any path that could escape the per-rev deploy dir — absolute paths, or a `..`
      // segment (checked on `/`-split segments since packageApp always emits `/`-joined paths).
      if (isAbsolute(f.path) || f.path.split("/").includes("..")) {
        throw new Error(`invalid deploy payload: unsafe path "${f.path}"`);
      }
      const abs = join(dir, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.code);
    }
    const loaded = await loadFunctionsDir(dir);
    project = push(loaded, deps.components, deps.current().tableNumbers).project;
  } catch (e) {
    return { ok: false, kind: "load-error", error: e instanceof Error ? e.message : String(e) };
  }

  const diff = diffSchema(deps.current(), {
    schemaJson: project.schemaJson as DeploySchema["schemaJson"],
    tableNumbers: project.tableNumbers,
  });
  if (!diff.ok) return { ok: false, kind: "schema-incompatible", error: diff.reason };

  // Atomic swap — only reached after load + diff succeed. Re-apply the always-on `_storage:*`
  // built-ins (they're not in the pushed moduleMap) so file storage survives a live deploy.
  deps.runtime.setModules(withStorageModules(project.moduleMap));
  deps.runtime.setTableNumbers(project.tableNumbers);
  deps.setRoutes(project.routes);
  deps.adminApi.setSchema(project.schemaJson, project.tableNumbers, project.manifest);
  const modules = new Map(files.map((f) => [f.path, { code: f.code, sha: sha256Hex(f.code) }]));
  return { ok: true, rev, functions: Object.keys(project.moduleMap).length, modules };
}
