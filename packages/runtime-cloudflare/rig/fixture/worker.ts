// Hand-written stand-in for what `generateWorkerEntrySource` emits (Task 7) — the static-import
// Worker/DO entry. A real `helipod build --target worker` would codegen exactly this shape from the
// app's `convex/` dir. Kept hand-written here so the deploy rig is self-contained and reviewable.
import * as messages from "./convex/messages";
import * as files from "./convex/files";
import schema from "./convex/schema";
import { HelipodDurableObject, createWorkerHandler, type DurableObjectAppConfig } from "@helipod/runtime-cloudflare";
import { R2BlobStore, type R2BucketLike } from "@helipod/blobstore-r2";
import type { LoadedProject } from "@helipod/cli/project";

const loaded: LoadedProject = { schema, modules: { messages, files } };

export class HelipodDO extends HelipodDurableObject {
  protected appConfig(env: unknown): DurableObjectAppConfig {
    const adminKey = (env as { HELIPOD_ADMIN_KEY?: string }).HELIPOD_ADMIN_KEY ?? "";
    // File storage: construct an R2-backed BlobStore from the `STORAGE_BUCKET` R2 binding (see
    // wrangler.jsonc). Guarded so a deploy without the binding degrades to byte-less rather than
    // throwing. This is exactly what `generateWorkerEntrySource({ r2BindingName: "STORAGE_BUCKET" })`
    // codegens — kept hand-written here so the rig is self-contained and reviewable.
    const bucket = (env as { STORAGE_BUCKET?: R2BucketLike }).STORAGE_BUCKET;
    // On Cloudflare, stretch the driver backstop so an idle DO isn't cold-woken every 30s.
    return {
      loaded,
      adminKey,
      backstopMs: (d) => Math.max(d, 15 * 60_000),
      ...(bucket ? { blobStore: new R2BlobStore({ bucket }) } : {}),
    };
  }
}

export default createWorkerHandler("HELIPOD_DO");
