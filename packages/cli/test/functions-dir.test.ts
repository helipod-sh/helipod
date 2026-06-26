import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFunctionsDir, functionsDirNotFoundMessage, DEFAULT_FUNCTIONS_DIR } from "../src/functions-dir";

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
