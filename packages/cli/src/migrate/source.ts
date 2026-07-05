/**
 * The migration source-adapter seam. A `MigrationSource` inspects a project of some origin
 * backend and produces a `MigrationPlan` — the file edits, scaffold, and divergence report that
 * turn it into a Helipod project. v1 ships only a Convex source; Supabase/Firebase are future
 * sources registered the same way.
 */
export interface FileEdit {
  /** Absolute path of an existing file to overwrite in place. */
  path: string;
  newContent: string;
}
export interface FileWrite {
  /** Absolute path of a new file to create. */
  path: string;
  content: string;
}
export type ReportSeverity = "auto-fixed" | "action-needed" | "unsupported";
export interface ReportEntry {
  severity: ReportSeverity;
  file: string;
  line?: number;
  /** What was found, e.g. `.withIndex(...) query`. */
  what: string;
  /** The concrete Helipod equivalent or next step. */
  fix: string;
}
export interface MigrationPlan {
  edits: FileEdit[];
  scaffold: FileWrite[];
  report: ReportEntry[];
}
export interface MigrationSource {
  id: string;
  detect(projectRoot: string): Promise<boolean>;
  analyze(projectRoot: string, appDir: string): Promise<MigrationPlan>;
}

export function resolveSource(sources: Record<string, MigrationSource>, id: string): MigrationSource {
  const source = sources[id];
  if (!source) {
    throw new Error(`unknown migration source "${id}" (available: ${Object.keys(sources).join(", ")})`);
  }
  return source;
}
