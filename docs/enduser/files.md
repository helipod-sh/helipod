---
title: File Storage
---

# File Storage

> Upload, reference, and serve files — same app code on local disk or S3-compatible object storage.

File storage is an **always-on core feature** — there's nothing to opt into in `stackbase.config.ts`.
Every project gets a reserved `_storage` system table and a `ctx.storage` facade in every
query/mutation/action. Bytes live in a separate `BlobStore` backend: the local filesystem by
default (zero-config), or any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, …) when you point
the server at one. Your function code is identical either way.

## How it fits together

- **`_storage`** is a built-in system table — it holds metadata (`status`, `size`,
  `contentType`, `sha256`, `visibility`) for every uploaded file, keyed by its document id.
- **`Id<"_storage">`** is a first-class id type: put one in a `v.id("_storage")` schema field and it
  behaves like any other document reference, including participating in reactivity — a query that
  reads a document with a stored file id re-runs when that row (or the referenced `_storage` row)
  changes.
- **Uploads are two-phase.** A mutation calls `ctx.storage.generateUploadUrl()` to mint a *pending*
  `_storage` row and an upload target; the client then uploads the actual bytes directly (either
  through the engine or straight to the bucket); the row only flips to `ready` once the upload is
  confirmed. An abandoned upload's row expires and is swept by a background reaper — it never leaks
  storage forever.
- **Byte I/O only happens in actions.** `ctx.storage.store()`/`get()` read/write actual bytes and are
  non-deterministic (network I/O), so — like `fetch` — they're only available in `action`s, never in
  queries/mutations. `getUrl()`/`getMetadata()`/`delete()` are metadata-only and work in queries and
  mutations too.

## Uploading a file

### 1. Mint an upload URL from a mutation

```ts
// convex/files.ts
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createUpload = mutation({
  args: { contentType: v.optional(v.string()) },
  handler: async (ctx, { contentType }) => {
    return await ctx.storage.generateUploadUrl({ contentType });
  },
});
```

This returns:

```ts
{
  storageId: string;              // the new (pending) Id<"_storage">
  target:
    | { kind: "proxied"; url: string; method: "POST"; headers?: Record<string, string> }
    | {
        kind: "presigned";
        url: string;               // a direct PUT straight to the bucket
        method: "PUT";
        headers?: Record<string, string>;
        confirmUrl: string;        // POST here after the PUT to finalize the row
      };
}
```

Which `target.kind` you get depends on the **backend**, not your code: the local filesystem backend
returns `"proxied"` (the engine receives the bytes itself and finalizes in the same request); an S3
backend returns `"presigned"` (the client PUTs straight to the bucket — the bytes never pass through
your server — then must separately confirm). Write the client to handle both:

### 2. Upload from the client

```ts
async function uploadFile(baseUrl: string, file: Blob, contentType: string) {
  const { storageId, target } = await client.mutation(api.files.createUpload, { contentType });

  if (target.kind === "proxied") {
    // Bytes go straight to our own endpoint, which finalizes the row in the same request.
    await fetch(new URL(target.url, baseUrl), {
      method: target.method,
      headers: { "content-type": contentType, ...target.headers },
      body: file,
    });
  } else {
    // Direct-to-bucket PUT (never touches our server), then a separate confirm call to flip
    // the `_storage` row to "ready".
    await fetch(target.url, {
      method: target.method,
      headers: { "content-type": contentType, ...target.headers },
      body: file,
    });
    await fetch(new URL(target.confirmUrl, baseUrl), { method: "POST" });
  }

  return storageId; // an Id<"_storage"> — store this in your own document
}
```

Both branches end with the same result: a `ready` `_storage` row you can now reference.

### 3. Store the id in a document

```ts
// convex/schema.ts
import { v, defineSchema, defineTable } from "convex/values";

export default defineSchema({
  photos: defineTable({
    caption: v.string(),
    image: v.id("_storage"),
  }),
});
```

```ts
// convex/files.ts
export const savePhoto = mutation({
  args: { caption: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { caption, storageId }) => {
    return await ctx.db.insert("photos", { caption, image: storageId });
  },
});
```

## Reading files

`getUrl` and `getMetadata` work in both queries and mutations (they're metadata reads, not byte
I/O):

```ts
export const photoUrl = query({
  args: { id: v.id("_storage") },
  handler: async (ctx, { id }) => await ctx.storage.getUrl(id),
});

export const photoMeta = query({
  args: { id: v.id("_storage") },
  handler: async (ctx, { id }) =>
    await ctx.storage.getMetadata(id), // { size, contentType, sha256 } | null
});
```

