import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFunctionsDir, functionsDirNotFoundMessage, ensureFunctionsDirExists, DEFAULT_FUNCTIONS_DIR } from "../src/functions-dir";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sb-fnsdir-"));
}

describe("resolveFunctionsDir", () => {
  it("defaults to helipod/ with no flag and no config", async () => {
    const root = scratch();
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "helipod"));
    expect(r.projectRoot).toBe(root);
  });

  it("uses functionsDir from helipod.config.ts when present", async () => {
    const root = scratch();
    writeFileSync(join(root, "helipod.config.js"), `export default { components: [], functionsDir: "convex" };`);
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "convex"));
    expect(r.projectRoot).toBe(root);
  });

  it("lets the --dir flag win over config", async () => {
    const root = scratch();
    writeFileSync(join(root, "helipod.config.js"), `export default { components: [], functionsDir: "convex" };`);
    const r = await resolveFunctionsDir(join(root, "backend"), root);
    expect(r.functionsDir).toBe(join(root, "backend"));
  });

  it("derives the project root from an explicit --dir outside the cwd", async () => {
    const root = scratch();
    const nested = join(root, "app");
    mkdirSync(nested);
    const r = await resolveFunctionsDir(join(nested, "helipod"), root);
    expect(r.functionsDir).toBe(join(nested, "helipod"));
    expect(r.projectRoot).toBe(nested);
  });

  it("never falls back to convex/ implicitly", async () => {
    const root = scratch();
    mkdirSync(join(root, "convex"));
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "helipod"));
  });

  it("exports the default name as a constant", () => {
    expect(DEFAULT_FUNCTIONS_DIR).toBe("helipod");
  });
});

describe("functionsDirNotFoundMessage", () => {
  it("names the missing directory and points at migrate", () => {
    const msg = functionsDirNotFoundMessage("/tmp/app/helipod");
    expect(msg).toContain("/tmp/app/helipod");
    expect(msg).toContain("helipod migrate");
    expect(msg).toContain("--dir");
  });
});

describe("ensureFunctionsDirExists", () => {
  it("returns true and writes nothing when the directory exists", () => {
    const root = scratch();
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => { chunks.push(String(chunk)); return true; };
    let ok: boolean;
    try {
      ok = ensureFunctionsDirExists(root);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    expect(ok).toBe(true);
    expect(chunks.join("")).toBe("");
  });

  it("returns false and writes the friendly message when the directory is missing", () => {
    const missing = join(scratch(), "nope");
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = (chunk: string): boolean => { chunks.push(String(chunk)); return true; };
    let ok: boolean;
    try {
      ok = ensureFunctionsDirExists(missing);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = original;
    }
    expect(ok).toBe(false);
    const all = chunks.join("");
    expect(all).toContain(missing);
    expect(all).toContain("helipod migrate");
  });
});

describe("regression guard", () => {
  it("the default functions directory is helipod, not convex", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-guard-"));
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir.endsWith("convex")).toBe(false);
    expect(r.functionsDir).toBe(join(root, "helipod"));
  });
});
