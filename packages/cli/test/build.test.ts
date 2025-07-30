import { describe, it, expect } from "vitest";
import { resolveBuildOptions, bunTargetFor } from "../src/build";
import { listConvexModuleFiles, moduleKeyForFile } from "../src/load-modules";

describe("resolveBuildOptions", () => {
  it("defaults and flags", () => {
    expect(resolveBuildOptions([])).toEqual({ convexDir: "convex", outfile: "./stackbase-server", target: null, dashboard: true, verbose: false });
    expect(resolveBuildOptions(["--dir", "cvx", "--outfile", "./out/bin", "--target", "linux-x64", "--no-dashboard", "--verbose"]))
      .toEqual({ convexDir: "cvx", outfile: "./out/bin", target: "linux-x64", dashboard: false, verbose: true });
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
    const files = listConvexModuleFiles("test/fixtures/deploy-v2/convex");
    expect(files).toContain("notes.ts");
    expect(files).not.toContain("schema.ts");
    expect(moduleKeyForFile("notes.ts")).toBe("notes");
    expect(moduleKeyForFile("notes.js")).toBe("notes");
  });
});
