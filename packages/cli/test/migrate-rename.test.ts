import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCommand } from "../src/migrate";

function convexApp(): string {
  const root = mkdtempSync(join(tmpdir(), "sb-migrate-"));
  mkdirSync(join(root, "convex"));
  writeFileSync(
    join(root, "convex", "schema.ts"),
    `import { defineSchema, defineTable, v } from "convex/values";\n` +
      `export default defineSchema({ notes: defineTable({ body: v.string() }) });\n`,
  );
  writeFileSync(
    join(root, "convex", "notes.ts"),
    `import { query } from "./_generated/server";\n` +
      `export const list = query({ handler: async (ctx) => ctx.db.query("notes", "by_creation").collect() });\n`,
  );
  return root;
}

describe("stackbase migrate renames the functions directory", () => {
  it("moves convex/ to stackbase/ and leaves no convex/ behind", async () => {
    const root = convexApp();
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }
    expect(existsSync(join(root, "stackbase", "schema.ts"))).toBe(true);
    expect(existsSync(join(root, "stackbase", "notes.ts"))).toBe(true);
    expect(existsSync(join(root, "convex"))).toBe(false);
  });

  it("refuses when a stackbase/ directory already exists", async () => {
    const root = convexApp();
    mkdirSync(join(root, "stackbase"));
    const errors: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (c: string): boolean => { errors.push(String(c)); return true; };
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
      expect(code).toBe(1);
    } finally {
      process.chdir(prevCwd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    expect(errors.join("")).toContain("already exists");
    expect(existsSync(join(root, "convex", "schema.ts"))).toBe(true);
  });

  it("renames to the project's configured functionsDir instead of the default", async () => {
    const root = convexApp();
    writeFileSync(
      join(root, "stackbase.config.ts"),
      `export default { components: [], functionsDir: "backend" };\n`,
    );
    const prevCwd = process.cwd();
    try {
      process.chdir(root);
      const code = await migrateCommand(["--dir", join(root, "convex"), "--force"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prevCwd);
    }
    expect(existsSync(join(root, "backend", "schema.ts"))).toBe(true);
    expect(existsSync(join(root, "convex"))).toBe(false);
    expect(existsSync(join(root, "stackbase"))).toBe(false);
  });
});
