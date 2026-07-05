/**
 * Guard: the file-storage end-user doc must reference the REAL blobstore packages
 * (`@helipod/blobstore-fs`/`@helipod/blobstore-s3`), not the retired phantom names from the
 * original aspirational Cloudflare-era docs (`@helipod/blobstore-bun-fs`/`-bun-s3`/`-cf-r2`).
 * Same pattern as `docs-postgres.test.ts`/`docs-binary.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("file-storage docs match reality", () => {
  const doc = readFileSync(
    join(import.meta.dirname, "../../../website/content/docs/core-concepts/file-storage.mdx"),
    "utf8",
  );

  it("does not reference retired phantom package names", () => {
    for (const phantom of [
      "@helipod/blobstore-bun-fs",
      "@helipod/blobstore-bun-s3",
      "@helipod/blobstore-cf-r2",
    ]) {
      expect(doc).not.toContain(phantom);
    }
  });

  it("references the real blobstore packages via the CLI flags/env it documents", () => {
    // The doc documents backend selection via flags/env rather than raw imports (the packages
    // are selected for you by `makeBlobStore`), so assert the real surface it does name.
    expect(doc).toContain("--storage-bucket");
    expect(doc).toContain("HELIPOD_STORAGE_BUCKET");
  });

  it("names the real packages explicitly", () => {
    expect(doc).toContain("@helipod/blobstore-fs");
    expect(doc).toContain("@helipod/blobstore-s3");
  });
});
