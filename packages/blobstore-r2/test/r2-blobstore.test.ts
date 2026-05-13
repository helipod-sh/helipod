import { describe, it, expect } from "vitest";
import { R2BlobStore, type R2BucketLike, type R2ObjectLike, type R2ObjectBodyLike, type R2GetOptionsLike, type R2PutOptionsLike } from "../src";

/**
 * An in-memory `R2BucketLike` fake — enough of the R2 binding surface to exercise `R2BlobStore`
 * under Node/vitest (the fast lane). The real-R2 fidelity is proven in the workerd harness
 * (`packages/runtime-cloudflare`) against miniflare's R2 emulation; here we pin the adapter's own
 * byte/size/sha256/range logic deterministically.
 */
class MemoryR2 implements R2BucketLike {
  readonly store = new Map<string, { body: Uint8Array; contentType?: string }>();

  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike | null> {
    // The adapter always buffers to a Uint8Array before calling put, so we only handle that shape.
    const view = value as ArrayBufferView;
    const body = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    this.store.set(key, { body, ...(options?.httpMetadata?.contentType ? { contentType: options.httpMetadata.contentType } : {}) });
    return Promise.resolve({ size: body.byteLength });
  }

  get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | null> {
    const entry = this.store.get(key);
    if (!entry) return Promise.resolve(null);
    let bytes = entry.body;
    if (options?.range) {
      const { offset, length } = options.range;
      bytes = bytes.slice(offset, length !== undefined ? offset + length : undefined);
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return Promise.resolve({ size: entry.body.byteLength, body: stream });
  }

  head(key: string): Promise<R2ObjectLike | null> {
    const entry = this.store.get(key);
    return Promise.resolve(entry ? { size: entry.body.byteLength } : null);
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }
}

async function drain(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (stream === null) throw new Error("null stream");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe("R2BlobStore", () => {
  it("createUploadTarget is always proxied (R2 binding has no presigned PUT)", async () => {
    const store = new R2BlobStore({ bucket: new MemoryR2() });
    const target = await store.createUploadTarget("k1", { expiresInMs: 1000, now: 0, contentType: "text/plain" });
    expect(target.kind).toBe("proxied");
    expect(target.url).toBe("/api/storage/upload");
    expect(target.method).toBe("POST");
    expect(target.headers).toEqual({ "content-type": "text/plain" });
  });

  it("stores bytes, returns size + sha256, and reads them back", async () => {
    const bucket = new MemoryR2();
    const store = new R2BlobStore({ bucket });
    const bytes = new TextEncoder().encode("hello r2");
    const info = await store.store("k2", bytes, { contentType: "text/plain" });
    expect(info.size).toBe(bytes.byteLength);
    // Known sha256 of "hello r2".
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(bucket.store.get("k2")?.contentType).toBe("text/plain");
    const read = await store.read("k2");
    expect(new TextDecoder().decode(await drain(read))).toBe("hello r2");
  });

  it("computes the correct sha256 (matches a reference digest)", async () => {
    const store = new R2BlobStore({ bucket: new MemoryR2() });
    const bytes = new TextEncoder().encode("abc");
    const info = await store.store("k3", bytes);
    // SHA-256("abc")
    expect(info.sha256).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("reads a byte range ([start,end] inclusive → R2 offset/length)", async () => {
    const store = new R2BlobStore({ bucket: new MemoryR2() });
    await store.store("k4", new TextEncoder().encode("0123456789"));
    const slice = await store.read("k4", { start: 2, end: 5 });
    expect(new TextDecoder().decode(await drain(slice))).toBe("2345");
    const openEnded = await store.read("k4", { start: 7 });
    expect(new TextDecoder().decode(await drain(openEnded))).toBe("789");
  });

  it("read/finalizeUpload return null for a missing key; delete removes", async () => {
    const store = new R2BlobStore({ bucket: new MemoryR2() });
    expect(await store.read("missing")).toBeNull();
    expect(await store.finalizeUpload("missing")).toBeNull();
    await store.store("k5", new TextEncoder().encode("x"));
    expect(await store.finalizeUpload("k5")).toEqual({ size: 1, sha256: null });
    await store.delete("k5");
    expect(await store.read("k5")).toBeNull();
  });

  it("signGetUrl is null (no presigning); publicUrl honors publicBaseUrl", async () => {
    const withBase = new R2BlobStore({ bucket: new MemoryR2(), publicBaseUrl: "https://cdn.example.com/" });
    expect(await withBase.signGetUrl("k6", { expiresInMs: 1000, now: 0 })).toBeNull();
    expect(withBase.publicUrl("k6")).toBe("https://cdn.example.com/k6");
    const noBase = new R2BlobStore({ bucket: new MemoryR2() });
    expect(noBase.publicUrl("k6")).toBeNull();
  });
});
