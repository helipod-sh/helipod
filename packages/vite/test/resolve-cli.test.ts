import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCli, buildDevArgs } from "../src/resolve-cli";

describe("resolveCli", () => {
  const dirs: string[] = [];
  afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs.length = 0; });

  it("splits an explicit override into command + baseArgs", () => {
    expect(resolveCli("/x", "bun run stackbase")).toEqual({ command: "bun", baseArgs: ["run", "stackbase"] });
    expect(resolveCli("/x", "stackbase")).toEqual({ command: "stackbase", baseArgs: [] });
  });

  it("uses node_modules/.bin/stackbase when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-")); dirs.push(dir);
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "stackbase"), "#!/bin/sh\n");
    expect(resolveCli(dir)).toEqual({ command: join(dir, "node_modules", ".bin", "stackbase"), baseArgs: [] });
  });

  it("falls back to `npx stackbase` when there is no local bin", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-cli-")); dirs.push(dir);
    expect(resolveCli(dir)).toEqual({ command: "npx", baseArgs: ["stackbase"] });
  });
});

describe("buildDevArgs", () => {
  it("assembles the dev argv with port, dir, and forwarded extras", () => {
    expect(buildDevArgs([], 3210, "convex", [])).toEqual(["dev", "--port", "3210", "--dir", "convex"]);
    expect(buildDevArgs(["stackbase"], 4000, "backend", ["--database-url", "pg://x"])).toEqual([
      "stackbase", "dev", "--port", "4000", "--dir", "backend", "--database-url", "pg://x",
    ]);
  });
});
