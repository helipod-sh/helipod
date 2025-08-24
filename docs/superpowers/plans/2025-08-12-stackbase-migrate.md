# `stackbase migrate` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `stackbase migrate` CLI command that transforms a Convex project in place into a working Stackbase project — rewriting imports, regenerating `_generated/`, scaffolding deps/config, and emitting a migration report of everything that needs manual attention.

**Architecture:** A `MigrationSource` seam (v1 ships only a Convex source) whose `analyze()` returns a `MigrationPlan` of file edits + scaffold + a divergence report. The command shell applies the plan (unless `--dry-run`), regenerates `_generated/` by reusing the existing `loadConvexDir → push → writeGenerated` pipeline, writes `MIGRATION-REPORT.md`, and prints a summary. The Convex source is a *shallow* codemod (import specifiers only) + a *report* of runtime-API divergences it deliberately does not auto-transform.

**Tech Stack:** TypeScript, Bun (pkg manager + runtime), Turborepo, vitest (under Node), `node:fs`/`node:path`/`node:child_process`. Reuses `@stackbase/codegen` (`writeGenerated`) and existing `packages/cli/src` helpers (`loadConvexDir`, `loadConfig`, `push`, `loadProject`).

## Global Constraints

- **Convex source only in v1.** The `MigrationSource` seam must exist and be extensible, but only `convexSource` is registered. Supabase/Firebase are out of scope (seam reserved).
- **Shallow codemod — imports only.** Rewrite module *specifier strings*; NEVER transform function bodies. `.withIndex`/`ctx.db.patch`/`paginate`/`ctx.auth` etc. are *reported*, not rewritten.
- **`./_generated/server` imports are left unchanged** (identical in Convex and Stackbase). Only `convex/*` specifiers are touched.
- **Import mappings (exact):** `convex/values`→`@stackbase/values`; `convex/react`→`@stackbase/client/react`; `convex/browser`→`@stackbase/client`; `convex/server` is **symbol-aware**: `{defineSchema,defineTable}`→`@stackbase/values`, `{httpRouter,httpAction}`→`./_generated/server`, mixed/other/unparseable→NOT rewritten + an `action-needed` report entry.
- **Report severities (exact strings):** `"auto-fixed"`, `"action-needed"`, `"unsupported"`.
- **Report is always written** (including `--dry-run`), to `MIGRATION-REPORT.md` at the project root. Write it BEFORE the `_generated/` regen step (so a regen failure still leaves the report).
- **Dirty-tree guard:** refuse (non-zero exit) if the project root is a git repo with uncommitted changes, unless `--force`. Not a git repo → warn, proceed.
- **Tests run under Node/vitest.** `globalThis.Bun` is undefined; no Bun-API assertions.
- **cli tests resolve `@stackbase/*` deps via built `dist/`.** Rebuild changed deps before a cli test that imports them across packages. (Tasks here live in `@stackbase/cli` and mostly test pure functions in that package's own `src` — no rebuild needed for those; the E2E in Task 6 imports `@stackbase/codegen`/`@stackbase/runtime-embedded` via `dist`, already built.)
- **Commit trailer** on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```

## File Structure

- `packages/cli/src/migrate/source.ts` — CREATE. Seam types (`MigrationSource`, `MigrationPlan`, `ReportEntry`, `FileEdit`, `FileWrite`) + pure `resolveSource(sources, id)`.
- `packages/cli/src/migrate/rewrite-imports.ts` — CREATE. Pure `rewriteImports(source, file)`.
- `packages/cli/src/migrate/scan-divergences.ts` — CREATE. Pure `scanDivergences(source, file)`.
- `packages/cli/src/migrate/convex-source.ts` — CREATE. `convexSource: MigrationSource`.
- `packages/cli/src/migrate.ts` — CREATE. `migrateCommand(args)` + `renderReport(entries)` + the `SOURCES` registry.
- `packages/cli/src/cli.ts` — MODIFY. Add `case "migrate"` + import + help text.
- `packages/cli/test/migrate-*.test.ts` — CREATE. Unit tests per task.
- `packages/cli/test/fixtures/convex-app/` — CREATE. A fake Convex app for Tasks 5–6.
- `packages/cli/test/migrate-e2e.test.ts` — CREATE. Post-migrate load + run.
- `docs/enduser/**` — MODIFY (Task 7). `convex/*` → `@stackbase/*` + reframing.

**Note on the registry:** the spec put `SOURCES` in `source.ts`; this plan keeps `source.ts` pure (types + `resolveSource(sources, id)`) and assembles `SOURCES = { convex: convexSource }` in `migrate.ts`, so Task 1 is testable without depending on Task 4. Same behavior, cleaner task isolation.

---

### Task 1: Seam types + `resolveSource`

**Files:**
- Create: `packages/cli/src/migrate/source.ts`
- Test: `packages/cli/test/migrate-source.test.ts`

**Interfaces:**
- Produces: the types below + `resolveSource(sources: Record<string, MigrationSource>, id: string): MigrationSource` (throws on unknown id).

- [ ] **Step 1: Write the failing test**

`packages/cli/test/migrate-source.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveSource, type MigrationSource } from "../src/migrate/source";

const fake: MigrationSource = {
  id: "convex",
  detect: async () => true,
  analyze: async () => ({ edits: [], scaffold: [], report: [] }),
};

describe("resolveSource", () => {
  it("resolves a registered source by id", () => {
    expect(resolveSource({ convex: fake }, "convex")).toBe(fake);
  });
  it("throws a clear error on an unknown source", () => {
    expect(() => resolveSource({ convex: fake }, "supabase")).toThrow(/unknown migration source "supabase"/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-source.test.ts`
Expected: FAIL — `../src/migrate/source` does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/migrate/source.ts`:
```ts
/**
 * The migration source-adapter seam. A `MigrationSource` inspects a project of some origin
 * backend and produces a `MigrationPlan` — the file edits, scaffold, and divergence report that
 * turn it into a Stackbase project. v1 ships only a Convex source; Supabase/Firebase are future
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
  /** The concrete Stackbase equivalent or next step. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/migrate/source.ts packages/cli/test/migrate-source.test.ts
git commit -m "feat(cli): migration source-adapter seam + report types

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Import codemod (`rewriteImports`)

**Files:**
- Create: `packages/cli/src/migrate/rewrite-imports.ts`
- Test: `packages/cli/test/migrate-rewrite-imports.test.ts`

**Interfaces:**
- Consumes: `ReportEntry` from `./source`.
- Produces: `rewriteImports(source: string, file: string): { output: string; entries: ReportEntry[] }`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/migrate-rewrite-imports.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { rewriteImports } from "../src/migrate/rewrite-imports";

describe("rewriteImports", () => {
  it("rewrites convex/values → @stackbase/values (import + entry)", () => {
    const r = rewriteImports(`import { v } from "convex/values";\n`, "schema.ts");
    expect(r.output).toBe(`import { v } from "@stackbase/values";\n`);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ severity: "auto-fixed", file: "schema.ts", line: 1 });
  });

  it("rewrites convex/react → @stackbase/client/react and convex/browser → @stackbase/client", () => {
    expect(rewriteImports(`import { X } from "convex/react";`, "a.tsx").output).toContain(`"@stackbase/client/react"`);
    expect(rewriteImports(`import { X } from "convex/browser";`, "a.ts").output).toContain(`"@stackbase/client"`);
  });

  it("covers export-from, require, and dynamic import forms", () => {
    expect(rewriteImports(`export { v } from "convex/values";`, "a.ts").output).toContain(`"@stackbase/values"`);
    expect(rewriteImports(`const { v } = require("convex/values");`, "a.ts").output).toContain(`"@stackbase/values"`);
    expect(rewriteImports(`await import("convex/values");`, "a.ts").output).toContain(`"@stackbase/values"`);
  });

  it("convex/server: schema symbols → @stackbase/values", () => {
    const r = rewriteImports(`import { defineSchema, defineTable } from "convex/server";`, "schema.ts");
    expect(r.output).toContain(`from "@stackbase/values"`);
    expect(r.entries[0]?.severity).toBe("auto-fixed");
  });

  it("convex/server: httpRouter/httpAction → ./_generated/server", () => {
    const r = rewriteImports(`import { httpRouter, httpAction } from "convex/server";`, "http.ts");
    expect(r.output).toContain(`from "./_generated/server"`);
  });

  it("convex/server: mixed/unknown symbols are NOT rewritten and are flagged action-needed", () => {
    const src = `import { defineSchema, cronJobs } from "convex/server";`;
    const r = rewriteImports(src, "x.ts");
    expect(r.output).toBe(src); // unchanged
    expect(r.entries[0]).toMatchObject({ severity: "action-needed", file: "x.ts" });
  });

  it("leaves ./_generated/server untouched", () => {
    const src = `import { query, mutation } from "./_generated/server";`;
    const r = rewriteImports(src, "m.ts");
    expect(r.output).toBe(src);
    expect(r.entries).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-rewrite-imports.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/migrate/rewrite-imports.ts`:
```ts
import type { ReportEntry } from "./source";

/** Unambiguous specifier → target rewrites (applied wherever the quoted specifier appears). */
const SIMPLE: Record<string, string> = {
  "convex/values": "@stackbase/values",
  "convex/react": "@stackbase/client/react",
  "convex/browser": "@stackbase/client",
};

const SCHEMA_SYMBOLS = new Set(["defineSchema", "defineTable"]);
const SERVER_SYMBOLS = new Set(["httpRouter", "httpAction"]);

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Rewrite Convex import specifiers to their Stackbase equivalents. Operates on the quoted module
 * specifier so `import`, `export … from`, `require()`, and dynamic `import()` are all handled.
 * `convex/server` is symbol-aware; `./_generated/server` is left alone.
 */
export function rewriteImports(source: string, file: string): { output: string; entries: ReportEntry[] } {
  const entries: ReportEntry[] = [];
  let output = source;

  // 1. Unambiguous specifiers — replace every quoted occurrence.
  for (const [from, to] of Object.entries(SIMPLE)) {
    const re = new RegExp(`(["'])${from.replace("/", "\\/")}\\1`, "g");
    output = output.replace(re, (_m, q, offset: number) => {
      entries.push({ severity: "auto-fixed", file, line: lineOf(source, offset), what: `import "${from}"`, fix: `rewritten to "${to}"` });
      return `${q}${to}${q}`;
    });
  }

  // 2. convex/server — symbol-aware (single-line brace clause only).
  const serverRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])convex\/server\2/g;
  output = output.replace(serverRe, (full, names: string, q: string, offset: number) => {
    const line = lineOf(source, offset);
    const syms = names.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean);
    const allSchema = syms.length > 0 && syms.every((s) => SCHEMA_SYMBOLS.has(s));
    const allServer = syms.length > 0 && syms.every((s) => SERVER_SYMBOLS.has(s));
    if (allSchema) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (schema)`, fix: `rewritten to "@stackbase/values"` });
      return full.replace(/["']convex\/server["']/, `${q}@stackbase/values${q}`);
    }
    if (allServer) {
      entries.push({ severity: "auto-fixed", file, line, what: `import "convex/server" (http)`, fix: `rewritten to "./_generated/server"` });
      return full.replace(/["']convex\/server["']/, `${q}./_generated/server${q}`);
    }
    entries.push({ severity: "action-needed", file, line, what: `import { ${syms.join(", ")} } from "convex/server"`, fix: `map each symbol manually: defineSchema/defineTable → "@stackbase/values"; httpRouter/httpAction → "./_generated/server"` });
    return full; // leave unchanged
  });

  // 3. Any convex/server occurrence NOT matched above (default import, multiline, require, dynamic).
  const residualRe = /(["'])convex\/server\1/g;
  let m: RegExpExecArray | null;
  while ((m = residualRe.exec(output)) !== null) {
    entries.push({ severity: "action-needed", file, line: lineOf(output, m.index), what: `import "convex/server"`, fix: `map manually: defineSchema/defineTable → "@stackbase/values"; httpRouter/httpAction → "./_generated/server"` });
  }

  return { output, entries };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-rewrite-imports.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/migrate/rewrite-imports.ts packages/cli/test/migrate-rewrite-imports.test.ts
git commit -m "feat(cli): Convex import codemod (specifier rewrite, symbol-aware convex/server)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Divergence scanner (`scanDivergences`)

**Files:**
- Create: `packages/cli/src/migrate/scan-divergences.ts`
- Test: `packages/cli/test/migrate-scan-divergences.test.ts`

**Interfaces:**
- Consumes: `ReportEntry` from `./source`.
- Produces: `scanDivergences(source: string, file: string): ReportEntry[]`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/migrate-scan-divergences.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { scanDivergences } from "../src/migrate/scan-divergences";

describe("scanDivergences", () => {
  it("flags .withIndex, ctx.db.patch, and .paginate as action-needed with line numbers", () => {
    const src = [
      `const a = ctx.db.query("m").withIndex("by_x", q => q.eq("x", 1));`,
      `await ctx.db.patch(id, { seen: true });`,
      `const p = await ctx.db.query("m").paginate(opts);`,
    ].join("\n");
    const e = scanDivergences(src, "m.ts");
    expect(e.map((x) => x.what)).toEqual(expect.arrayContaining([
      expect.stringContaining("withIndex"),
      expect.stringContaining("patch"),
      expect.stringContaining("paginate"),
    ]));
    expect(e.every((x) => x.severity === "action-needed")).toBe(true);
    expect(e.find((x) => x.what.includes("withIndex"))?.line).toBe(1);
    expect(e.find((x) => x.what.includes("patch"))?.line).toBe(2);
  });

  it("flags ctx.auth / getUserIdentity as action-needed", () => {
    const e = scanDivergences(`const id = await ctx.auth.getUserIdentity();`, "a.ts");
    expect(e[0]?.severity).toBe("action-needed");
  });

  it("flags Convex Auth and vector/search as unsupported", () => {
    expect(scanDivergences(`import {} from "@convex-dev/auth/server";`, "a.ts")[0]?.severity).toBe("unsupported");
    expect(scanDivergences(`table.vectorIndex("by_embedding", { vectorField: "e", dimensions: 1536 });`, "schema.ts")[0]?.severity).toBe("unsupported");
  });

  it("flags a crons file by name", () => {
    const e = scanDivergences(`export default cronJobs();`, "crons.ts");
    expect(e[0]).toMatchObject({ severity: "action-needed" });
    expect(e[0]?.what.toLowerCase()).toContain("cron");
  });

  it("returns nothing for a clean file", () => {
    expect(scanDivergences(`export const x = 1;\n`, "clean.ts")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-scan-divergences.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/migrate/scan-divergences.ts`:
```ts
import { basename } from "node:path";
import type { ReportEntry, ReportSeverity } from "./source";

interface Rule {
  test: RegExp;
  severity: ReportSeverity;
  what: string;
  fix: string;
}

const RULES: Rule[] = [
  { test: /\.withIndex\s*\(/, severity: "action-needed", what: ".withIndex(...) query",
    fix: `Stackbase has no .withIndex — use ctx.db.query(table, "index").eq(f, v).gte(f, v).order("asc"|"desc").collect()` },
  { test: /ctx\.db\.patch\s*\(/, severity: "action-needed", what: "ctx.db.patch(...)",
    fix: `Stackbase has no patch — read the doc, spread-merge, ctx.db.replace(id, { ...doc, ...changes })` },
  { test: /\.paginate\s*\(/, severity: "action-needed", what: ".paginate(...)",
    fix: `Stackbase paginate({ cursor, pageSize, maxScan? }) returns { page, nextCursor, hasMore, scanCapped }` },
  { test: /ctx\.auth\b|getUserIdentity\s*\(/, severity: "action-needed", what: "ctx.auth / getUserIdentity()",
    fix: `Identity is a string token via a context provider (e.g. @stackbase/auth's ctx.auth), not a JWT-claims object` },
  { test: /@convex-dev\/auth|["']convex\/auth["']/, severity: "unsupported", what: "Convex Auth",
    fix: `Auth is not auto-translated — use @stackbase/auth or external JWT` },
  { test: /\bapp\.use\s*\(/, severity: "unsupported", what: "Convex Component (app.use)",
    fix: `Convex Components don't map 1:1 — recompose via stackbase.config.ts` },
  { test: /\.vectorIndex\s*\(|\.searchIndex\s*\(/, severity: "unsupported", what: "vector/search index",
    fix: `search/vector is not yet supported in Stackbase (see roadmap)` },
];

/** Line-based scan for Convex runtime-API divergences Stackbase does NOT auto-transform. */
export function scanDivergences(source: string, file: string): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const lines = source.split("\n");

  // Whole-file signals keyed on filename.
  const base = basename(file);
  if (base === "crons.ts" || /\bcronJobs\s*\(/.test(source)) {
    const idx = lines.findIndex((l) => /\bcronJobs\s*\(/.test(l));
    entries.push({ severity: "action-needed", file, line: idx >= 0 ? idx + 1 : 1, what: "Convex crons (cronJobs)",
      fix: `Compose defineScheduler() in stackbase.config.ts and use cronJobs() from "@stackbase/scheduler"` });
  }
  if (base === "convex.config.ts") {
    entries.push({ severity: "unsupported", file, line: 1, what: "Convex app config (convex.config.ts)",
      fix: `Recompose components via stackbase.config.ts` });
  }

  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      if (rule.test.test(lines[i]!)) {
        entries.push({ severity: rule.severity, file, line: i + 1, what: rule.what, fix: rule.fix });
      }
    }
  }
  return entries;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-scan-divergences.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/migrate/scan-divergences.ts packages/cli/test/migrate-scan-divergences.test.ts
git commit -m "feat(cli): Convex divergence scanner (report .withIndex/.patch/paginate/auth/crons/...)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Convex source `analyze`

**Files:**
- Create: `packages/cli/src/migrate/convex-source.ts`
- Test: `packages/cli/test/migrate-convex-source.test.ts`

**Interfaces:**
- Consumes: `MigrationSource`/`MigrationPlan`/`FileEdit`/`FileWrite` from `./source`; `rewriteImports` (Task 2); `scanDivergences` (Task 3).
- Produces: `export const convexSource: MigrationSource`.

- [ ] **Step 1: Write the failing test**

`packages/cli/test/migrate-convex-source.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexSource } from "../src/migrate/convex-source";

let root: string;
let appDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbmig-"));
  appDir = join(root, "convex");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", dependencies: { convex: "^1.0.0", react: "^18.0.0" } }, null, 2));
  writeFileSync(join(appDir, "schema.ts"), `import { defineSchema, defineTable } from "convex/server";\nimport { v } from "convex/values";\nexport default defineSchema({ notes: defineTable({ body: v.string() }) });\n`);
  writeFileSync(join(appDir, "notes.ts"), `import { query, mutation } from "./_generated/server";\nexport const list = query((ctx) => ctx.db.query("notes").withIndex("by_x", q => q.eq("x", 1)).collect());\n`);
  writeFileSync(join(appDir, "crons.ts"), `import { cronJobs } from "convex/server";\nexport default cronJobs();\n`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("convexSource.analyze", () => {
  it("detects a convex project", async () => {
    expect(await convexSource.detect(root)).toBe(true);
  });

  it("produces import edits, a package.json edit, a report, and a scheduler config scaffold", async () => {
    const plan = await convexSource.analyze(root, appDir);

    // schema.ts import edit: convex/values → @stackbase/values, convex/server(schema) → @stackbase/values
    const schemaEdit = plan.edits.find((e) => e.path.endsWith("schema.ts"));
    expect(schemaEdit?.newContent).toContain(`from "@stackbase/values"`);
    expect(schemaEdit?.newContent).not.toContain("convex/");

    // report flags the .withIndex divergence and the crons
    expect(plan.report.some((r) => r.what.includes("withIndex") && r.severity === "action-needed")).toBe(true);
    expect(plan.report.some((r) => r.what.toLowerCase().includes("cron"))).toBe(true);

    // package.json edit drops convex, adds @stackbase/*
    const pkgEdit = plan.edits.find((e) => e.path.endsWith("package.json"));
    expect(pkgEdit).toBeDefined();
    const pkg = JSON.parse(pkgEdit!.newContent);
    expect(pkg.dependencies.convex).toBeUndefined();
    expect(pkg.dependencies["@stackbase/values"]).toBeDefined();

    // crons.ts present → scaffold a stackbase.config.ts composing defineScheduler
    const config = plan.scaffold.find((f) => f.path.endsWith("stackbase.config.ts"));
    expect(config?.content).toContain("defineScheduler");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-convex-source.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/migrate/convex-source.ts`:
```ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { FileEdit, FileWrite, MigrationPlan, MigrationSource, ReportEntry } from "./source";
import { rewriteImports } from "./rewrite-imports";
import { scanDivergences } from "./scan-divergences";

/** Recursively list *.ts/*.tsx files under `dir`, skipping `_generated` and `node_modules`. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "_generated" || ent.name === "node_modules") continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(ent.name)) out.push(full);
  }
  return out;
}

/** Which @stackbase/* package a rewritten specifier introduces (for the package.json edit). */
const INTRODUCED_PKG: Record<string, string> = {
  "@stackbase/values": "@stackbase/values",
  "@stackbase/client/react": "@stackbase/client",
  "@stackbase/client": "@stackbase/client",
};

export const convexSource: MigrationSource = {
  id: "convex",

  async detect(projectRoot: string): Promise<boolean> {
    if (existsSync(join(projectRoot, "convex", "schema.ts"))) return true;
    const pkgPath = join(projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
      if (pkg.dependencies?.convex) return true;
    }
    return false;
  },

  async analyze(projectRoot: string, appDir: string): Promise<MigrationPlan> {
    const edits: FileEdit[] = [];
    const report: ReportEntry[] = [];
    const scaffold: FileWrite[] = [];
    const introduced = new Set<string>();
    let hasCrons = false;

    for (const file of walk(appDir)) {
      const src = readFileSync(file, "utf8");
      const rel = relative(projectRoot, file);
      const { output, entries } = rewriteImports(src, rel);
      report.push(...entries, ...scanDivergences(src, rel));
      for (const [spec, pkg] of Object.entries(INTRODUCED_PKG)) {
        if (output.includes(`"${spec}"`) && !src.includes(`"${spec}"`)) introduced.add(pkg);
      }
      if (output !== src) edits.push({ path: file, newContent: output });
      if (file.endsWith("crons.ts") || /\bcronJobs\s*\(/.test(src)) hasCrons = true;
    }

    // package.json edit: drop convex deps, add the introduced @stackbase/* packages.
    const pkgPath = join(projectRoot, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      const deps: Record<string, string> = { ...(pkg.dependencies ?? {}) };
      for (const name of Object.keys(deps)) {
        if (name === "convex" || name.startsWith("@convex-dev/")) delete deps[name];
      }
      for (const pkgName of introduced) deps[pkgName] = "latest";
      const next = { ...pkg, dependencies: deps };
      edits.push({ path: pkgPath, newContent: JSON.stringify(next, null, 2) + "\n" });
    }

    // Scaffold a scheduler config only when crons were detected.
    if (hasCrons) {
      scaffold.push({
        path: join(projectRoot, "stackbase.config.ts"),
        content:
          `import { defineConfig } from "@stackbase/component";\n` +
          `import { defineScheduler } from "@stackbase/scheduler";\n\n` +
          `// Convex crons map to Stackbase's scheduler component. Move your cron definitions into\n` +
          `// a convex/crons.ts using cronJobs() from "@stackbase/scheduler".\n` +
          `export default defineConfig({ components: [defineScheduler()] });\n`,
      });
    }

    return { edits, scaffold, report };
  },
};
```

Note: if `defineConfig`'s real shape differs from `{ components: [...] }`, match the real `@stackbase/component` export (check `examples/auth-demo/stackbase.config.ts` — it uses `defineConfig(...)`); adjust the scaffold string to the real signature. The test only asserts the string contains `defineScheduler`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-convex-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/migrate/convex-source.ts packages/cli/test/migrate-convex-source.test.ts
git commit -m "feat(cli): Convex source analyze — compose codemod+scan, package.json + config scaffold

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `migrate` command + report writer + fixture

**Files:**
- Create: `packages/cli/src/migrate.ts`
- Modify: `packages/cli/src/cli.ts` (add `case "migrate"`, import, help text)
- Create: `packages/cli/test/fixtures/convex-app/` (fixture — see Step 1)
- Test: `packages/cli/test/migrate-command.test.ts`

**Interfaces:**
- Consumes: `resolveSource`, `MigrationPlan`, `ReportEntry` from `./migrate/source`; `convexSource` from `./migrate/convex-source`; `loadConvexDir` (`./load-modules`), `loadConfig` (`./load-config`), `push` (`./push-pipeline`), `writeGenerated` (`@stackbase/codegen`).
- Produces: `migrateCommand(args: string[]): Promise<number>`; `renderReport(entries: ReportEntry[]): string`; the `SOURCES` registry.

- [ ] **Step 1: Create the fixture**

Create these files under `packages/cli/test/fixtures/convex-app/`:

`package.json`:
```json
{ "name": "convex-fixture", "dependencies": { "convex": "^1.0.0" } }
```
`convex/schema.ts`:
```ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ notes: defineTable({ body: v.string() }) });
```
`convex/notes.ts`:
```ts
import { query, mutation } from "./_generated/server";
export const add = mutation({ handler: (ctx, args: { body: string }) => ctx.db.insert("notes", { body: args.body }) });
export const list = query({ handler: async (ctx) => (await ctx.db.query("notes", "by_creation").collect()).map((d: { body: string }) => d.body) });
```
`convex/crons.ts`:
```ts
import { cronJobs } from "convex/server";
export default cronJobs();
```

(No `_generated/` in the fixture — `migrate` regenerates it. `notes.ts` uses the Stackbase query form so the migrated app runs; the divergence-flagging patterns are exercised by the unit tests in Tasks 2–4, not required here.)

- [ ] **Step 2: Write the failing test**

`packages/cli/test/migrate-command.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/migrate";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbmig-cmd-"));
  cpSync(join(__dirname, "fixtures", "convex-app"), root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrateCommand", () => {
  it("rewrites imports, regenerates _generated, and writes a report", async () => {
    const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
    expect(code).toBe(0);

    const schema = readFileSync(join(root, "convex", "schema.ts"), "utf8");
    expect(schema).toContain(`from "@stackbase/values"`);
    expect(schema).not.toContain("convex/");

    expect(existsSync(join(root, "convex", "_generated", "server.ts"))).toBe(true);
    const report = readFileSync(join(root, "MIGRATION-REPORT.md"), "utf8");
    expect(report).toMatch(/cron/i);
    expect(existsSync(join(root, "stackbase.config.ts"))).toBe(true);
  });

  it("--dry-run writes only the report, no source edits", async () => {
    const code = await migrateCommand(["--dir", join(root, "convex"), "--dry-run", "--force"]);
    expect(code).toBe(0);
    expect(readFileSync(join(root, "convex", "schema.ts"), "utf8")).toContain("convex/values"); // unchanged
    expect(existsSync(join(root, "MIGRATION-REPORT.md"))).toBe(true);
    expect(existsSync(join(root, "convex", "_generated"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-command.test.ts`
Expected: FAIL — `../src/migrate` does not exist.

- [ ] **Step 4: Write the implementation**

`packages/cli/src/migrate.ts`:
```ts
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { writeGenerated } from "@stackbase/codegen";
import { loadConvexDir } from "./load-modules";
import { loadConfig } from "./load-config";
import { push } from "./push-pipeline";
import { resolveSource, type MigrationSource, type ReportEntry } from "./migrate/source";
import { convexSource } from "./migrate/convex-source";

const SOURCES: Record<string, MigrationSource> = { convex: convexSource };

interface MigrateOptions { from: string; appDir: string; dryRun: boolean; force: boolean; }
function parse(args: string[]): MigrateOptions {
  const out: MigrateOptions = { from: "convex", appDir: "convex", dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--from" && args[i + 1]) out.from = args[++i]!;
    else if (a === "--dir" && args[i + 1]) out.appDir = args[++i]!;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

export function renderReport(entries: ReportEntry[]): string {
  const by = (s: string) => entries.filter((e) => e.severity === s);
  const section = (title: string, items: ReportEntry[]) =>
    items.length === 0 ? "" :
      `\n## ${title} (${items.length})\n\n` +
      items.map((e) => `- \`${e.file}${e.line ? `:${e.line}` : ""}\` — ${e.what}. **Fix:** ${e.fix}`).join("\n") + "\n";
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
  const opts = parse(args);
  const appDir = resolve(opts.appDir);
  const projectRoot = dirname(appDir);

  const dirty = gitDirty(projectRoot);
  if (dirty === true && !opts.force) {
    process.stderr.write(`refusing to migrate: ${projectRoot} has uncommitted changes (commit/stash first, or pass --force)\n`);
    return 1;
  }
  if (dirty === null) process.stderr.write(`warning: ${projectRoot} is not a git repo — changes will be made in place with no easy revert\n`);

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

  const plan = await source.analyze(projectRoot, appDir);

  // Always write the report first (so a later regen failure still leaves it).
  writeFileSync(join(projectRoot, "MIGRATION-REPORT.md"), renderReport(plan.report));

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] ${plan.edits.length} files would change, ${plan.scaffold.length} scaffolded. See MIGRATION-REPORT.md\n`);
    return 0;
  }

  for (const edit of plan.edits) writeFileSync(edit.path, edit.newContent);
  for (const file of plan.scaffold) if (!existsSync(file.path)) writeFileSync(file.path, file.content);

  // Regenerate _generated/ via the standard pipeline.
  try {
    const loaded = await loadConvexDir(appDir);
    const config = await loadConfig(projectRoot);
    const { generated } = push(loaded, config.components);
    writeGenerated(generated.files, join(appDir, "_generated"));
  } catch (e) {
    process.stderr.write(`imports migrated, but codegen failed: ${String(e)}\nSee MIGRATION-REPORT.md; fix the flagged items, then run \`stackbase codegen\`.\n`);
    return 1;
  }

  const n = plan.report.filter((r) => r.severity !== "auto-fixed").length;
  process.stdout.write(`migrated ${plan.edits.length} files. ${n} item(s) need manual attention — see MIGRATION-REPORT.md\n`);
  return 0;
}
```

Then wire into `packages/cli/src/cli.ts`:
1. Add import near the other command imports (after line 18 `import { buildCommand } from "./build";`):
   ```ts
   import { migrateCommand } from "./migrate";
   ```
2. Add the case in `runCli`'s switch (after the `build` case):
   ```ts
   case "migrate":
     return migrateCommand(rest);
   ```
3. Add to the help `Commands:` block (after the `build` line):
   ```
   "  migrate    Migrate a Convex project into Stackbase (imports + report)",
   ```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-command.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck the package**

Run: `cd /Volumes/Projects/concave-dev && bun run typecheck --filter @stackbase/cli`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/src/migrate.ts packages/cli/src/cli.ts packages/cli/test/fixtures packages/cli/test/migrate-command.test.ts
git commit -m "feat(cli): \`stackbase migrate\` command — apply plan, regen _generated, report

Dirty-tree guard, --dry-run/--force, report-first ordering, wired into runCli.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: E2E — migrated app loads and runs

**Files:**
- Create: `packages/cli/test/migrate-e2e.test.ts`

**Interfaces:**
- Consumes: `migrateCommand` (Task 5); `loadConvexDir` (`../src/load-modules`), `loadProject` (`../src/project` or `../src/index`), `createEmbeddedRuntime` (`@stackbase/runtime-embedded`). Check `packages/cli/test/validation-e2e.test.ts` for the exact `loadProject`+`createEmbeddedRuntime` usage and import paths.

- [ ] **Step 1: Rebuild dependency packages**

Run: `cd /Volumes/Projects/concave-dev && bun run build --filter @stackbase/codegen --filter @stackbase/runtime-embedded`
Expected: build success (the E2E resolves these via `dist`).

- [ ] **Step 2: Write the test**

`packages/cli/test/migrate-e2e.test.ts`:
```ts
/**
 * E2E: a migrated Convex fixture is a VALID Stackbase app — it loads via loadProject and a
 * migrated mutation runs on the embedded engine. Proves the migration output is real, not just
 * a text rewrite. ("Test through the shipped entrypoint.")
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime } from "@stackbase/runtime-embedded";
import { migrateCommand } from "../src/migrate";
import { loadConvexDir } from "../src/load-modules";
import { loadProject } from "../src/project";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbmig-e2e-"));
  cpSync(join(__dirname, "fixtures", "convex-app"), root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrate E2E", () => {
  it("migrated fixture loads and a migrated mutation runs on the engine", async () => {
    expect(await migrateCommand(["--dir", join(root, "convex"), "--force"])).toBe(0);

    const loaded = await loadConvexDir(join(root, "convex"));
    const project = loadProject(loaded);
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });

    const res = await runtime.run<string>("notes:add", { body: "hello" });
    expect(typeof res.value).toBe("string"); // the migrated mutation committed and returned an id
  });
});
```

If `runtime.run`'s signature or `loadProject`'s argument shape differs from the above, mirror exactly what `validation-e2e.test.ts` does (it constructs the same runtime and calls the same APIs).

- [ ] **Step 3: Run test to verify it passes**

Run: `cd packages/cli && ../../node_modules/.bin/vitest run test/migrate-e2e.test.ts`
Expected: PASS — the migrated fixture loads and `notes:add` returns an id string.

- [ ] **Step 4: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add packages/cli/test/migrate-e2e.test.ts
git commit -m "test(cli): E2E — migrated Convex fixture loads + runs on the engine

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: End-user docs sweep

**Files:**
- Modify: `docs/enduser/quickstart.md`, `docs/enduser/files.md`, `docs/enduser/build/schema.md`, `docs/enduser/build/backend-functions.md`, `docs/enduser/build/testing.md`, `docs/enduser/build/auth.md`, `docs/enduser/deploy/electron.md`, `docs/enduser/deploy/electrobun.md`, `docs/enduser/deploy/tauri.md`, `docs/enduser/index.md`, `docs/enduser/reference/compatibility.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Find every convex/* import reference**

Run:
```bash
cd /Volumes/Projects/concave-dev
grep -rnE "convex/(values|react|browser|server)" docs/enduser
```
Record the list.

- [ ] **Step 2: Rewrite the import specifiers**

Apply the same mappings as the codemod to each occurrence:
- `from "convex/values"` → `from "@stackbase/values"`
- `from "convex/react"` → `from "@stackbase/client/react"` (e.g. `ConvexProvider`/`ConvexReactClient` prose stays illustrative — update the import line; if the doc shows Stackbase client usage, prefer `StackbaseProvider`/`StackbaseClient` from `@stackbase/client/react`, matching `packages/client/src/react.tsx`)
- `from "convex/browser"` → `from "@stackbase/client"`
- `from "convex/server"` importing `defineSchema`/`defineTable` → `from "@stackbase/values"`; importing `httpRouter`/`httpAction` → `from "./_generated/server"`

Do these edits file by file. For `deploy/*.md` React snippets, update the import path; keep the surrounding prose coherent.

- [ ] **Step 3: Reframe the positioning prose**

In `docs/enduser/index.md`: change the line that says the Convex compatibility surface (`convex/server`, `convex/values`, …) is "intentionally preserved … that compatibility is the whole point" to state that **Stackbase uses native `@stackbase/*` imports**, and that an existing Convex app is brought over with **`stackbase migrate`**. Keep the `convex/` *directory* reference (the folder name is unchanged).

In `docs/enduser/reference/compatibility.md`: change "Same client libraries - use `convex/react`, `convex/browser`" and "function definitions … from `convex/server`" to describe the `@stackbase/*` equivalents and point to `stackbase migrate` for bringing a Convex app across. Keep the "drop-in for most Convex apps" spirit but via migration, not identical import paths.

- [ ] **Step 4: Verify no stale import specifiers remain**

Run:
```bash
cd /Volumes/Projects/concave-dev
grep -rnE "from \"convex/(values|react|browser|server)\"" docs/enduser && echo "STALE REMAIN" || echo "clean"
```
Expected: `clean` (no matching import lines). Prose mentions of the word "convex" (the directory, "migrate from Convex") are fine.

- [ ] **Step 5: Full monorepo gate**

Run: `cd /Volumes/Projects/concave-dev && bun run build && bun run typecheck && bun run test`
Expected: all green (docs changes don't affect code; this confirms nothing else regressed across Tasks 1–7).

- [ ] **Step 6: Commit**

```bash
cd /Volumes/Projects/concave-dev
git add docs/enduser
git commit -m "docs(enduser): sweep convex/* imports to @stackbase/*, reframe Convex as migration

Per the locked product-identity decision — native @stackbase/* is canonical; a Convex
app is brought over with \`stackbase migrate\`.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- Command + seam (spec §Command shell, §Source seam) → Tasks 1, 5. ✅
- Convex source: import codemod (symbol-aware) → Task 2; divergence scan → Task 3; analyze composing them + package.json + config scaffold → Task 4. ✅
- Command flow: dirty-tree guard, `--dry-run`/`--force`, report-first, `_generated` regen, summary → Task 5. ✅
- Migration report (`MIGRATION-REPORT.md`) → Task 5 (`renderReport`). ✅
- E2E (migrated app loads + runs) → Task 6. ✅
- Docs sweep → Task 7. ✅
- Non-goals (Supabase/Firebase, AST body-transforms, data ETL) → not implemented; seam-only + report-only held in Global Constraints. ✅

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code step has real code. The "if the real signature differs, mirror validation-e2e.test.ts / match defineConfig" notes (Tasks 4, 6) are precision hedges around exact existing-API shapes the implementer must read, not missing logic. ✅

**3. Type consistency:** `MigrationSource`/`MigrationPlan`/`ReportEntry`/`FileEdit`/`FileWrite` defined in Task 1 are consumed with the same names/shapes in Tasks 2 (`ReportEntry`), 3 (`ReportEntry`/`ReportSeverity`), 4 (all), 5 (`ReportEntry`, `resolveSource`, `MigrationSource`). `rewriteImports(source, file) → { output, entries }` (Task 2) is called with that exact shape in Task 4. `scanDivergences(source, file) → ReportEntry[]` (Task 3) likewise. `convexSource` (Task 4) is registered in `SOURCES` (Task 5). Severity strings `"auto-fixed"`/`"action-needed"`/`"unsupported"` are consistent across Tasks 1–5. ✅
