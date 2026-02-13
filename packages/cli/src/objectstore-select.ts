/**
 * Object-store backend selection for the Tier-3 object-storage substrate — the `ObjectStore`
 * analog to `blobstore-select.ts` (which picks the fs-vs-s3 byte backend for file storage).
 * Pure and side-effect-free: parse + construct only, NO live I/O (no bucket probe — the boot
 * path calls the adapter's own `assertCasSupported()` separately once it decides to actually
 * boot the object-store writer node). That purity is what makes this unit-testable without a
 * real bucket or filesystem.
 *
 * URL grammar (one clear shape, chosen to mirror `blobstore-select`'s existing S3 conventions —
 * `endpoint`/`region`/`forcePathStyle`/AWS-env credential fallback — while folding everything
 * into a single `--object-store <url>` flag instead of a family of `--storage-*` flags):
 *
 *   - unset / empty string          -> `null` (object-store mode not requested)
 *   - `file://<path>`               -> `FsObjectStore` rooted at `<path>`
 *       (e.g. `file:///var/lib/stackbase/objects` -> dir `/var/lib/stackbase/objects`)
 *   - a bare filesystem path (no `://`) -> same, `FsObjectStore` rooted at that path
 *       (e.g. `--object-store ./objects`)
 *   - `s3://[accessKeyId:secretAccessKey@]host[:port]/bucket[?region=…&endpoint=…&forcePathStyle=…]`
 *       -> `S3ObjectStore`. The bucket is the URL's path (first segment); it is REQUIRED.
 *       `host[:port]`, when non-empty, becomes the endpoint (`http://host[:port]`) UNLESS an
 *       explicit `?endpoint=` query param is given, which always wins (the only way to reach a
 *       `https://` endpoint, since a bare host is assumed `http://` — true for MinIO/R2/etc.
 *       run locally or in-cluster). An EMPTY host (`s3:///bucket`, three slashes) means "no
 *       custom endpoint" — real AWS S3 via the SDK's own region-routed default endpoint. This
 *       is why a bucket can't be given as `s3://bucket` (two slashes): the WHATWG URL parser
 *       reads that as `hostname="bucket"`, not a path — use `s3:///bucket` instead.
 *       Credentials come from the URL userinfo (`key:secret@`) if present, else
 *       `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (checked independently, so e.g. a URL-supplied
 *       key with an env-supplied secret works). Missing bucket or missing credentials -> throw
 *       a clear `Error` (fail fast at parse time, before any network/lease work).
 *
 * Examples:
 *   `s3://minioadmin:minioadmin@localhost:9000/stackbase-objects?region=us-east-1`
 *   `s3:///my-prod-bucket?region=us-west-2`                (real AWS S3, creds from env)
 *   `file:///data/objects`
 *   `./objects`
 */
import type { ObjectStore } from "@stackbase/objectstore";
import { FsObjectStore } from "@stackbase/objectstore-fs";
import { S3ObjectStore } from "@stackbase/objectstore-s3";

export type ObjectStoreKind = "s3" | "fs";

export interface ResolvedObjectStore {
  objectStore: ObjectStore;
  kind: ObjectStoreKind;
}

/** Slice-6 single-shard-node config: one shard, "0", behind the whole store. Multi-shard-node
 *  (N lanes behind a routing DocStore) is explicitly out of scope for this slice — see the plan. */
export interface ObjectStoreNodeConfig {
  shard: string;
  numShards: number;
}

export function defaultObjectStoreNodeConfig(): ObjectStoreNodeConfig {
  return { shard: "0", numShards: 1 };
}

/** Parsed S3 config, exposed for assertion in tests without performing any live S3 I/O
 *  (constructing `S3Client` does not itself touch the network). Mirrors `S3ObjectStoreOpts`. */
export interface ParsedS3Config {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

function parseBoolParam(v: string | null): boolean | undefined {
  if (v === null) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`stackbase: invalid --object-store URL — forcePathStyle must be "true" or "false", got "${v}"`);
}

/** Parse an `s3://…` URL per the grammar documented above. Pure — no I/O. Throws a clear `Error`
 *  on a missing bucket or missing credentials (URL userinfo + `env` fallback both absent). */
export function parseS3ObjectStoreUrl(
  url: string,
  env: Record<string, string | undefined> = process.env,
): ParsedS3Config {
  let u: URL;
  try {
    u = new URL(url);
  } catch (e) {
    throw new Error(`stackbase: invalid --object-store URL "${url}": ${(e as Error).message}`);
  }

  const bucket = decodeURIComponent(u.pathname.replace(/^\//, "").split("/")[0] ?? "");
  if (!bucket) {
    throw new Error(
      `stackbase: --object-store S3 URL "${url}" has no bucket — use s3://host/<bucket> ` +
        `(or s3:///<bucket> for real AWS S3 with no custom endpoint).`,
    );
  }

  const explicitEndpoint = u.searchParams.get("endpoint") ?? undefined;
  const endpoint = explicitEndpoint ?? (u.hostname ? `http://${u.hostname}${u.port ? `:${u.port}` : ""}` : undefined);

  const region = u.searchParams.get("region") ?? undefined;
  const forcePathStyle = parseBoolParam(u.searchParams.get("forcePathStyle"));

  const accessKeyId = (u.username ? decodeURIComponent(u.username) : undefined) ?? env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = (u.password ? decodeURIComponent(u.password) : undefined) ?? env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `stackbase: --object-store S3 URL "${url}" is missing credentials — supply them in the URL ` +
        `(s3://accessKeyId:secretAccessKey@…) or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.`,
    );
  }

  return { bucket, endpoint, region, accessKeyId, secretAccessKey, forcePathStyle };
}

/** `file://<path>` or a bare filesystem path -> the dir an `FsObjectStore` should root at. */
function parseFsObjectStorePath(url: string): string {
  return url.startsWith("file://") ? url.slice("file://".length) : url;
}

/**
 * Resolve `--object-store <url>` / `STACKBASE_OBJECT_STORE` to a constructed `ObjectStore`
 * adapter. `undefined`/empty -> `null` (object-store mode not requested — the CLI falls through
 * to its normal `makeStore` SQLite/Postgres selection). Pure: parses and constructs only, no
 * live I/O (the caller runs `assertCasSupported()`/`ensureGlobals`/lease-acquire separately).
 */
export function resolveObjectStore(
  url: string | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedObjectStore | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("s3://")) {
    const config = parseS3ObjectStoreUrl(trimmed, env);
    return { objectStore: new S3ObjectStore(config), kind: "s3" };
  }

  return { objectStore: new FsObjectStore({ dir: parseFsObjectStorePath(trimmed) }), kind: "fs" };
}
