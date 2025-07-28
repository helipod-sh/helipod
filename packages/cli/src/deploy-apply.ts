/**
 * Server-side apply for `stackbase deploy`: write the pushed tree under a writable dir a sibling
 * chain from the engine's node_modules (so `@stackbase/*` resolves), reuse loadConvexDir → push,
 * gate on an additive-schema diff, then ATOMICALLY swap modules/routes/schema. All validation
 * happens before the first swap, so a rejected deploy leaves the running version fully live.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import type { AdminApi } from "@stackbase/admin";
import type { ComponentDefinition } from "@stackbase/component";
import { loadConvexDir } from "./load-modules";
import { push } from "./push-pipeline";
import { diffSchema, type DeploySchema } from "./schema-diff";
import type { ResolvedRoute } from "./project";

export interface DeployDeps {
  runtime: EmbeddedRuntime;
  adminApi: AdminApi;
  setRoutes: (routes: ResolvedRoute[]) => void;
  components: ComponentDefinition[];
  current: () => { schemaJson: DeploySchema["schemaJson"]; tableNumbers: Record<string, number> };
  deployRoot: string;
}
export type DeployResult =
  | { ok: true; rev: string; functions: number }
  | { ok: false; kind: "load-error" | "schema-incompatible"; error: string };

export async function applyDeploy(
  deps: DeployDeps,
  files: Array<{ path: string; code: string }>,
): Promise<DeployResult> {
  const rev = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 12);
  const dir = join(deps.deployRoot, rev, "convex");
  for (const f of files) {
    const abs = join(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.code);
  }

  let project;
  try {
    const loaded = await loadConvexDir(dir);
    project = push(loaded, deps.components).project;
  } catch (e) {
    return { ok: false, kind: "load-error", error: e instanceof Error ? e.message : String(e) };
  }

  const diff = diffSchema(deps.current(), {
    schemaJson: project.schemaJson as DeploySchema["schemaJson"],
    tableNumbers: project.tableNumbers,
  });
  if (!diff.ok) return { ok: false, kind: "schema-incompatible", error: diff.reason };

  // Atomic swap — only reached after load + diff succeed.
  deps.runtime.setModules(project.moduleMap);
  deps.runtime.setTableNumbers(project.tableNumbers);
  deps.setRoutes(project.routes);
  deps.adminApi.setSchema(project.schemaJson, project.tableNumbers, project.manifest);
  return { ok: true, rev, functions: Object.keys(project.moduleMap).length };
}
