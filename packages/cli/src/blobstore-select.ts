/**
 * Byte-backend selection for the always-on file-storage feature — the `BlobStore` analog to
 * `boot.ts`'s `makeStore` (which picks SQLite vs Postgres). Pure and side-effect-free so it is
 * unit-testable: given a resolved config it returns a `FsBlobStore` (zero-config local default)
 * or an `S3BlobStore` (any S3-compatible bucket: AWS S3, MinIO, R2, …). The actual writable-dir
 * fail-fast and env/flag resolution live in `boot.ts`, not here.
 */
import { join } from "node:path";
import type { BlobStore } from "@helipod/blobstore";
import { FsBlobStore } from "@helipod/blobstore-fs";
import { S3BlobStore, type S3Config } from "@helipod/blobstore-s3";

/** Resolved storage config. A `bucket` selects the S3 backend; everything else is FS. */
export type StorageConfig = Partial<S3Config> & { bucket?: string };

export interface BlobStoreOptions {
  /**
   * The engine data DIRECTORY (the dir the SQLite file lives in, not the file itself); FS blobs
   * go in `<dataPath>/storage`. `boot.ts` passes `dirname(dbFilePath)` here.
   */
  dataPath: string;
  storage?: StorageConfig;
}

/** True iff an S3 bucket is configured — the single switch between the S3 and FS backends. */
export function isS3Config(storage: StorageConfig | undefined): boolean {
  return Boolean(storage?.bucket);
}

/**
 * Resolve the storage config from env + optional CLI-flag overrides (flags win, mirroring
 * `--database-url` over `HELIPOD_DATABASE_URL`). Unset bucket → the FS backend. Reads the S3
 * settings from `HELIPOD_STORAGE_*` plus the standard AWS credential vars.
 */
export function resolveStorageConfig(
  env: Record<string, string | undefined>,
  flags?: StorageConfig,
): StorageConfig {
  return {
    bucket: flags?.bucket ?? env.HELIPOD_STORAGE_BUCKET,
    endpoint: flags?.endpoint ?? env.HELIPOD_STORAGE_ENDPOINT,
    region: flags?.region ?? env.HELIPOD_STORAGE_REGION,
    publicBaseUrl: flags?.publicBaseUrl ?? env.HELIPOD_STORAGE_PUBLIC_URL,
    accessKeyId: flags?.accessKeyId ?? env.AWS_ACCESS_KEY_ID,
    secretAccessKey: flags?.secretAccessKey ?? env.AWS_SECRET_ACCESS_KEY,
    ...(flags?.forcePathStyle !== undefined ? { forcePathStyle: flags.forcePathStyle } : {}),
  };
}

/**
 * Pick the byte backend: `S3BlobStore` when a bucket is configured (`isS3Config`), else the
 * zero-config `FsBlobStore` rooted at `<dataPath>/storage`.
 */
export function makeBlobStore(opts: BlobStoreOptions): BlobStore {
  const s = opts.storage;
  if (isS3Config(s)) {
    return new S3BlobStore({
      bucket: s!.bucket!,
      region: s!.region,
      endpoint: s!.endpoint,
      accessKeyId: s!.accessKeyId,
      secretAccessKey: s!.secretAccessKey,
      forcePathStyle: s!.forcePathStyle,
      publicBaseUrl: s!.publicBaseUrl,
    });
  }
  return new FsBlobStore({ root: join(opts.dataPath, "storage") });
}
