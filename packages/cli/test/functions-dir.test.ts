import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFunctionsDir, functionsDirNotFoundMessage, ensureFunctionsDirExists, DEFAULT_FUNCTIONS_DIR } from "../src/functions-dir";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "sb-fnsdir-"));
}

describe("resolveFunctionsDir", () => {
  it("defaults to stackbase/ with no flag and no config", async () => {
    const root = scratch();
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "stackbase"));
    expect(r.projectRoot).toBe(root);
  });

  it("uses functionsDir from stackbase.config.ts when present", async () => {
    const root = scratch();
    writeFileSync(join(root, "stackbase.config.js"), `export default { components: [], functionsDir: "convex" };`);
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "convex"));
    expect(r.projectRoot).toBe(root);
  });

  it("lets the --dir flag win over config", async () => {
    const root = scratch();
    writeFileSync(join(root, "stackbase.config.js"), `export default { components: [], functionsDir: "convex" };`);
    const r = await resolveFunctionsDir(join(root, "backend"), root);
    expect(r.functionsDir).toBe(join(root, "backend"));
  });

  it("derives the project root from an explicit --dir outside the cwd", async () => {
    const root = scratch();
    const nested = join(root, "app");
    mkdirSync(nested);
    const r = await resolveFunctionsDir(join(nested, "stackbase"), root);
    expect(r.functionsDir).toBe(join(nested, "stackbase"));
    expect(r.projectRoot).toBe(nested);
  });

  it("never falls back to convex/ implicitly", async () => {
    const root = scratch();
    mkdirSync(join(root, "convex"));
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir).toBe(join(root, "stackbase"));
  });

  it("exports the default name as a constant", () => {
    expect(DEFAULT_FUNCTIONS_DIR).toBe("stackbase");
  });
});

describe("functionsDirNotFoundMessage", () => {
  it("names the missing directory and points at migrate", () => {
    const msg = functionsDirNotFoundMessage("/tmp/app/stackbase");
    expect(msg).toContain("/tmp/app/stackbase");
    expect(msg).toContain("stackbase migrate");
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
    expect(all).toContain("stackbase migrate");
  });
});

describe("regression guard", () => {
  it("the default functions directory is stackbase, not convex", async () => {
    const root = mkdtempSync(join(tmpdir(), "sb-guard-"));
    const r = await resolveFunctionsDir(undefined, root);
    expect(r.functionsDir.endsWith("convex")).toBe(false);
    expect(r.functionsDir).toBe(join(root, "stackbase"));
  });
});
