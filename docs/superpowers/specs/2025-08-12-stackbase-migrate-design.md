# `stackbase migrate` — Design Spec

**Date:** 2025-08-12
**Status:** Approved (design)
**Motivation:** The locked "Product identity" decision (CLAUDE.md, 2025-08-12) — Stackbase is its own BaaS with native `@stackbase/*` imports; Convex compatibility is a *migration on-ramp*, not a drop-in promise. This slice builds that on-ramp.

## Problem

Stackbase already runs Convex-shaped functions natively (`v` validators, `query`/`mutation`/`action`, `_generated`, reactivity). What it lacks is a way to *bring a Convex project in*. Today a Convex app won't run on Stackbase because its imports point at `convex/*` packages that don't exist here, its `_generated/` is Convex's, and a handful of runtime APIs diverge. `stackbase migrate` closes that gap for Convex, and establishes the extensible shape for migrating other backends (Supabase, Firebase) later.

## Goals

1. **`stackbase migrate` CLI command** — a new subcommand that transforms a Convex project in place into a working Stackbase project.
2. **Source-adapter seam** — a `MigrationSource` interface so Supabase/Firebase can be added later as pluggable sources without touching the command shell. v1 ships **only** the Convex source.
3. **Convex source (v1), shallow + honest** — rewrite imports, regenerate `_generated/`, update deps, scaffold a `stackbase.config.ts` when a mapped component is needed, and produce a **migration report** flagging every runtime-API divergence it cannot auto-fix, each with `file:line` + the concrete Stackbase equivalent.
4. **Docs sweep** — reconcile the enduser docs to the locked decision: `convex/*` imports → `@stackbase/*`, Convex reframed as "migrate from Convex."

## Non-goals (YAGNI)

