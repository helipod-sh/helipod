import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateCommand } from "../src/migrate";

// The migrated fixture scaffolds a real `stackbase.config.ts` that composes
// `defineScheduler()` from the real `@stackbase/scheduler` package (which itself depends on
// `cron-parser`), and its un-migrated `crons.ts` keeps referencing the (real, external) `convex`
// package. Since the test project lives in a temp dir outside the workspace, it has no
// `node_modules` of its own to resolve any of those bare specifiers from — wire them in: the
// `convex` stub is copied from `fixtures/convex-stub-modules` (kept out of `fixtures/convex-app`
// itself, and out of a real `node_modules/` path, so it isn't swept up by the repo's blanket
// `node_modules/` .gitignore rule), and `@stackbase/*`/`cron-parser` are symlinked from the CLI
// package's own install — the same pattern `load-config.test.ts`'s `makeTmpDir` uses for
// `@stackbase/*`, extended here since this fixture loads the REAL scheduler component (not an
// inline stand-in).
function cliNodeModules(): string {
  return resolve(__dirname, "..", "node_modules");
}
function monorepoRoot(): string {
  return resolve(__dirname, "..", "..", "..");
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sbmig-cmd-"));
  cpSync(join(__dirname, "fixtures", "convex-app"), root, { recursive: true });
  const nm = join(root, "node_modules");
  mkdirSync(nm, { recursive: true });
  cpSync(join(__dirname, "fixtures", "convex-stub-modules", "convex"), join(nm, "convex"), { recursive: true });
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
  symlinkSync(join(monorepoRoot(), "components", "scheduler", "node_modules", "cron-parser"), join(nm, "cron-parser"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("migrateCommand", () => {
  it("rewrites imports, regenerates _generated, and writes a report", async () => {
    const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
    expect(code).toBe(0);

    const schema = readFileSync(join(root, "stackbase", "schema.ts"), "utf8");
    expect(schema).toContain(`from "@stackbase/values"`);
    expect(schema).not.toContain("convex/");

    expect(existsSync(join(root, "stackbase", "_generated", "server.ts"))).toBe(true);
    expect(existsSync(join(root, "convex"))).toBe(false);
    const report = readFileSync(join(root, "MIGRATION-REPORT.md"), "utf8");
    expect(report).toMatch(/cron/i);
    expect(report).toMatch(/renamed/i);
    expect(existsSync(join(root, "stackbase.config.ts"))).toBe(true);
  });

  it("--dry-run leaves the working tree untouched and writes no content edits", async () => {
    // --dry-run must not move the directory (it previously did, which meant a bare re-run without
    // --dry-run would fail with "stackbase already exists" — see migrate.ts). It still writes
    // MIGRATION-REPORT.md as a preview, and guarantees no FILE CONTENT is rewritten and no codegen
    // runs.
    const code = await migrateCommand(["--dir", join(root, "convex"), "--dry-run", "--force"]);
    expect(code).toBe(0);
    expect(existsSync(join(root, "convex"))).toBe(true);
    expect(existsSync(join(root, "stackbase"))).toBe(false);
    expect(readFileSync(join(root, "convex", "schema.ts"), "utf8")).toContain("convex/values"); // unchanged
    expect(existsSync(join(root, "MIGRATION-REPORT.md"))).toBe(true);
    const report = readFileSync(join(root, "MIGRATION-REPORT.md"), "utf8");
    expect(report).toMatch(/would be renamed/i);
  });

  it("deletes a pre-existing Convex _generated/ before regenerating, so stale .js files don't survive", async () => {
    // A real Convex app ships _generated/{server.js,server.d.ts,api.js,api.d.ts,dataModel.d.ts}.
    // The pre-write guard only checks for server.ts (Stackbase's own extension), so these stale
    // Convex artifacts previously survived a migrate untouched and could shadow the regenerated
    // Stackbase files (a JS-first resolver picks the stale server.js, which imports the
    // now-uninstalled "convex/server"). Written under convex/ (the pre-rename location) since
    // migrateCommand moves the whole tree, stale _generated/ included, before regenerating it.
    const preMigrateGeneratedDir = join(root, "convex", "_generated");
    mkdirSync(preMigrateGeneratedDir, { recursive: true });
    writeFileSync(join(preMigrateGeneratedDir, "server.js"), `export const query = 1;\nimport "convex/server";\n`);
    writeFileSync(join(preMigrateGeneratedDir, "server.d.ts"), `export declare const query: 1;\n`);
    writeFileSync(join(preMigrateGeneratedDir, "api.js"), `export const api = {};\n`);

    const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
    expect(code).toBe(0);

    const generatedDir = join(root, "stackbase", "_generated");
    expect(existsSync(join(generatedDir, "server.js"))).toBe(false);
    expect(existsSync(join(generatedDir, "api.js"))).toBe(false);
    expect(existsSync(join(generatedDir, "server.ts"))).toBe(true);
  });
});
