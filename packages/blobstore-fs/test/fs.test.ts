import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
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

  it("store() accepts a ReadableStream<Uint8Array> and round-trips bytes/size/sha256", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob3-")) });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const result = await store.store("k", readable);

    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(result.size).toBe(bytes.byteLength);
    expect(result.sha256).toBe(expectedSha256);

    const readBack = await store.read("k");
    expect(readBack).not.toBeNull();
    const chunks: Uint8Array[] = [];
    for await (const chunk of readBack as any) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c)))).toEqual(Buffer.from(bytes));
  });

  it("store() cleans up the partial file when the source stream errors mid-stream", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob4-")) });
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.error(new Error("boom"));
      },
    });

    await expect(store.store("k", readable)).rejects.toThrow("boom");
    expect(await store.read("k")).toBeNull();
  });
});
