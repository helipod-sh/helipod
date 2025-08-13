---
title: File Storage — Research Synthesis (slice 4)
status: research
---

# File Storage — Research Synthesis

> Researched 2025-07-31, ahead of designing **slice 4 (file storage)**. This is the index +
> cross-system synthesis; the per-system deep dives are the sibling files in this directory.
> Nothing here is a locked decision — it is the input to the slice-4 brainstorm/spec. Clean-room
> throughout: concepts and public API shapes only, no proprietary/FSL source copied.

## The research set

| File | Covers |
|------|--------|
| [convex.md](convex.md) | Convex's **built-in** file storage — the upload-URL pattern, `Id<"_storage">` references, `ctx.storage`, the storage-outside-the-transaction model |
| [convex-components.md](convex-components.md) | Convex's file-storage **component ecosystem** — convex-fs, cloudflare-r2, files-control, hasoo/convex-s3 — and the core-vs-component decomposition |
| [pocketbase.md](pocketbase.md) | **PocketBase** — our closest self-host peer: local-FS default, server-proxied upload, on-the-fly thumbnails, protected-file tokens |
| [supabase.md](supabase.md) | **Supabase Storage** — buckets, **RLS-style file authz**, TUS resumable uploads, signed URLs, image transforms, S3-compat |
| [concave-lunora.md](concave-lunora.md) | **concave** (our direct ancestor) + **lunora** (Cloudflare-native), and Stackbase's **already-reserved `BlobStore` design** |

## 1. The one pattern everyone converges on: two-phase upload, bytes outside the transaction

Every reactive/transactional system in the set (Convex, concave, lunora, Supabase) separates **blob bytes** from **the transaction**:

1. A function (mutation or action) mints a **short-lived upload URL** (or a signed direct-to-bucket PUT).
2. The client uploads the raw bytes to a **stateless byte endpoint** — *not* through the transactional function path.
3. A **separate, small transaction** records the file's **metadata** and returns a **storage id**.

Convex's own Rust source comments the reason: holding a transaction open across a slow, unbounded upload is an **OCC risk**. This is not a stylistic choice — it is forced by the same single-writer/OCC model Stackbase already runs. **PocketBase is the lone exception** (it proxies every byte through the API as multipart form data) — simpler for pure self-host, but it has no OCC transactor to protect, and it ties files to record fields rather than a reactive metadata table.

**For Stackbase this is essentially decided by our own architecture:** blob I/O cannot live inside a deterministic query/mutation. It must be an **action-only** capability (byte writes) plus a stateless upload endpoint, with only the **metadata row** touching the transactor.

## 2. Metadata-as-documents + `Id<"_storage">` references (the model to adopt)

Convex and concave both represent a stored file as a **row in a `_storage` system table** (fields: `sha256`, `size`, `contentType`, `_creationTime`), and expose the file to app code as a **first-class `Id<"_storage">` value** stored in ordinary user documents like any other foreign key. Only the storage primitives touch bytes; everything else manipulates the reference.

Why this is the right model for Stackbase specifically:
- The `_storage` metadata row is an **ordinary document** → it participates in our **read-set / range-precise invalidation** for free. A live `useQuery` over "my files" re-pushes the instant an upload commits.
- It participates in our **authz** model for free (see §4).
- Our existing **`_admin:browseTable`** dashboard machinery extends to it with no new plumbing.

**This is exactly what the reserved `BlobStore` design is missing** (see §5): the reserved interface has `store/get/delete/getUrl` but **no `_storage` table and no `ctx.storage` runtime API**. PocketBase's field-embedded files are the anti-pattern — a filesystem side-channel the realtime layer can't see.

## 3. Backend abstraction: one seam, local-FS default, cloud as swappable adapters

The self-host peers all put bytes behind **one pluggable backend with a zero-config local-disk default**, swappable for S3-compatible object storage (PocketBase: instance-wide config switch; Supabase `storage-api`: S3-or-local adapter; concave: the reserved `BlobStore` seam).

**Convex's own ecosystem shows the mistake to avoid:** built-in `ctx.storage` has *no adapter seam at all*, and its three backend components (convex-fs, r2, hasoo-s3) are **three unrelated APIs**, not implementations of one interface — so switching providers means rewriting app storage code. Stackbase already solved this correctly for the database (`DocStore` seam → SQLite core + Postgres adapter). **File storage should mirror it exactly:** one `BlobStore` interface, a local-FS core default, S3/R2 as adapters implementing the *same* interface.

