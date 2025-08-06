import { createHash } from "node:crypto";
import type { BlobStore, UploadTarget, StoredBlob, ByteRange, CreateUploadTargetOpts, SignUrlOpts } from "../src/types";

async function toBytes(bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  const chunks: Uint8Array[] = [];
  const reader = bytes.getReader();
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

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async createUploadTarget(key: string, _opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return { kind: "proxied", url: `/api/storage/upload?key=${encodeURIComponent(key)}`, method: "POST" };
  }

  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<StoredBlob> {
    const buf = await toBytes(bytes);
    this.blobs.set(key, buf);
    return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    const buf = this.blobs.get(key);
    if (!buf) return null;
    return { size: buf.byteLength, sha256: null }; // direct-path: sha256 unknown
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const buf = this.blobs.get(key);
    if (!buf) return null;
    if (!range) return streamOf(buf);
    const end = range.end ?? buf.byteLength - 1;
    return streamOf(buf.subarray(range.start, end + 1));
  }

  async delete(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  async signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> {
    return null;
  }

  publicUrl(_key: string): string | null {
    return null;
  }
}
