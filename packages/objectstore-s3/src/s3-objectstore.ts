import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { CasConflict, isCasConflict, type ObjectStore } from "@helipod/objectstore";

export interface S3ObjectStoreOpts {
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Path-style addressing (required for MinIO / most non-AWS S3-compatible endpoints). Defaults
   *  to true whenever `endpoint` is set (mirrors `@helipod/blobstore-s3`'s `makeS3Client`). */
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

  /** Write-once/keep-first (matches fs/memory — see `@helipod/objectstore`'s `ObjectStore` doc).
   *  Issues the SAME create-only conditional PUT `casPut(key, body, null)` uses (`IfNoneMatch: "*"`);
   *  a precondition failure means the key already exists — that is a KEEP-FIRST NO-OP (the existing
   *  object wins), not an error, so this stays idempotent-by-key like the other adapters. This is the
   *  invariant the Tier-3 fence relies on: a fenced/zombie writer that reuses a segment seqno can never
   *  overwrite a LIVE manifest-referenced segment on S3 (it silently loses the race; its manifest CAS
   *  still fails separately, throwing `FencedError`). Any OTHER error (network/permissions/etc.)
   *  rethrows. */
  async putImmutable(key: string, body: Uint8Array): Promise<void> {
    try {
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, IfNoneMatch: "*" }),
      );
    } catch (e) {
      if (isCasConflictResponse(e)) return; // keep-first: the existing object wins
      throw e;
    }
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

  /** Probe: verify the store enforces BOTH conditional-write modes the fence relies on — `If-None-Match`
   *  (create-only, used to birth a manifest) AND `If-Match` (compare-and-swap update, the manifest fence
   *  that the WHOLE substrate rests on). Some S3-compatible stores honor one and silently ignore the
   *  other; a store that ignored `If-Match` would pass a create-only probe yet allow two-winner manifest
   *  updates — the exact corruption this exists to prevent (whole-branch review, Slice 1). Fail closed on
   *  either gap. Unique (timestamp + random) sentinel key so the probe is safely re-runnable across boots. */
  async assertCasSupported(): Promise<void> {
    const sentinel = `_probe/cas-support-${Date.now()}-${randomBytes(6).toString("hex")}`;
    const enc = (s: string) => new TextEncoder().encode(s);
    const failed = (mode: string) =>
      new Error(`object store does not enforce conditional writes (${mode}) — required for the Tier-3 fence`);
    /** Run `op`; return true iff it did NOT throw a CasConflict (i.e. the store accepted a write it
     *  should have rejected → CAS not enforced). Rethrows any non-CAS error (403/network/etc.). */
    const accepted = async (op: () => Promise<unknown>): Promise<boolean> => {
      try { await op(); return true; } catch (e) { if (isCasConflict(e)) return false; throw e; }
    };
    try {
      // (1) If-None-Match: create once, then a second create-only must be REJECTED.
      const { etag } = await this.casPut(sentinel, enc("probe-1"), null);
      if (await accepted(() => this.casPut(sentinel, enc("probe-2"), null))) throw failed("If-None-Match");
      // (2) If-Match with a WRONG etag must be REJECTED (the CAS-update fence).
      if (await accepted(() => this.casPut(sentinel, enc("probe-3"), "\"deadbeefdeadbeefdeadbeefdeadbeef\""))) throw failed("If-Match");
      // (3) If-Match with the RIGHT etag must SUCCEED (a conforming store isn't rejecting valid CAS).
      try { await this.casPut(sentinel, enc("probe-4"), etag); }
      catch (e) { if (isCasConflict(e)) throw new Error("object store rejected a valid If-Match CAS (etag mismatch on the sentinel) — cannot use for the Tier-3 fence"); throw e; }
    } finally {
      await this.delete(sentinel).catch(() => {});
    }
  }
}
