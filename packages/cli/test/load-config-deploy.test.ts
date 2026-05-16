import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/load-config";

describe("loadConfig deploy passthrough", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it("returns the deploy block, not just components", async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-cfg-"));
    writeFileSync(
      join(dir, "stackbase.config.js"),
      `export default { components: [], deploy: { defaultTarget: "docker", targets: { docker: { provider: "docker" } } } };`,
    );
    const cfg = await loadConfig(dir);
    expect(cfg.components).toEqual([]);
    expect(cfg.deploy?.defaultTarget).toBe("docker");
  });
});
