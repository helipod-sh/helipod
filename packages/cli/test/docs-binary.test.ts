/**
 * Guard: the standalone-binary end-user doc must match what `stackbase build` actually ships
 * (Tasks 1-6 of the single-binary slice) — not a `stackbase build`/`bunx stackbase init` fantasy
 * that references packages that don't exist in this monorepo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("standalone-binary docs match reality", () => {
  // The single-binary content lives in the deploy-and-build page of the fumadocs site.
  const doc = readFileSync(
    join(import.meta.dirname, "../../../docs/content/docs/deploy/deploy-and-build.mdx"),
    "utf8",
  );

  it("does not reference non-existent packages", () => {
    for (const phantom of [
      "@stackbase/runtime-bun",
      "@stackbase/core",
      "@stackbase/docstore-bun-sqlite",
      "@stackbase/blobstore-bun-fs",
    ]) {
      expect(doc).not.toContain(phantom);
    }
  });

  it("documents the real command surface", () => {
    expect(doc).toContain("stackbase build");
    expect(doc).toContain("--outfile");
    expect(doc).toContain("--target");
    expect(doc).toContain('"ready":true'); // machine-readable startup line
    expect(doc).toContain("STACKBASE_ADMIN_KEY");
  });
});
