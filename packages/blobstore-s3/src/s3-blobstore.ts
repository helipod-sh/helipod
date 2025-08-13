import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@stackbase/blobstore";
import { makeS3Client } from "./s3-config";

export interface S3Config {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean; // true for MinIO/R2-style endpoints
  publicBaseUrl?: string; // CDN/public base; enables publicUrl()
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

async function toBuffer(bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes;
  const reader = bytes.getReader();
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

export class S3BlobStore implements BlobStore {
  private readonly s3: S3Client;
  private readonly bucket: string;
  private readonly publicBase?: string;

  constructor(config: S3Config) {
    this.s3 = makeS3Client(config);
    this.bucket = config.bucket;
    this.publicBase = config.publicBaseUrl;
  }

  async createUploadTarget(key: string, opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    const cmd = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: opts.contentType });
    const url = await getSignedUrl(this.s3, cmd, { expiresIn: Math.ceil(opts.expiresInMs / 1000) });
    return {
      kind: "presigned",
      url,
      method: "PUT",
      headers: opts.contentType ? { "content-type": opts.contentType } : undefined,
    };
  }

  async store(
    key: string,
    bytes: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { contentType?: string },
  ): Promise<StoredBlob> {
    const buf = await toBuffer(bytes);
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf, ContentType: opts?.contentType }),
    );
    return { size: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    try {
      const h = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: h.ContentLength ?? 0, sha256: null };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const r = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.start}-${range.end ?? ""}` : undefined,
        }),
      );
      if (!r.Body) return null;
      return Readable.toWeb(r.Body as Readable) as unknown as ReadableStream<Uint8Array>;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async signGetUrl(key: string, opts: SignUrlOpts): Promise<string | null> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: Math.ceil(opts.expiresInMs / 1000),
    });
  }

  publicUrl(key: string): string | null {
    return this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/${key}` : null;
  }
}
