import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@helipod/blobstore";

export class FsBlobStore implements BlobStore {
  private readonly root: string;
  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private path(key: string): string {
    const root = resolve(this.root);
    const p = resolve(root, key);
    if (p !== root && !p.startsWith(root + sep)) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return p;
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
      const onError = (err: unknown) => {
        rm(p, { force: true }).finally(() => reject(err));
      };
      source.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.byteLength;
      });
      source.on("error", onError);
      out.on("error", onError);
      out.on("finish", resolve);
      source.pipe(out);
    });
    return { size, sha256: hash.digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    const p = this.path(key);
    try {
      const s = await stat(p);
      return { size: s.size, sha256: null };
    } catch {
      return null;
    }
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    const p = this.path(key);
    try {
      await stat(p);
    } catch {
      return null;
    }
    const node = createReadStream(p, range ? { start: range.start, end: range.end } : {});
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
