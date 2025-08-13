import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import type { BlobStore } from "../src/types";

async function drain(s: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!s) throw new Error("expected a stream, got null");
  const chunks: Uint8Array[] = [];
  const reader = s.getReader();
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

export function runBlobStoreConformance(
  label: string,
  makeStore: () => BlobStore | Promise<BlobStore>,
  teardown?: () => Promise<void> | void,
): void {
  describe(`BlobStore conformance: ${label}`, () => {
    afterAll(async () => {
      await teardown?.();
    });

    it("stores and reads back bytes", async () => {
      const store = await makeStore();
      const data = new TextEncoder().encode("hello stackbase");
      const res = await store.store("k1", data);
      expect(res.size).toBe(data.byteLength);
      const round = await drain(await store.read("k1"));
      expect(new TextDecoder().decode(round)).toBe("hello stackbase");
    });

    it("computes sha256 on store()", async () => {
      const store = await makeStore();
      const data = new TextEncoder().encode("checksum me");
      const res = await store.store("k2", data);
      expect(res.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    });

    it("returns null reading a missing key", async () => {
      const store = await makeStore();
      expect(await store.read("nope")).toBeNull();
    });

    it("serves a byte range", async () => {
      const store = await makeStore();
      await store.store("k3", new TextEncoder().encode("0123456789"));
      const part = await drain(await store.read("k3", { start: 2, end: 5 }));
      expect(new TextDecoder().decode(part)).toBe("2345");
    });

    it("deletes a blob", async () => {
      const store = await makeStore();
      await store.store("k4", new TextEncoder().encode("x"));
      await store.delete("k4");
      expect(await store.read("k4")).toBeNull();
    });

    it("finalizeUpload returns null for a never-uploaded key", async () => {
      const store = await makeStore();
      expect(await store.finalizeUpload("ghost")).toBeNull();
    });

    it("createUploadTarget returns a usable target", async () => {
      const store = await makeStore();
      const t = await store.createUploadTarget("k5", { expiresInMs: 60_000, now: 1_700_000_000_000 });
      expect(t.kind === "proxied" || t.kind === "presigned").toBe(true);
      expect(typeof t.url).toBe("string");
    });
  });
}
