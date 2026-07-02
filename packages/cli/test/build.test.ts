import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { resolveBuildOptions, bunTargetFor } from "../src/build";
import { listFunctionModuleFiles, moduleKeyForFile } from "../src/load-modules";
import { DEFAULT_FUNCTIONS_DIR } from "../src/functions-dir";

describe("resolveBuildOptions", () => {
  it("defaults and flags", async () => {
    // No `--dir` and no `stackbase.config.ts` at cwd → DEFAULT_FUNCTIONS_DIR, resolved absolute.
    expect(await resolveBuildOptions([])).toEqual({
      functionsDir: resolve(process.cwd(), DEFAULT_FUNCTIONS_DIR),
      outfile: "./stackbase-server",
      target: null,
      dashboard: true,
      verbose: false,
    });
    // An explicit --dir wins outright and is resolved to an absolute path (never left relative).
    expect(await resolveBuildOptions(["--dir", "cvx", "--outfile", "./out/bin", "--target", "linux-x64", "--no-dashboard", "--verbose"]))
      .toEqual({ functionsDir: resolve(process.cwd(), "cvx"), outfile: "./out/bin", target: "linux-x64", dashboard: false, verbose: true });
  });
});

describe("bunTargetFor", () => {
  it("maps friendly names to bun triples and rejects unknown", () => {
    expect(bunTargetFor("linux-x64")).toBe("bun-linux-x64");
    expect(bunTargetFor("darwin-arm64")).toBe("bun-darwin-arm64");
    expect(bunTargetFor("windows-x64")).toBe("bun-windows-x64");
    expect(() => bunTargetFor("plan9-x64")).toThrow(/unknown target/i);
  });
});

describe("shared module-file helpers", () => {
  it("lists function modules (excludes schema/_generated/.d.ts) and derives keys", () => {
    const files = listFunctionModuleFiles("test/fixtures/deploy-v2/stackbase");
    expect(files).toContain("notes.ts");
    expect(files).not.toContain("schema.ts");
    expect(moduleKeyForFile("notes.ts")).toBe("notes");
    expect(moduleKeyForFile("notes.js")).toBe("notes");
  });
});
