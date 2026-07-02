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
          `// a stackbase/crons.ts using cronJobs() from "@stackbase/scheduler".\n` +
          `export default defineConfig({ components: [defineScheduler()] });\n`,
      });
    }

    return { edits, scaffold, report };
  },
};
