import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/load-config";

/** Resolve a package from the CLI's own node_modules (already linked by the workspace install). */
function cliNodeModules(): string {
  return resolve(new URL(".", import.meta.url).pathname, "../../node_modules");
}

/** Create a temp dir with a node_modules symlink so fixture TS can import workspace packages. */
function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sbcfg-"));
  const nm = join(dir, "node_modules");
  mkdirSync(nm);
  // Symlink each required @stackbase scoped dir entry from cli's local node_modules
  symlinkSync(join(cliNodeModules(), "@stackbase"), join(nm, "@stackbase"));
  return dir;
}

describe("loadConfig", () => {
  it("returns an empty component list when no config exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sbcfg-"));
    expect((await loadConfig(dir)).components).toEqual([]);
  });
  it("loads components from stackbase.config.ts", async () => {
    const dir = makeTmpDir();
    // a self-contained config that defines an inline component (avoids needing a built dep)
    writeFileSync(join(dir, "stackbase.config.ts"), `
      import { defineConfig, defineComponent } from "@stackbase/component";
      import { defineSchema } from "@stackbase/values";
      export default defineConfig({ components: [defineComponent({ name: "demo", schema: defineSchema({}), modules: {} })] });
    `);
    const cfg = await loadConfig(dir);
    expect(cfg.components.map((c) => c.name)).toEqual(["demo"]);
  });
});
