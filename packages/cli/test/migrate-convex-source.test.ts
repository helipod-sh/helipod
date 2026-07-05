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

    // schema.ts import edit: convex/values → @helipod/values, convex/server(schema) → @helipod/values
    const schemaEdit = plan.edits.find((e) => e.path.endsWith("schema.ts"));
    expect(schemaEdit?.newContent).toContain(`from "@helipod/values"`);
    expect(schemaEdit?.newContent).not.toContain("convex/");

    // report flags the .withIndex divergence and the crons
    expect(plan.report.some((r) => r.what.includes("withIndex") && r.severity === "action-needed")).toBe(true);
    expect(plan.report.some((r) => r.what.toLowerCase().includes("cron"))).toBe(true);

    // package.json edit drops convex, adds @helipod/*
    const pkgEdit = plan.edits.find((e) => e.path.endsWith("package.json"));
    expect(pkgEdit).toBeDefined();
    const pkg = JSON.parse(pkgEdit!.newContent);
    expect(pkg.dependencies.convex).toBeUndefined();
    expect(pkg.dependencies["@helipod/values"]).toBeDefined();

    // crons.ts present → scaffold a helipod.config.ts composing defineScheduler
    const config = plan.scaffold.find((f) => f.path.endsWith("helipod.config.ts"));
    expect(config?.content).toContain("defineScheduler");
  });
});
