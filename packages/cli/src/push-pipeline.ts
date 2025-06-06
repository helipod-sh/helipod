/**
 * The push pipeline: load the project → run codegen → return artifacts. `stackbase dev` runs
 * this on startup and on every file change (hot reload re-runs `push` and re-registers the
 * module map with the running engine — no restart).
 */
import { generateAll, type GeneratedBundle } from "@stackbase/codegen";
import type { ComponentDefinition } from "@stackbase/component";
import { loadProject, type LoadedProject, type ProjectArtifacts } from "./project";

export interface PushResult {
  project: ProjectArtifacts;
  generated: GeneratedBundle;
}

export function push(loaded: LoadedProject, components: ComponentDefinition[] = []): PushResult {
  const project = loadProject(loaded, components);
  const generated = generateAll({
    schema: project.schemaJson,
    manifest: project.manifest,
    components: components.map((c) => ({ name: c.name, contextType: c.contextType })),
  });
  return { project, generated };
}
