/**
 * `R2BlobStore` — a `BlobStore` (`@helipod/blobstore`) backed by a Cloudflare R2 bucket binding,
 * for the Durable Object host. It is the DO-native analog of `@helipod/blobstore-fs` (local disk,
 * broken on a DO — no filesystem) and `@helipod/blobstore-s3` (points at S3 via the heavy AWS SDK +
 * `node:stream`, marginal on Workers). This adapter is WORKERS-SAFE by construction:
 *   - NO `node:fs`, NO `node:stream`, NO `node:crypto` — bytes flow as `Uint8Array`/`ReadableStream`
 *     (Web streams), and the content digest is computed with WebCrypto (`crypto.subtle`, a workerd
 *     global) rather than `node:crypto`'s `createHash`.
 *   - The R2 bucket is INJECTED (the DO host passes `env.R2`), never imported — the engine stays
 *     database/blob-store neutral, exactly as the `DocStore` seam does. `@cloudflare/workers-types` is
 *     a TYPE-ONLY devDependency; at runtime a real workerd `R2Bucket` satisfies `R2BucketLike` by
 *     width, so this package carries no Cloudflare runtime dependency.
 *
 * Upload shape: R2 accessed via the binding has no presigned-PUT surface (presigning needs the S3 API
 * + static credentials), so uploads use the PROXIED shape — the client POSTs bytes to the engine's own
 * `/api/storage/upload` endpoint, which the DO's `fetch` serves by calling `store()` here (R2 `put`).
 * Byte I/O therefore runs in the DO's fetch handler, NEVER in the transactor turn — the same rule the
 * FS/S3 backends and the container serve endpoint follow. Downloads stream R2's `ReadableStream` body
 * straight back through the serve endpoint (`signGetUrl` returns `null` — no presigning — so the serve
 * handler streams bytes rather than issuing a 302 redirect).
 */
import type {
  BlobStore,
  UploadTarget,
  StoredBlob,
  ByteRange,
  CreateUploadTargetOpts,
  SignUrlOpts,
} from "@helipod/blobstore";

/** The engine's own proxied-upload endpoint (the `ctx.storage` context provider appends the
 *  capability `id`/`exp`/`token` params — see `@helipod/storage`'s `context.ts`). */
const UPLOAD_ENDPOINT = "/api/storage/upload";

/**
 * The MINIMAL structural surface of a Cloudflare R2 bucket binding this adapter drives — declared
 * inline as narrow interfaces (the same injection-not-import discipline `runtime-cloudflare`'s
 * `cf-types.ts` and `docstore-do-sqlite`'s `SqlStorageLike` use). A real workerd `R2Bucket` satisfies
 * these by WIDTH, so the DO host wires `env.R2` in with zero casts and no runtime dependency here.
 */
export interface R2ObjectLike {
  /** Object size in bytes. */
  readonly size: number;
}
export interface R2ObjectBodyLike extends R2ObjectLike {
  /** The object's bytes as a Web `ReadableStream` (null only for a zero-length HEAD-style object). */
  readonly body: ReadableStream<Uint8Array> | null;
}
/** A single byte range for an R2 `get` — offset + optional length (mirrors R2's `R2Range`). */
export interface R2RangeLike {
  offset: number;
  length?: number;
}
export interface R2PutOptionsLike {
  httpMetadata?: { contentType?: string };
}
export interface R2GetOptionsLike {
  range?: R2RangeLike;
}
export interface R2BucketLike {
  put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | ArrayBufferView | string | null,
    options?: R2PutOptionsLike,
  ): Promise<R2ObjectLike | null>;
  get(key: string, options?: R2GetOptionsLike): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
}

export interface R2BlobStoreOpts {
  /** The R2 bucket binding (`env.R2`). Injected by the DO host — never imported. */
  bucket: R2BucketLike;
  /**
   * Optional public base URL for `"public"`-visibility files (an R2 custom domain or the
   * bucket's `r2.dev` URL). When set, `publicUrl(key)` resolves to `${publicBaseUrl}/${key}`;
   * unset → `publicUrl` returns `null` and the serve endpoint streams bytes for public files too.
   */
  publicBaseUrl?: string;
}

/** Collect a `Uint8Array` | `ReadableStream<Uint8Array>` into one contiguous `Uint8Array` (mirrors
 *  `@helipod/blobstore-s3`'s `toBuffer`). We buffer so `size`/`sha256` are known before the R2
 *  `put` returns — the proxied path always hands us a `Uint8Array` already, so this is a no-op there. */
async function toBytes(bytes: ReadableStream<Uint8Array> | Uint8Array): Promise<Uint8Array> {
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

/** SHA-256 hex of `bytes` via WebCrypto (`crypto.subtle`, a workerd/Node/Bun global) — NOT
 *  `node:crypto`'s `createHash`, which isn't guaranteed on the Workers runtime. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  const view = new Uint8Array(digest);
  let hex = "";
  for (const b of view) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export class R2BlobStore implements BlobStore {
  private readonly bucket: R2BucketLike;
  private readonly publicBase?: string;

  constructor(opts: R2BlobStoreOpts) {
    this.bucket = opts.bucket;
    this.publicBase = opts.publicBaseUrl;
  }

  // The R2 binding has no presigned-PUT surface, so uploads are always proxied through the engine's
  // own endpoint (the context provider stamps the capability `id`/`token` params onto this URL).
  createUploadTarget(_key: string, opts: CreateUploadTargetOpts): Promise<UploadTarget> {
    return Promise.resolve({
      kind: "proxied",
      url: UPLOAD_ENDPOINT,
      method: "POST",
      ...(opts.contentType ? { headers: { "content-type": opts.contentType } } : {}),
    });
  }

  async store(
    key: string,
    bytes: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { contentType?: string },
  ): Promise<StoredBlob> {
    const buf = await toBytes(bytes);
    await this.bucket.put(key, buf as unknown as ArrayBufferView, {
      ...(opts?.contentType ? { httpMetadata: { contentType: opts.contentType } } : {}),
    });
    return { size: buf.byteLength, sha256: await sha256Hex(buf) };
  }

  // Used by the presigned/direct-to-bucket confirm path (unused on the proxied R2 flow, but kept for
  // contract parity): a HEAD to learn the size of an object PUT directly. sha256 is unknown here.
  async finalizeUpload(key: string): Promise<StoredBlob | null> {
    const head = await this.bucket.head(key);
    if (head === null) return null;
    return { size: head.size, sha256: null };
  }

  async read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null> {
    // The serve endpoint (`@helipod/storage`'s `handleServe`) always clamps `end` to `size-1` and
    // passes both bounds, so translate `[start, end]` → R2's `{ offset, length }` (inclusive-end →
    // length = end - start + 1). An absent `range` reads the whole object.
    const obj =
      range !== undefined
        ? await this.bucket.get(key, {
            range: { offset: range.start, ...(range.end !== undefined ? { length: range.end - range.start + 1 } : {}) },
          })
        : await this.bucket.get(key);
    if (obj === null || obj.body === null) return null;
    return obj.body;
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  // No presigning over the R2 binding → the serve endpoint streams bytes through the DO instead of
  // issuing a 302 redirect (its documented fallback when `signGetUrl` returns `null`).
  signGetUrl(_key: string, _opts: SignUrlOpts): Promise<string | null> {
    return Promise.resolve(null);
  }

  publicUrl(key: string): string | null {
    return this.publicBase ? `${this.publicBase.replace(/\/$/, "")}/${key}` : null;
  }
}