- **Supabase/Firebase sources** — seam only; their `analyze` (relational-SQL/RLS/Firebase-collection → document+function model + data ETL) is a separate future slice per source.
- **AST body-transforms** — v1 does NOT rewrite function bodies (`.withIndex`, `ctx.db.patch`, `paginate` shape). It *flags* them in the report with the manual fix. Auto-transforms are per-divergence v1.1 enhancements.
- **Data migration / ETL** — no document copying. (For Convex this is moot — the code migrates; data export/import is the user's, and cross-backend ETL belongs to those future sources.)
- **Convex Auth / Components / vector-search translation** — flagged as unsupported, not translated.

## Ground truth (verified in-repo)

- CLI dispatch is a `switch (cmd)` in `runCli` (`packages/cli/src/cli.ts`) over `dev`/`serve`/`deploy`/`build`/`codegen`/`help`. Adding `case "migrate": return migrateCommand(rest);` is the established pattern.
- A **Convex app and a Stackbase app both** import `query`/`mutation`/`action` (and `httpRouter`/`httpAction`) from `./_generated/server` — so those imports need **no** rewrite; migration just regenerates `_generated/` with Stackbase codegen.
- Stackbase `_generated/` = `api.d.ts`, `dataModel.d.ts`, `internal.d.ts`, `server.ts` (via `writeGenerated` from `@stackbase/codegen`; the `push` pipeline in `packages/cli/src/push-pipeline.ts` builds the bundle). `codegenCommand` (`cli.ts`) already does `loadConvexDir → push → writeGenerated`.
- `httpRouter`/`httpAction` are re-exported from `./_generated/server` (NOT a `@stackbase/server`), so a Convex `import { httpRouter } from "convex/server"` maps to `./_generated/server`, while `import { defineSchema } from "convex/server"` maps to `@stackbase/values`. `convex/server` is therefore **symbol-aware**.
- A basic app needs **no** `stackbase.config.ts` (`examples/chat` has none); only component-using apps do (`examples/auth-demo/stackbase.config.ts` composes `auth`/`defineScheduler`/`defineWorkflow`).
- Divergences already catalogued by the test-harness slice: no `.withIndex(cb)` (Stackbase: `ctx.db.query(t, index).eq(f,v).gte(...).order().collect()`), no `ctx.db.patch` (read-merge-`replace`), `paginate({cursor,pageSize,maxScan?})→{page,nextCursor,hasMore,scanCapped}`, identity is a string token via a context provider (no `ctx.auth.getUserIdentity()` claims object).

## Design

### Command shell — `packages/cli/src/migrate.ts`

```
stackbase migrate [--from <source>] [--dir <appDir>] [--dry-run] [--force]
```
- `--from` default `convex` (the only v1 source). `--dir` default `convex` (the app directory, mirroring the other commands' `--dir`). `--dry-run` previews without writing. `--force` bypasses the dirty-tree guard.
- Flow: resolve source from a registry → `source.detect(root)` (error out with a clear message if the dir isn't a recognizable project of that source) → `source.analyze(root)` → **safety guard** (below) → apply `edits` + `scaffold` (skip if `--dry-run`) → regenerate `_generated/` (reuse the `push`+`writeGenerated` pipeline) → write `MIGRATION-REPORT.md` → print a summary (counts of auto-fixed / action-needed / unsupported + the report path).
- Registered in `runCli`'s switch. Help text updated (`stackbase help` + usage block).

### Source seam — `packages/cli/src/migrate/source.ts`

```ts
export interface MigrationSource {
  id: string;                               // "convex"
  detect(projectRoot: string): Promise<boolean>;
  analyze(projectRoot: string, appDir: string): Promise<MigrationPlan>;
}
export interface MigrationPlan {
  edits: FileEdit[];        // { path, newContent }  — in-place file rewrites (imports, package.json)
  scaffold: FileWrite[];    // { path, content }     — new files (stackbase.config.ts)
  report: ReportEntry[];
}
export interface ReportEntry {
  severity: "auto-fixed" | "action-needed" | "unsupported";
  file: string; line?: number;
  what: string;             // e.g. ".withIndex(...) query"
  fix: string;              // concrete Stackbase equivalent / next step
}
const SOURCES: Record<string, MigrationSource> = { convex: convexSource };
```
v1 populates `SOURCES` with `convex` only. A future PR adds `supabase`/`firebase` here — no change to `migrate.ts`.

### Convex source — `packages/cli/src/migrate/convex-source.ts`

`detect`: the dir contains `<appDir>/schema.ts` or function files importing `convex/*`, or a root `package.json` depending on `convex`.

`analyze` produces three things:

**(a) Import codemod** (specifier-string rewrites — operate on the quoted module specifier so `import`, `export … from`, `require()`, and dynamic `import()` are all covered):
| From | To |
|---|---|
| `convex/values` | `@stackbase/values` |
| `convex/react` | `@stackbase/client/react` |
| `convex/browser` | `@stackbase/client` |
| `convex/server` (only `defineSchema`/`defineTable` imported) | `@stackbase/values` |
| `convex/server` (only `httpRouter`/`httpAction` imported) | `./_generated/server` |
| `convex/server` (mixed/other symbols, or a multi-line clause it can't parse) | **not rewritten** → `action-needed` report entry |
| `./_generated/server` (`query`/`mutation`/`action`/…) | **unchanged** |

The rewriter parses each import's brace clause to route `convex/server` by symbol; single-line clauses are handled, anything ambiguous is flagged rather than guessed. Every applied rewrite yields an `auto-fixed` report entry.

**(b) Scaffold:**
- **`_generated/`** — the command deletes the app's existing `_generated/` and regenerates via the Stackbase pipeline (so a migrated Convex `_generated/` becomes Stackbase's). This is a command-level step, not a `FileEdit`.
- **`package.json`** — a `FileEdit` dropping `convex` and `@convex-dev/*` from deps and adding the `@stackbase/*` packages the codemod actually introduced (e.g. `@stackbase/values`, `@stackbase/client`). Deterministic from the set of rewrites applied.
- **`stackbase.config.ts`** — scaffolded **only if** a mapped component is detected: a `crons.ts`/`cronJobs()` in the app → a config composing `defineScheduler()`. (Convex Auth → `@stackbase/auth` is flagged `unsupported`, not auto-composed, since auth wiring needs decisions.) If none needed, no config is written.

**(c) Divergence scan** (regex/line-based, report-only — no body rewrite):
| Pattern | Severity | Fix in report |
|---|---|---|
| `.withIndex(` | action-needed | `ctx.db.query(t, "index").eq(f,v).gte(...).order(...).collect()` |
| `ctx.db.patch(` | action-needed | read the doc, spread-merge, `ctx.db.replace(id, {...doc, ...patch})` |
| `.paginate(` | action-needed | `paginate({cursor, pageSize, maxScan?})` → `{page, nextCursor, hasMore, scanCapped}` |
| `ctx.auth` / `getUserIdentity(` | action-needed | identity is a string token via a context provider (e.g. `@stackbase/auth`'s `ctx.auth`), not a JWT-claims object |
| `crons.ts` / `cronJobs(` | action-needed | compose `defineScheduler()` in `stackbase.config.ts` (auto-scaffolded if detected) |
| `@convex-dev/auth` / `convex/auth` | unsupported | use `@stackbase/auth` or external JWT — auth is not auto-translated |
| `convex.config.ts` / `app.use(` | unsupported | Convex Components don't map 1:1 — recompose via `stackbase.config.ts` |
| vector/search index in `schema.ts` | unsupported | search/vector not yet supported (see roadmap) |
| residual unmappable `convex/*` import | action-needed | map manually to the `@stackbase/*` equivalent |

### Migration report — `MIGRATION-REPORT.md` (written at project root)

Markdown: a summary line (`N auto-fixed, M action-needed, K unsupported`), then a section per severity, each entry `- <file>:<line> — <what>. **Fix:** <fix>`. This doubles as the compatibility checklist. `--dry-run` still writes it (it's the preview).

### Safety / UX

- **Dirty-tree guard:** if `<projectRoot>` is a git repo with uncommitted changes, `migrate` refuses (exit non-zero, clear message) unless `--force`. Rationale: in-place edits are reviewed and reverted via `git diff`/`git checkout`. If not a git repo, warn but proceed.
- **`--dry-run`:** compute the plan, write only `MIGRATION-REPORT.md`, print the summary + the list of files that *would* change; make no source edits and no `_generated/` regen.
- Idempotent-ish: re-running after a successful migrate rewrites nothing new (specifiers already `@stackbase/*`) and re-reports the still-manual divergences.

### Docs sweep (adjacent task, required by the locked decision)

Rewrite enduser docs' `convex/*` import lines to `@stackbase/*` (same mappings as the codemod): `quickstart.md`, `files.md`, `build/schema.md`, `build/backend-functions.md`, `build/testing.md`, `build/auth.md`, `deploy/{electron,electrobun,tauri}.md`. Reframe the Convex-surface prose in `index.md` and `reference/compatibility.md` from "these are your imports" to "Stackbase uses `@stackbase/*`; migrate an existing Convex app with `stackbase migrate`." Leave `convex/schema.ts`/`convex/` *directory* references intact (the dir name is kept).

## Build order (each an independently testable task)

1. **Source seam + report types** (`migrate/source.ts`) — the `MigrationSource`/`MigrationPlan`/`ReportEntry` interfaces + the `SOURCES` registry (Convex only). Unit: registry resolves `convex`, throws a clear error on an unknown `--from`.
2. **Import codemod** (`migrate/rewrite-imports.ts`) — pure function `rewriteImports(source, filename) → { output, entries }`. Unit: each mapping incl. symbol-aware `convex/server` split, `export…from`/`require`/dynamic forms, mixed-`convex/server` flagged-not-rewritten, `./_generated/server` untouched.
3. **Divergence scanner** (`migrate/scan-divergences.ts`) — `scan(source, filename) → ReportEntry[]`. Unit: each pattern → an entry at the correct line with the right severity/fix; a clean file → none.
4. **Convex source `analyze`** (`migrate/convex-source.ts`) — compose 2+3 over the app tree, build the `package.json` edit + conditional `stackbase.config.ts` scaffold + the full report. Unit over a small in-memory/fixture tree.
5. **`migrate` command + report writer** (`migrate.ts`, wired into `runCli`) — flow, dirty-tree guard, `--dry-run`/`--force`, `_generated/` regen via the existing pipeline, `MIGRATION-REPORT.md` writer, summary. Fixture test: a "Convex app" dir migrates → imports rewritten, `_generated/` regenerated, report lists the divergences.
6. **E2E** (`packages/cli/test/migrate-e2e.test.ts`) — after `migrate` on the fixture, `loadProject` succeeds and a migrated mutation runs on the embedded engine (the migrated app is *valid Stackbase*). Per the "test through the shipped entrypoint" rule.
7. **Docs sweep** — the enduser `convex/*` → `@stackbase/*` rewrites + Convex reframing; full monorepo gate green.

## Testing strategy

- Unit (`packages/cli/test/`): rewriter (Task 2), scanner (Task 3), `analyze` (Task 4) — pure functions, table-driven.
- Fixture (Task 5): a checked-in `packages/cli/test/fixtures/convex-app/` mimicking a real Convex app (schema via `convex/values`, a query using `.withIndex`, a mutation using `ctx.db.patch`, a `convex/react` component, a `crons.ts`). Copied to a temp dir, migrated, asserted.
- E2E (Task 6): the migrated fixture loads + runs on the engine.
- Full `bun run build && bun run typecheck && bun run test` green after Task 7.

## Risks

- **Convex-server symbol ambiguity** — mitigated by parsing the import clause and flagging (never guessing) mixed/unparseable cases; the report tells the user exactly what to do.
- **Codemod over-reach** — operating on the module-specifier string (not statement structure) keeps rewrites precise and avoids mangling code; only the four known specifiers are touched.
- **`_generated/` regen requires a loadable app** — if the migrated app has a hard error (e.g. an unmapped import), codegen fails; the command should surface that clearly and still leave the report (which will contain the flagged cause). Order the flow so the report is written before/independent of the regen step.
- **Scope creep toward body-transforms** — held out explicitly; the report is the deliberate seam between "auto" and "manual."

## Related

- `[[product-identity-native-migrate]]` — the locked decision this implements.
- `[[test-harness-slice-shipped]]` — the source of the divergence catalogue the scanner encodes.
- `[[argument-validation-shipped]]` — its follow-up #2 doc-sweep note is folded into Task 7 here.
- `[[e2e-through-shipped-entrypoint]]`, `[[feedback-decide-decisively]]`.