## 4. Access control: reuse `authz`, don't invent a file ACL

The standout idea from Supabase is **RLS-style file authorization** — file access expressed in the *same* policy engine as row access, on the `storage.objects` metadata table. Because Stackbase models file metadata as ordinary documents (§2) and already ships an **`authz` component** (effective-permissions + range-precise invalidation), **file authorization can reuse authz directly** rather than growing a parallel ACL system. lunora independently arrived at a `storageRules` DSL; Convex punts entirely to a separate `files-control` component or a hand-rolled `httpAction`.

Serving mechanics observed, cheapest→strictest:
- **Public/unguessable URL** — Convex's non-expiring bearer URL; PocketBase's random-suffixed filename; Supabase public buckets. Fast, CDN-cacheable, but "anyone with the link."
- **Signed/expiring URL** — Supabase `createSignedUrl`, lunora signed GETs. The near-term middle ground.
- **Per-request authz check** — PocketBase protected-file `?token=`; a Stackbase `httpAction` that checks authz then streams. Strictest, least cacheable (cache-hit-rate is inversely tied to per-identity checks — a Supabase lesson worth heeding).

## 5. Stackbase's reserved design — head start + the gaps to close

`docs/enduser/configure/configuration.md` already documents a concave-derived `BlobStore` seam (a verbatim rebrand of concave's), and it mirrors the shipped `DocStore` seam:

```ts
interface BlobStore {
  store(blob, options): Promise<{ _id; sha256; size; uploadedAt }>;
  get(storageId): Promise<Blob | null>;
  delete(storageId): Promise<void>;
  getUrl(storageId): Promise<string | null>;
}
// reserved adapters: @stackbase/blobstore-{bun-fs, bun-s3, cf-r2}
```

**What the reserved design already gets right:** the seam shape, the local-FS/S3/R2 adapter split (mirrors DocStore), the `{_id, sha256, size, uploadedAt}` metadata shape.

**What it does NOT yet specify** (the slice-4 design must decide these):
1. **The `_storage` system table** — nothing reactive/transactional stores the metadata today (the biggest gap).
2. **The `ctx.storage` runtime API** — only the adapter interface is reserved; the developer-facing surface (and its determinism tiering) is undefined.
3. **The upload-URL HTTP endpoint** — concave reserved `/api/storage/upload` (POST) + `/api/storage/<id>` (GET); Stackbase has an httpRouter to host these.
4. **Access control** — none specified; §4 says reuse authz + signed URLs.
5. **sha256's role** — audit-only integrity hash vs. content-addressed dedup with refcounting. Convex does audit-only (no dedup); recommend the same for v1.
6. **Orphan GC** — Convex has none (a real gap); lunora ships orphan-detection tooling. Recommend a deferred/policy concern, not core v1.

## 6. Cross-system comparison

| Dimension | Convex (built-in) | PocketBase | Supabase | concave / lunora | → Stackbase (proposed) |
|---|---|---|---|---|---|
| File model | `_storage` table + `Id<"_storage">` | field on a record | `storage.objects` row | `_storage` table (concave) | **`_storage` table + `Id<"_storage">`** |
| Upload | upload URL → separate tx | server-proxied multipart | signed URL / TUS / S3 | signed PUT → mutation (lunora) | **upload-URL endpoint → metadata tx** |
| Byte write context | action-only | any (proxied) | any | action-only (lunora) | **action-only** (determinism) |
| Backend | none-swappable (3 APIs) | local-FS or S3 (switch) | local-disk or S3 adapter | reserved `BlobStore` seam | **one `BlobStore` seam, FS core** |
| Cloud backends | fs / r2 / s3 components | S3 config | S3-compat | -bun-s3 / -cf-r2 (reserved) | **s3 / r2 adapters (components)** |
| Access control | public bearer URL / files-control | collection rules + `?token=` | **RLS on objects** | storageRules DSL (lunora) | **reuse `authz` + signed URLs** |
| Transforms | none (core) | on-the-fly thumbnails | on-the-fly (imgproxy) | none | **deferred / component** |
| Resumable | no | no | **TUS** | no | **deferred (large-file component)** |
| Dedup | no (audit sha256) | no | no | reserved (unresolved) | **audit-only sha256 v1** |
| Orphan GC | none | deleted-with-record | — | orphan tooling (lunora) | **deferred / policy** |

## 7. Direction for the slice-4 design — **Option B (decided 2025-07-31)**

**Decision.** The `BlobStore` seam is designed for **both byte paths from day one** — server-proxied *and* presigned-direct-to-bucket — because the goal is one system spanning **indie-hacker self-host → big-company cloud scale**, the project's "lightweight by default, scalable on demand, same app code" thesis applied to bytes. The local-FS adapter is the zero-config default that works end-to-end; a cloud (S3/R2) adapter drops into the *same* seam so big files + CDN need **no rework of the app's upload/serving surface** — only a config change, exactly like SQLite→Postgres. Rejected: FS-first-with-presigned-deferred (Option A), because the presigned-direct-upload topology is a *different byte path*, not just a different backend — retrofitting it later would rework the upload endpoint and `ctx.storage` contract.

**Core (built-in, slice 4):**
- A **richer `BlobStore` seam** than the reserved four methods — one that abstracts *how a client moves bytes in and out*, so the same `ctx.storage` app API works whether bytes flow through us (FS) or direct-to-bucket (S3/R2). Sketch:
  ```ts
  interface BlobStore {
    // How should THIS client upload? proxied → POST to our endpoint; presigned → PUT straight to the bucket.
    createUploadTarget(opts): Promise<{ kind: "proxied"; endpoint } | { kind: "presigned"; url; method; headers }>;
    // Server-proxied write (FS always; S3 for small/proxied). Computes sha256 as bytes stream through.
    store(bytes, opts): Promise<StoredBlob>;
    // After a presigned direct upload: verify the object exists, read back size (+ ETag). sha256 is best-effort here.
    finalizeUpload(target): Promise<StoredBlob>;
    get(id): Promise<Blob | null>;                    // action-only byte read
    delete(id): Promise<void>;
    getUrl(id, opts?): Promise<string | null>;        // our endpoint | public bucket/CDN URL | signed GET
    getMetadata(id): Promise<BlobMetadata | null>;
  }
  ```
- A **`_storage` system table** holding metadata; `Id<"_storage">` a first-class reference in codegen (like `Id<table>`).
- A **`ctx.storage` API tiered by determinism**: `getUrl`/`getMetadata` in queries/mutations; byte `store`/`get` **action-only**.
- An **upload flow via the httpRouter** with a **confirm step** (elevated to core, because presigned direct uploads make the presigned→confirmed gap a first-class orphan window): mint target → client uploads (proxied or direct) → confirm/finalize → metadata-commit transaction (fans out reactively).
- **`@stackbase/blobstore-fs`** — the zero-config default, works end-to-end. **`@stackbase/blobstore-s3`** — proves the presigned-direct-upload path against real object storage (R2 is S3-compatible, so one adapter covers both; a container-backed E2E is the ship gate, mirroring the Postgres slice).
- **Access control** by reusing the `authz` component on `_storage` + **signed/expiring `getUrl`** for private files; **public/immutable URLs** for the CDN-cacheable path.
- **Orphan reaping** of unconfirmed/expired upload targets (a TTL sweep — first-class under B, not a deferred nicety).
- **Dashboard**: the browser extends to `_storage` via existing admin machinery.

**Deferred / later components:**
- **TUS resumable uploads** + **multipart** for very large files (beyond the single-PUT ceiling, ~5 GB on S3).
- Image transforms / thumbnails (a layer on top of `getUrl`).
- Content-addressed **dedup** (upgrade sha256 audit → refcounted).
- Additional backends (Azure Blob, GCS) behind the same seam.

**Guiding principle** (validated by every source, sharpened by Option B): **one seam that abstracts the byte *path*, not just the byte *store*** — local-first core default, cloud backends and policy layers strictly *on top*, never inside. Avoid Convex's built-in-with-no-seam mistake; adopt Supabase's authz-reuse and metadata-as-rows; keep PocketBase's zero-config local-FS ergonomics for the indie end of the spectrum.

## 8. Scalability, failure modes & CDN (the Option-B design surface)

**Two byte paths, one app API.** Scalability of big files is a property of the *backend adapter*, not the framework — the seam is what makes them interchangeable:

| | Local-FS (default) | S3 / R2 adapter |
|---|---|---|
| Byte path | client → **our server** → disk | client → **bucket directly** (bytes never touch us) |
| "Signed upload URL" | URL to *our* endpoint (proxied) | **presigned PUT** to the bucket |
| Big-file ceiling | one node's disk/bandwidth/RAM | the **bucket's** (multi-GB, parallel) |
| Serving / CDN | through our server (front with a proxy/CDN) | **bucket/CDN URL** from `getUrl` (R2 zero-egress + edge; S3+CloudFront) |
| Fits | indie / single-node self-host | scaling company |

**Enabling S3 is *additive* — both upload styles stay available; presigned is optional.** The two columns are *adapters*, not either/or upload modes. With the S3 adapter a client can still upload **proxied** (client → our server → `PutObject`) *or* **presigned direct** (client → bucket); presigned is chosen per-upload for the big/scale cases, never forced. And the **proxied path is required regardless of backend** — a server/action-generated file (a resized image, a generated PDF, an import) has no client to presign a URL *for*, so `ctx.storage.store(bytes)` in an action always writes via the SDK. The FS adapter can only answer *proxied* (no bucket to presign against); the S3 adapter answers *either*. So switching FS→S3 is strictly additive: every FS-era upload keeps working verbatim, plus direct-to-bucket unlocks. (Design-phase DX question — added as §9.9: does the client request the path explicitly, e.g. `prefer: "direct"`, or does the adapter apply a size policy?)

Note the two independent axes: **file *size*** stresses the byte path (backend's problem — solved by S3/R2 direct upload); **upload *rate*** stresses the single-writer transactor (the same Tier-0 limit as all writes — a Tier-2 sharding concern, unrelated to file size, since only a tiny metadata row commits per upload).

**Failure & retry.** Metadata is committed **only after bytes land**, so a mid-upload failure never leaves a dangling `Id<"_storage">` in user data. Retry semantics:
- **v1 plain upload** (proxied or single presigned PUT): retryable, but **retry-from-scratch**.
- **Resume-from-offset** for multi-GB files needs **TUS/multipart** (deferred) — the seam must not preclude it.
- **Residue**: a failed/abandoned upload can leave partial bytes (temp file, or an aborted S3 multipart) and, if bytes landed but confirm didn't, an **orphan** blob. Handled by the **confirm step + TTL orphan reap** (core under B). Convex ships *no* orphan GC — a gap we close.

**CDN.** `getUrl()` is the CDN lever: an S3/R2 adapter returns a **bucket/CDN URL directly** (serving scales independently of our node, edge-cached globally); the FS adapter returns a URL to our own endpoint (front the whole server with a proxy/CDN, but every miss hits the one node). **Cache-hit-rate caveat** (Supabase's lesson): *public/immutable* URLs cache well; *per-identity signed* URLs cache poorly — so private-file serving trades cacheability for authorization.

**The sha256 wrinkle Option B introduces.** With proxied writes we compute sha256 as bytes stream through us. With **presigned direct-to-bucket, the bytes never touch us**, so we cannot compute sha256 without reading the object back (defeating the point). Options: trust a client-claimed hash, use the bucket's ETag (MD5 single-part only, absent for multipart), or leave sha256 null for direct uploads. → `sha256` becomes **best-effort / optional on the direct path** (a concrete metadata-shape consequence). Also: browser direct-to-bucket uploads require **CORS** on the bucket (an operational note).

## 9. Open questions for the design phase (post-Option-B)

1. **sha256 on the direct path** — best-effort/null, client-claimed (+ verify on first read), or ETag where available? (Affects whether dedup is ever possible for cloud uploads.)
2. **Confirm step** — explicit client `confirm` mutation, a bucket event/webhook, or lazy verify-on-first-`getUrl`? (Determines the orphan window and DX.)
3. **Orphan reap** — TTL sweep of unconfirmed targets: driven by the scheduler component, or a built-in reaper? How aggressive?
4. **`getUrl` default** — public bearer URL (Convex, CDN-friendly) vs always-signed/expiring (stricter)? Per-bucket public/private flag (Supabase) as the switch?
5. **Blob delete** — synchronous with the metadata-row delete, or background GC (and how does that interact with the transactor)?
6. **Single-PUT ceiling → multipart/TUS boundary** — what max size does v1 support before "use resumable," and is that the exact deferral line?
7. **Range/streaming** on the FS serving endpoint — full ranges (trivial on disk) vs Convex's single-range (an S3 constraint)?
8. **Is the S3 adapter *in* slice 4** or an immediate fast-follow? (The *seam* is in v1 regardless; question is whether the working S3 impl + its container E2E land in the same slice or the next.)
9. **Who chooses the upload path** when both are available (S3 backend) — the client requests it explicitly (`createUploadTarget({ prefer: "direct" })`), or the adapter applies a policy (e.g. presign above a size threshold, else proxy)? (DX vs. automatic; both upload styles stay available either way.)
