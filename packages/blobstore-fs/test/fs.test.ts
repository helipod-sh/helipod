import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runBlobStoreConformance } from "@helipod/blobstore/test-support/conformance";
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

  it("rejects a path-traversal key (../) rather than escaping root", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob5-")) });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(store.store("../evil", bytes)).rejects.toThrow("invalid storage key");
    await expect(store.read("../evil")).rejects.toThrow("invalid storage key");
  });

  it("rejects an absolute-path key rather than escaping root", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob6-")) });
    const bytes = new Uint8Array([1, 2, 3]);

    await expect(store.store("/etc/passwd", bytes)).rejects.toThrow("invalid storage key");
    await expect(store.read("/etc/passwd")).rejects.toThrow("invalid storage key");
  });

  it("still allows a legitimate nested key (single subdirectory) to round-trip", async () => {
    const store = new FsBlobStore({ root: mkdtempSync(join(tmpdir(), "sb-fs-blob7-")) });
    const bytes = new Uint8Array([9, 8, 7, 6]);

    const result = await store.store("sub/dir/file", bytes);
    expect(result.size).toBe(bytes.byteLength);

    const readBack = await store.read("sub/dir/file");
    expect(readBack).not.toBeNull();
    const chunks: Uint8Array[] = [];
    for await (const chunk of readBack as any) chunks.push(chunk as Uint8Array);
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c)))).toEqual(Buffer.from(bytes));
  });
});
