/**
 * A real-workerd DO host that wires FILE STORAGE (`ctx.storage`) over an R2 binding, plus a small
 * component contributing a reserved OAuth-style route — the two things the DO dispatch-seam fix + the
 * R2 blob store unblock. Booted by `storage.worker.test.ts` inside a genuine Durable Object (workerd),
 * against miniflare's in-memory R2 emulation bound as `env.STORAGE_BUCKET`.
 *
 * The app exposes the file-storage surface (mint an upload target, resolve a download url, read
 * metadata) plus a user `files` table so an upload can be saved + fan out reactively. The composed
 * `authfixture` component contributes `GET /api/authfixture/oauth/*` — an httpAction reached as a
 * `componentRoute`, standing in for auth's OAuth callback, to prove component routes now dispatch on a
 * DO (audit gap 8c).
 *
 * NOT product code — a test fixture. Safe to delete with this branch's tests.
 */
import { query, mutation, httpAction } from "@stackbase/executor";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { defineComponent } from "@stackbase/component";
import type { LoadedProject } from "@stackbase/cli/project";
import { StackbaseDurableObject, type DurableObjectAppConfig } from "@stackbase/runtime-cloudflare";
import { R2BlobStore, type R2BucketLike } from "@stackbase/blobstore-r2";

// `ctx.storage` is contributed at runtime by the always-on storage provider, not part of the exported
// ctx type — a local structural type lets the fixture typecheck (mirrors the container storage fixture).
type UploadTarget = { kind: "proxied" | "presigned"; url: string; method: string; headers?: Record<string, string> };
type StorageWriter = {
  generateUploadUrl(opts?: { contentType?: string; visibility?: "private" | "public" }): Promise<{ storageId: string; target: UploadTarget }>;
  getUrl(id: string): Promise<string | null>;
  getMetadata(id: string): Promise<{ size: number | null; contentType: string | null; sha256: string | null } | null>;
};
function storageOf(ctx: unknown): StorageWriter {
  return (ctx as { storage: StorageWriter }).storage;
}

const schema = defineSchema({
  files: defineTable({ name: v.string(), image: v.string() }).index("by_creation", []),
});

const files = {
  genUpload: mutation({
    handler: (ctx, { contentType, visibility }: { contentType?: string; visibility?: "private" | "public" }) =>
      storageOf(ctx).generateUploadUrl({ ...(contentType ? { contentType } : {}), ...(visibility ? { visibility } : {}) }),
  }),
  getUrl: query({ handler: (ctx, { id }: { id: string }) => storageOf(ctx).getUrl(id) }),
  getMeta: query({ handler: (ctx, { id }: { id: string }) => storageOf(ctx).getMetadata(id) }),
  save: mutation({ handler: (ctx, { name, storageId }: { name: string; storageId: string }) => ctx.db.insert("files", { name, image: storageId }) }),
  list: query({ handler: async (ctx) => (await ctx.db.query("files", "by_creation").collect()).map((d) => ({ name: d.name, image: d.image })) }),
};

// An OAuth-callback-style component route: a GET httpAction under a reserved `/api/authfixture/oauth/`
// prefix. Stands in for `@stackbase/auth`'s external-identity callbacks (audit gap 8c).
const oauthCallback = httpAction(async (_ctx, request: Request) => {
  const url = new URL(request.url);
  return new Response(JSON.stringify({ ok: true, code: url.searchParams.get("code"), path: url.pathname }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const authfixture = defineComponent({
  name: "authfixture",
  schema: defineSchema({}),
  modules: { oauthCallback },
  httpRoutes: [{ method: "GET", pathPrefix: "/api/authfixture/oauth/", handler: "oauthCallback" }],
});

const loaded: LoadedProject = { schema, modules: { files } };

export class StorageDO extends StackbaseDurableObject {
  protected appConfig(env: unknown): DurableObjectAppConfig {
    const bucket = (env as { STORAGE_BUCKET?: R2BucketLike }).STORAGE_BUCKET;
    return {
      loaded,
      components: [authfixture],
      adminKey: "storage-admin-key",
      ...(bucket ? { blobStore: new R2BlobStore({ bucket }) } : {}),
    };
  }
}