`getUrl` returns `null` for an id that doesn't exist, or one whose upload was never confirmed and
has since expired (a deleted file, or an abandoned upload past its TTL). An in-flight upload that
hasn't expired yet is not treated as absent.
Otherwise it returns a URL the client can `fetch`/render directly — see [Access control](#access-control-private-by-default)
below for what that URL actually carries.

### Byte I/O from actions

Only `action`s can touch actual bytes:

```ts
import { action } from "./_generated/server";

export const resizeAndStore = action({
  args: { id: v.id("_storage") },
  handler: async (ctx, { id }) => {
    const stream = await ctx.storage.get(id); // ReadableStream<Uint8Array> | null
    // ... process `stream` ...
    const newId = await ctx.storage.store(processedBytes, { contentType: "image/png" });
    return newId;
  },
});
```

`ctx.storage.store(bytes, opts?)` takes a `Uint8Array` or `ReadableStream<Uint8Array>` and returns a
new, already-`ready` `Id<"_storage">` in one call — there's no separate confirm step here, since the
action already has the whole blob in hand. `getUrl`/`getMetadata` are also available from actions,
with the same signatures as in queries/mutations.

### Deleting a file

```ts
export const removePhoto = mutation({
  args: { id: v.id("_storage") },
  handler: async (ctx, { id }) => {
    await ctx.storage.delete(id);
  },
});
```

`delete` is transactional and reactive like any other write — it tombstones the `_storage` row
immediately (so `getUrl`/`getMetadata` return `null` right away). The underlying bytes are reclaimed
asynchronously by a background reaper shortly after, since actual byte I/O can't run inside a
transaction.

## Access control: private by default

Every file has a `visibility`, set at upload time (`generateUploadUrl({ visibility: "public" })` or
`store(bytes, { visibility: "public" })`) and defaulting to `"private"`.

- **`"public"`** files are served at a stable URL (the bucket's own public/CDN URL on S3, or the
  engine's own `/api/storage/:id` endpoint on the filesystem backend) — anyone with the URL can
  fetch them, no token required. Use this for content that's meant to be world-readable (a public
  avatar, a marketing asset).
- **`"private"`** files (the default) are **not** served on a bare URL. `getUrl()` returns a URL with
  a signed, expiring **capability token** appended — an HMAC over the file id and an expiry,
  signed with the deployment's admin key. Anyone holding that URL can fetch the bytes until it
  expires (bearer semantics, the same model Convex's file storage uses) — there is no per-user or
  per-role check on top of it today. Treat a private file's URL like a signed download link: safe to
  hand to the user it's meant for, not safe to log publicly or embed in a page anyone can view
  source on.

> **Not yet built:** per-user/per-role authorization on file reads (e.g. "only the uploading user or
> their team can read this file"). The serve endpoint has an internal `checkRead` seam reserved for
> this, but it isn't wired to anything yet — every deployment falls back to the bearer-token model
> described above. If your app needs finer-grained file permissions than "anyone with the link,
> until it expires," don't rely on this yet; put access-sensitive files behind your own
> application-level check before handing out the URL, or wait for that seam to land.

## Backend configuration

Bytes are stored through a small pluggable `BlobStore` seam — the same "engine never learns which
backend it's on" story as the `DocStore` seam for SQLite/Postgres (see `CLAUDE.md`). Two adapters
ship:

- **`@stackbase/blobstore-fs`** — the **zero-config default**: files land under `<data-dir>/storage`
  alongside your SQLite (or Postgres-adjacent) data. Nothing needs to be set to use it.
- **`@stackbase/blobstore-s3`** — any S3-compatible bucket (AWS S3, MinIO, Cloudflare R2, …).

You never import either package directly — the CLI selects one for you at boot based on whether a
bucket is configured. To switch to S3, set a bucket via flag or environment variable:

```bash
stackbase serve --storage-bucket my-app-uploads --storage-endpoint https://s3.us-east-1.amazonaws.com
# or
STACKBASE_STORAGE_BUCKET=my-app-uploads stackbase serve
```

| Flag | Env var | Notes |
|---|---|---|
| `--storage-bucket` | `STACKBASE_STORAGE_BUCKET` | Required to select the S3 backend. Unset → filesystem default. |
| `--storage-endpoint` | `STACKBASE_STORAGE_ENDPOINT` | S3-compatible endpoint URL (MinIO, R2, a non-default AWS region endpoint, …). Omit for real AWS S3 with a standard region. |
| — | `STACKBASE_STORAGE_REGION` | Bucket region. |
| — | `STACKBASE_STORAGE_PUBLIC_URL` | Base URL for `"public"` files (e.g. a CDN domain in front of the bucket). Omit to let `getUrl` fall back to signed bucket URLs. |
| — | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Standard AWS-style credentials — used for MinIO/R2 too. |

Flags win over environment variables if both are set (same convention as `--database-url` /
`STACKBASE_DATABASE_URL`). If you set `STACKBASE_STORAGE_ENDPOINT`/`REGION`/`PUBLIC_URL` but forget
`STACKBASE_STORAGE_BUCKET`, the server logs a warning and silently falls back to the filesystem
backend rather than failing — the bucket is the single switch between the two backends.

On the filesystem backend, `serve`/`dev` fail fast at boot if the storage directory can't be
created or written to (a read-only mount, wrong ownership) — this surfaces immediately as a clear
error, not as a mysterious failure on the first upload.

## Related

- [Docker Self-Hosting](/self-hosting) — the `--database-url`/`STACKBASE_DATABASE_URL` story for
  Postgres follows the same "flags win over env, unset falls back to the zero-config default"
  pattern as the storage flags above.
- The repo `CLAUDE.md` has the full file-storage architecture note (the `BlobStore` seam, the
  two-phase upload/confirm design, the orphan reaper) under "What works".
