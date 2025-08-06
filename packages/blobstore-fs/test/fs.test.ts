import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runBlobStoreConformance } from "@stackbase/blobstore/test-support/conformance";
import { FsBlobStore } from "../src/fs-blobstore";

const dir = mkdtempSync(join(tmpdir(), "sb-fs-blob-"));
runBlobStoreConformance(
  "fs",
  () => new FsBlobStore({ root: dir }),
  () => rmSync(dir, { recursive: true, force: true }),
);

describe("FsBlobStore specifics", () => {
  it("createUploadTarget is always proxied; signGetUrl/publicUrl are null", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob2-")) });
    const t = await store.createUploadTarget("k", { expiresInMs: 1000, now: 1 });
    expect(t.kind).toBe("proxied");
    expect(await store.signGetUrl("k", { expiresInMs: 1000, now: 1 })).toBeNull();
    expect(store.publicUrl("k")).toBeNull();
  });
});
