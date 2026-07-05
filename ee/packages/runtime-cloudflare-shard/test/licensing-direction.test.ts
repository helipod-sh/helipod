/* Helipod Enterprise. Licensed under the Helipod Commercial License — see ee/LICENSE. */

/**
 * Licensing-direction gate (locked decision, coordinator clarification). The dependency edge is
 * ONE-WAY: this paid (ee/) package depends on the FREE `@helipod/runtime-cloudflare` and reuses its
 * DO class — but NOTHING under the free package may statically import THIS package back. If a
 * single-shard free deploy had to link ee code, "free single-node forever" would break. The switch is
 * the app's Worker entry (which handler it default-exports), never a runtime gate.
 *
 * This scans the free package's source for any reference to this package's name.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../../../..");
const freePkgSrc = join(repoRoot, "packages", "runtime-cloudflare", "src");

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "coverage"]);
function scanTs(root: string, visit: (file: string, text: string) => void): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) scanTs(full, visit);
    } else if (e.isFile() && e.name.endsWith(".ts")) {
      visit(full, readFileSync(full, "utf8"));
    }
  }
}

describe("licensing direction — free never imports the paid shard package", () => {
  it("packages/runtime-cloudflare/src references no @helipod/runtime-cloudflare-shard", () => {
    const offenders: string[] = [];
    scanTs(freePkgSrc, (file, text) => {
      if (text.includes("@helipod/runtime-cloudflare-shard")) offenders.push(file);
    });
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the free host package.json does not depend on the shard package", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "packages", "runtime-cloudflare", "package.json"), "utf8"));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
    expect(Object.keys(allDeps)).not.toContain("@helipod/runtime-cloudflare-shard");
  });

  it("this package does NOT depend on @helipod/fleet (a sibling, not a consumer)", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(allDeps)).not.toContain("@helipod/fleet");
  });
});
