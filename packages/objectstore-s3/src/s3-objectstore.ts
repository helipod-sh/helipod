import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CasConflict, isCasConflict, type ObjectStore } from "@stackbase/objectstore";

export interface S3ObjectStoreOpts {
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Path-style addressing (required for MinIO / most non-AWS S3-compatible endpoints). Defaults
   *  to true whenever `endpoint` is set (mirrors `@stackbase/blobstore-s3`'s `makeS3Client`). */
  forcePathStyle?: boolean;
}

function isCasConflictResponse(e: unknown): boolean {
  const status = (e as { $metadata?: { httpStatusCode?: number } } | null | undefined)?.$metadata
    ?.httpStatusCode;
  const name = (e as { name?: string } | null | undefined)?.name ?? "";
  return status === 412 || status === 409 || /PreconditionFailed|ConditionalRequestConflict/.test(name);
}

function isNoSuchKey(e: unknown): boolean {
  return (e as { name?: string } | null | undefined)?.name === "NoSuchKey";
}

/** S3-class `ObjectStore` — the Tier-3 substrate's real bucket, over `@aws-sdk/client-s3`.
 *  S3/MinIO/R2-compatible (anything that supports conditional PUT via `If-Match`/`If-None-Match`).
 *  CAS is the commit linearization point the whole substrate rests on — see `assertCasSupported`. */
export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(opts: S3ObjectStoreOpts) {
    this.bucket = opts.bucket;
    this.s3 = new S3Client({
      region: opts.region ?? "us-east-1",
      endpoint: opts.endpoint,
      forcePathStyle: opts.forcePathStyle ?? Boolean(opts.endpoint),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }

  async putImmutable(key: string, body: Uint8Array): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
  }

  async casPut(key: string, body: Uint8Array, ifMatch: string | null): Promise<{ etag: string }> {
    try {
      const res = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(ifMatch === null ? { IfNoneMatch: "*" } : { IfMatch: ifMatch }),
        }),
      );
      return { etag: res.ETag ?? "" };
    } catch (e) {
      if (isCasConflictResponse(e)) throw new CasConflict();
      throw e;
    }
  }

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    try {
      const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = await res.Body!.transformToByteArray();
      return { body, etag: res.ETag ?? "" };
    } catch (e) {
      if (isNoSuchKey(e)) return null;
      throw e;
    }
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const o of res.Contents ?? []) {
        if (o.Key) keys.push(o.Key);
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Probe: PUT a sentinel key with `If-None-Match: *` twice. The 2nd must throw `CasConflict` —
   *  if it instead succeeds, the store isn't actually enforcing conditional writes (some S3-compatible
   *  stores silently ignore the header), which would silently break the whole Tier-3 CAS fence.
   *  Uses a unique (timestamp + random) sentinel key so the probe is safely re-runnable across boots. */
  async assertCasSupported(): Promise<void> {
    const sentinel = `_probe/cas-support-${Date.now()}-${randomBytes(6).toString("hex")}`;
    try {
      await this.casPut(sentinel, new TextEncoder().encode("probe-1"), null);
      let secondSucceeded = false;
      try {
        await this.casPut(sentinel, new TextEncoder().encode("probe-2"), null);
        secondSucceeded = true;
      } catch (e) {
        if (!isCasConflict(e)) throw e;
      }
      if (secondSucceeded) {
        throw new Error(
          "object store does not enforce conditional writes (If-Match) — required for the Tier-3 fence",
        );
      }
    } finally {
      await this.delete(sentinel).catch(() => {});
    }
  }
}
