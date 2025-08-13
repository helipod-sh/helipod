/**
 * Guard: the file-storage end-user doc must reference the REAL blobstore packages
 * (`@stackbase/blobstore-fs`/`@stackbase/blobstore-s3`) — not the retired phantom names from the
 * original aspirational Cloudflare-era docs (`@stackbase/blobstore-bun-fs`/`-bun-s3`/`-cf-r2`,
 * still referenced by some untouched older docs pages, e.g. `configure/configuration.md` and
 * `build/data-search.md` — those predate this slice and are a separate, pre-existing cleanup, not
 * this guard's job). Same pattern as `docs-postgres.test.ts`/`docs-binary.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("file-storage docs match reality", () => {
  const doc = readFileSync(join(import.meta.dirname, "../../../docs/enduser/files.md"), "utf8");

  it("does not reference retired phantom package names", () => {
    for (const phantom of [
      "@stackbase/blobstore-bun-fs",
      "@stackbase/blobstore-bun-s3",
      "@stackbase/blobstore-cf-r2",
    ]) {
      expect(doc).not.toContain(phantom);
    }
  });

  it("references the real blobstore packages via the CLI flags/env it documents", () => {
    // The doc documents backend selection via flags/env rather than raw imports (the packages
    // are selected for you by `makeBlobStore`), so assert the real surface it does name.
    expect(doc).toContain("--storage-bucket");
    expect(doc).toContain("STACKBASE_STORAGE_BUCKET");
  });

  it("names the real packages explicitly", () => {
    expect(doc).toContain("@stackbase/blobstore-fs");
    expect(doc).toContain("@stackbase/blobstore-s3");
  });
});
