export type UploadTarget =
  | { kind: "proxied"; url: string; method: "POST"; headers?: Record<string, string> }
  | {
      kind: "presigned";
      url: string;
      method: "PUT";
      headers?: Record<string, string>;
      /**
       * The engine confirm endpoint the client must `POST` after a successful direct-to-bucket PUT
       * (`POST /api/storage/confirm?id=&exp=&token=`), which flips the `_storage` row to `ready`.
       * The `BlobStore` itself never sets this (it doesn't know the engine's confirm endpoint/token
       * scheme) — the `ctx.storage` context provider fills it in on the returned target. Absent for
       * proxied uploads, whose single upload endpoint both stores the bytes and finalizes the row.
       */
      confirmUrl?: string;
    };

export interface StoredBlob {
  size: number;
  sha256: string | null;
}

export interface BlobMetadata {
  size: number | null;
  contentType: string | null;
  sha256: string | null;
}

export interface CreateUploadTargetOpts {
  contentType?: string;
  expiresInMs: number;
  now: number;
}

export interface SignUrlOpts {
  expiresInMs: number;
  now: number;
}

export interface ByteRange {
  start: number;
  end?: number;
}

export interface BlobStore {
  createUploadTarget(key: string, opts: CreateUploadTargetOpts): Promise<UploadTarget>;
  store(
    key: string,
    bytes: ReadableStream<Uint8Array> | Uint8Array,
    opts?: { contentType?: string },
  ): Promise<StoredBlob>;
  finalizeUpload(key: string): Promise<StoredBlob | null>;
  read(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
  signGetUrl(key: string, opts: SignUrlOpts): Promise<string | null>; // async: the S3 presigner returns a Promise
  publicUrl(key: string): string | null;
}
