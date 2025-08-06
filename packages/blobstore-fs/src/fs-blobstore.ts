import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@stackbase/blobstore";

export class FsBlobStore implements BlobStore {
  private readonly root: string;
  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private path(key: string): string {
    return join(this.root, key);
  }

  async createUploadTarget(_key: string, _opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return { kind: "proxied", url: "/api/storage/upload", method: "POST" };
  }

  async store(key: string, bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<StoredBlob> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(p);
    const source = bytes instanceof Uint8Array ? Readable.from([bytes]) : Readable.fromWeb(bytes as any);
    await new Promise<void>((resolve, reject) => {
      source.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.byteLength;
      });
      source.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      source.pipe(out);
    });
    return { size, sha256: hash.digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    try {
      const s = await stat(this.path(key));
      return { size: s.size, sha256: null };
    } catch {
      return null;
    }
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    try {
      await stat(this.path(key));
    } catch {
      return null;
    }
    const node = createReadStream(this.path(key), range ? { start: range.start, end: range.end } : {});
    return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> {
    return null;
  }

  publicUrl(_key: string): string | null {
    return null;
  }
}
