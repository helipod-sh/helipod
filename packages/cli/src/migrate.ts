/**
 * `stackbase migrate` — turn an existing Convex project into a Stackbase project: rewrite
 * imports, scaffold config, write a divergence report, and regenerate `_generated/`. v1 supports
 * only `--from convex`; other origin backends register into `SOURCES` the same way.
 */
import { writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeGenerated, generateServer } from "@stackbase/codegen";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { resolveSource, type MigrationSource, type ReportEntry } from "./migrate/source";
import { convexSource } from "./migrate/convex-source";
import { migrateExportCommand, migrateImportCommand } from "./migrate/data";
import { DEFAULT_FUNCTIONS_DIR } from "./functions-dir";

const SOURCES: Record<string, MigrationSource> = { convex: convexSource };

interface MigrateOptions {
  from: string;
  functionsDir: string;
  dryRun: boolean;
  force: boolean;
}
function parse(args: string[]): MigrateOptions {
  const out: MigrateOptions = { from: "convex", functionsDir: "convex", dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from" && args[i + 1]) out.from = args[++i]!;
    else if (a === "--dir" && args[i + 1]) out.functionsDir = args[++i]!;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

export function renderReport(entries: ReportEntry[]): string {
  const by = (s: string) => entries.filter((e) => e.severity === s);
  const section = (title: string, items: ReportEntry[]) =>
    items.length === 0
      ? ""
      : `\n## ${title} (${items.length})\n\n` +
        items.map((e) => `- \`${e.file}${e.line ? `:${e.line}` : ""}\` — ${e.what}. **Fix:** ${e.fix}`).join("\n") +
        "\n";
  return (
    `# Stackbase migration report\n\n` +
    `${by("auto-fixed").length} auto-fixed, ${by("action-needed").length} action-needed, ${by("unsupported").length} unsupported.\n` +
    section("Auto-fixed", by("auto-fixed")) +
    section("Action needed", by("action-needed")) +
    section("Unsupported", by("unsupported"))
  );
}

/** Is `dir` inside a git repo with uncommitted changes? Returns null if not a git repo. */
function gitDirty(dir: string): boolean | null {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim().length > 0;
}

export async function migrateCommand(args: string[]): Promise<number> {
  // Data-migration verbs (Slice 5) — `migrate export`/`migrate import` move an app's DATA between the
  // portable and DO-native topologies. Kept under `migrate` (a sibling of the bare-`migrate` Convex
  // codemod, which is unchanged) so `stackbase migrate` stays one coherent command.
  if (args[0] === "export") return migrateExportCommand(args.slice(1));
  if (args[0] === "import") return migrateImportCommand(args.slice(1));

  const opts = parse(args);
  const functionsDir = resolve(opts.functionsDir);
  const projectRoot = dirname(functionsDir);

  const dirty = gitDirty(projectRoot);
  if (dirty === true && !opts.force) {
    process.stderr.write(
      `refusing to migrate: ${projectRoot} has uncommitted changes (commit/stash first, or pass --force)\n`,
    );
    return 1;
  }
  if (dirty === null) {
    process.stderr.write(`warning: ${projectRoot} is not a git repo — changes will be made in place with no easy revert\n`);
  }

  let source: MigrationSource;
  try {
    source = resolveSource(SOURCES, opts.from);
  } catch (e) {
    process.stderr.write(`${String(e)}\n`);
    return 1;
  }
  if (!(await source.detect(projectRoot))) {
    process.stderr.write(`no ${opts.from} project detected at ${projectRoot}\n`);
    return 1;
  }

  // Rename the functions directory to Stackbase's own convention. Runs AFTER detect (which looks
  // for convex/schema.ts on the untouched tree) and BEFORE analyze, so every path in the plan
  // already refers to the new location. A project that declares its own `functionsDir` wins, so
  // migrate can never produce a layout the CLI would then fail to find.
  const cfg = await loadConfig(projectRoot);
  const targetName = cfg.functionsDir ?? DEFAULT_FUNCTIONS_DIR;
  const targetDir = isAbsolute(targetName) ? targetName : join(projectRoot, targetName);
  let migratedDir = functionsDir;
  let renamed = false;
  if (resolve(functionsDir) !== resolve(targetDir)) {
    if (existsSync(targetDir)) {
      process.stderr.write(
        `refusing to migrate: ${targetDir} already exists (remove or rename it, then re-run)\n`,
      );
      return 1;
    }
    // `dirty` (computed above) already tells us whether projectRoot is a git repo at all — reuse
    // that signal instead of shelling out to git again. Inside a repo, prefer `git mv` so the
    // rename shows up as a rename in history rather than a delete+add; fall back to a plain
    // filesystem rename if git mv fails for any reason (e.g. the dir isn't tracked yet).
    let didGitMv = false;
    if (dirty !== null) {
      const r = spawnSync("git", ["mv", functionsDir, targetDir], { cwd: projectRoot });
      didGitMv = r.status === 0;
    }
    if (!didGitMv) renameSync(functionsDir, targetDir);
    migratedDir = targetDir;
    renamed = true;
    process.stdout.write(`renamed ${functionsDir} → ${targetDir}\n`);
  }

  const plan = await source.analyze(projectRoot, migratedDir);
  if (renamed) {
    plan.report.unshift({
      severity: "auto-fixed",
      file: `${basename(functionsDir)}/`,
      what: `renamed to ${basename(targetDir)}/`,
      fix: `Your backend functions now live in ${basename(targetDir)}/. Imports inside that folder are relative and did not change.`,
    });
  }

  // Always write the report first (so a later regen failure still leaves it).
  writeFileSync(join(projectRoot, "MIGRATION-REPORT.md"), renderReport(plan.report));

  if (opts.dryRun) {
    process.stdout.write(
      `[dry-run] ${plan.edits.length} files would change, ${plan.scaffold.length} scaffolded. See MIGRATION-REPORT.md\n`,
    );
    return 0;
  }

  for (const edit of plan.edits) writeFileSync(edit.path, edit.newContent);
  for (const file of plan.scaffold) if (!existsSync(file.path)) writeFileSync(file.path, file.content);

  // Regenerate _generated/ via the standard pipeline.
  try {
    const generatedDir = join(migratedDir, "_generated");

    // Delete the app's existing `_generated/` before regenerating (spec §88). A real Convex app
    // ships `_generated/{server.js, server.d.ts, api.js, api.d.ts, dataModel.d.ts}` — the pre-write
    // guard below only checks for `server.ts` (Stackbase's own extension), so those stale Convex
    // artifacts would otherwise survive untouched and can shadow the regenerated Stackbase files
    // (a JS-first resolver picks the stale `server.js`, which imports the now-uninstalled
    // "convex/server"). `force: true` makes this a no-op when the dir is absent (the from-scratch
    // migration case), preserving existing behavior there.
    rmSync(generatedDir, { recursive: true, force: true });

    const config = await loadConfig(projectRoot);

    // A project migrated straight from Convex source has NEVER had `_generated/` written — its
    // hand-authored function files (e.g. `notes.ts`) already `import ... from "./_generated/
    // server"`, so `loadConvexDir`'s dynamic import of them needs that file to exist on disk
    // *before* the real codegen below ever runs. `generateServer`'s output doesn't depend on the
    // schema (only on composed components), so pre-writing it here is safe — the accurate,
    // final version (from the fully-loaded project) overwrites this stub a few lines down.
    if (!existsSync(join(generatedDir, "server.ts"))) {
      const stub = generateServer(
        { tables: {}, schemaValidation: false },
        { components: config.components.map((c) => ({ name: c.name, contextType: c.contextType, serverExports: c.serverExports })) },
      );
      mkdirSync(generatedDir, { recursive: true });
      writeFileSync(join(generatedDir, "server.ts"), stub.content);
    }

    const loaded = await loadConvexDir(migratedDir);
    const { generated } = push(loaded, config.components);
    writeGenerated(generated.files, generatedDir);
  } catch (e) {
    process.stderr.write(
      `imports migrated, but codegen failed: ${String(e)}\nSee MIGRATION-REPORT.md; fix the flagged items, then run \`stackbase codegen\`.\n`,
    );
    return 1;
  }

  const n = plan.report.filter((r) => r.severity !== "auto-fixed").length;
  process.stdout.write(`migrated ${plan.edits.length} files. ${n} item(s) need manual attention — see MIGRATION-REPORT.md\n`);
  return 0;
}
