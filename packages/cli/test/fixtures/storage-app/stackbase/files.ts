import { query, mutation } from "@stackbase/executor";

/**
 * `ctx.storage` isn't (yet) part of `@stackbase/executor`'s exported `MutationCtx`/`QueryCtx`
 * shape — it's contributed at runtime by the always-on storage context provider (see
 * `packages/storage/src/context.ts`). This local structural type lets the fixture typecheck
 * cleanly while calling the real facade the engine injects.
 */
type UploadTarget = { kind: "proxied" | "presigned"; url: string; method: string; headers?: Record<string, string> };
type StorageWriter = {
  generateUploadUrl(opts?: {
    contentType?: string;
    visibility?: "private" | "public";
  }): Promise<{ storageId: string; target: UploadTarget }>;
  getUrl(id: string): Promise<string | null>;
  getMetadata(id: string): Promise<{ size: number | null; contentType: string | null; sha256: string | null } | null>;
  delete(id: string): Promise<void>;
};
function storageOf(ctx: unknown): StorageWriter {
  return (ctx as { storage: StorageWriter }).storage;
}

/** Mint an upload target for a new file (proxied on FS, presigned on S3). */
export const createUpload = mutation({
  handler: (ctx, { contentType, visibility }: { contentType?: string; visibility?: "private" | "public" }) =>
    storageOf(ctx).generateUploadUrl({ contentType, visibility }),
});

/** Persist a confirmed upload's `Id<"_storage">` into a user `files` row. */
export const save = mutation({
  handler: (ctx, { name, storageId }: { name: string; storageId: string }) =>
    ctx.db.insert("files", { name, image: storageId }),
});

/** Every `files` row — the live subscription target that proves reactive fan-out. */
export const list = query({
  handler: async (ctx) =>
    (await ctx.db.query("files", "by_creation").collect()).map((d) => ({ name: d.name, image: d.image })),
});

/** Resolve a storage id to its (possibly token-signed) download url. */
export const getUrl = query({
  handler: (ctx, { id }: { id: string }) => storageOf(ctx).getUrl(id),
});

/** The `_storage` metadata for an id — `null` once the row is gone (reaped/deleted). */
export const getMeta = query({
  handler: (ctx, { id }: { id: string }) => storageOf(ctx).getMetadata(id),
});

/** Tombstone a stored file (blob reclaimed asynchronously by the reaper). Returns `null` — a
 * mutation's return value must be JSON-encodable, and `delete` resolves `void`/undefined. */
export const remove = mutation({
  handler: async (ctx, { id }: { id: string }) => {
    await storageOf(ctx).delete(id);
    return null;
  },
});
