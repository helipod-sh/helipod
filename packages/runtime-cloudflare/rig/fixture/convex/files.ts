// File-storage surface for the deploy rig's real-R2 E2E. `ctx.storage` is contributed at runtime by
// the always-on storage provider (wired when `worker.ts` injects an `R2BlobStore`), so a local
// structural type lets this fixture typecheck (mirrors `packages/cli/test/fixtures/storage-app`).
import { query, mutation } from "@stackbase/executor";

type UploadTarget = { kind: "proxied" | "presigned"; url: string; method: string; headers?: Record<string, string> };
type StorageWriter = {
  generateUploadUrl(opts?: { contentType?: string; visibility?: "private" | "public" }): Promise<{ storageId: string; target: UploadTarget }>;
  getUrl(id: string): Promise<string | null>;
  getMetadata(id: string): Promise<{ size: number | null; contentType: string | null; sha256: string | null } | null>;
};
function storageOf(ctx: unknown): StorageWriter {
  return (ctx as { storage: StorageWriter }).storage;
}

/** Mint a proxied upload target (bytes go to R2 via the DO's own /api/storage/upload endpoint). */
export const genUpload = mutation({
  handler: (ctx, { contentType }: { contentType?: string }) =>
    storageOf(ctx).generateUploadUrl(contentType ? { contentType } : undefined),
});

/** Resolve a stored file's token-signed download url. */
export const getUrl = query({
  handler: (ctx, { id }: { id: string }) => storageOf(ctx).getUrl(id),
});

/** The `_storage` metadata for an id (null once reaped/deleted). */
export const getMeta = query({
  handler: (ctx, { id }: { id: string }) => storageOf(ctx).getMetadata(id),
});
