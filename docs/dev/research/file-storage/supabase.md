---
title: Supabase — Storage Research
status: research
---

# Supabase — Storage Research

> Researched 2025-07-31. Sources: supabase.com/docs/guides/storage/*, supabase.com/docs/reference/self-hosting-storage/*, github.com/supabase/storage. See §7 for the full list.

## 1. Data model — buckets, objects, and metadata-in-Postgres

Supabase Storage keeps file **bytes** in a backing blob store (S3, GCS, or local disk when self-hosted) but keeps **all metadata** — bucket config and every object's path, size, mime type, owner, timestamps — as ordinary rows in a dedicated Postgres schema, `storage`. This is the same "schema is the source of truth" move documented for the rest of Supabase (see `docs/dev/research/supabase.md` §2): storage is not a separate authorization domain, it's more Postgres rows.

**`storage.buckets`** (one row per bucket):
- `id` (text, PK) — the bucket identifier, also used in the URL path.
- `name` (text)
- `public` (boolean) — see §1.3.
- `owner_id` (text)
- `file_size_limit` (bigint), `allowed_mime_types` (text[]) — bucket-level upload constraints enforced server-side.
- `created_at` / `updated_at`.

**`storage.objects`** (one row per file):
- `id` (uuid, PK)
- `bucket_id` (text, FK → `buckets.id`)
- `name` (text) — the full object path *within* the bucket, e.g. `avatars/user123/photo.png`.
- `owner_id` (text) — who uploaded it; the anchor for ownership-based RLS policies.
- `metadata` (jsonb) — arbitrary attributes (size, mimetype, etc.), free-form.
- `path_tokens` (text[]) — the `name` path pre-split into segments, so a policy or query can match/filter on a specific folder level without string parsing.
- `version` (text) — an object revision identifier.
- `created_at` / `updated_at`.

**Path-based addressing.** A file's full address is `bucket/path/to/file` — the bucket ID plus a `/`-delimited logical path stored verbatim in `name`. Supabase's "buckets" are **not** real S3 buckets; they're a prefix/namespace convention layered inside one physical backing store (this matters for the S3-compat surface, §3.3, where the bucket namespace has to be synthesized rather than mapping 1:1 onto real S3 buckets).

**Public vs. private buckets.** `storage.buckets.public` is the single flag that decides the request path: a public bucket serves `GET /storage/v1/object/public/{bucket}/{path}` with **no auth check at all** (maximizing CDN cache-hit rate — no per-request authorization work means the edge can cache the response for any anonymous requester identically). A private bucket requires either an `Authorization` bearer token evaluated against RLS, or a signed URL (§4) minted by someone who already had read access. This mirrors the "read-set" thinking in Stackbase's own reactivity model: public-ness is a coarse, cheap-to-check gate that lets you skip the expensive per-request authorization path entirely.

Storage's own docs explicitly warn: treat the `storage` schema as **read-only** — don't hand-edit rows directly; the storage-api service owns writes to it and future platform versions may change the shape.

## 2. Access control — RLS policies on `storage.objects` (the standout feature)

This is the single most-imitated idea in Supabase Storage. **File authorization is written as ordinary Postgres RLS policies on `storage.objects`** — the exact same policy language, the exact same engine, the exact same `auth.uid()` / `auth.jwt()` helpers used to secure regular application tables (see `docs/dev/research/supabase.md` §5). There is no separate "storage permissions" DSL.

By default, **all operations on `storage.objects` are denied** until you write a policy — uploads, downloads, and deletes on a private bucket fail closed until an explicit `INSERT`/`SELECT`/`UPDATE`/`DELETE` policy grants them.

**Shape of a policy:**
```sql
create policy "policy_name"
on storage.objects
for insert to authenticated
with check ( <condition on bucket_id / name / owner_id / metadata> );
```

**Common patterns actually used in practice:**
- Restrict to one bucket: `bucket_id = 'avatars'`
- Folder-scoped by user id, using the path-token helper: `(storage.foldername(name))[1] = (select auth.jwt()->>'sub')` — i.e. "you may only touch objects whose first path segment is your own user id." This is the idiomatic way Supabase does per-user private folders (`private/<uid>/...`) without a separate ACL table.
- Ownership check via the `owner_id` column instead of parsing the path.
- `upsert` (overwrite-if-exists) requires **both** `INSERT` and `UPDATE`/`SELECT` grants, since an upsert is implemented as a conditional update.

**Why this is the standout idea, concretely:** because `storage.objects` is a normal RLS-governed table, a policy can **join across to application tables** — e.g. "allow read if this object's `bucket_id`/`name` corresponds to a row in `documents` that the current user has `SELECT` access to via that table's own RLS." File authorization and data authorization become the *same policy language reasoning about the same request identity*, rather than two parallel systems (file ACL service + app-level authz) that can drift out of sync. Every access path — the REST object API, the TUS resumable endpoint, the S3-compatible endpoint, and image transformation URLs — ultimately funnels through the same Postgres role + RLS check, so you author the rule once.

**Caveats (inherited from Postgres RLS generally, per the broader Supabase research doc §10):** policies are easy to get subtly wrong especially on `INSERT ... WITH CHECK`, add per-request CPU cost, and are hard to unit-test in isolation from a running Postgres. `service_role` bypasses storage RLS entirely, same as it does for table RLS — it's meant for trusted server-side code only.

## 3. Upload flows

Three upload protocols hit the same underlying buckets/objects; you can mix them per bucket or even per object without any interoperability wall.

### 3.1 Standard upload (small files, ≤ ~6 MB)
A normal `multipart/form-data` POST through the Storage REST API (or the SDK's `.upload()`), proxied by the storage-api service. Content-type is inferred from the file extension unless the caller overrides it. Recommended only up to ~6 MB — above that, Supabase's own docs steer you to resumable uploads instead of a bigger standard upload, since a single failed large POST means starting over from zero.

**Upsert semantics:** by default, uploading to an existing path 400s with "Asset Already Exists" (protecting against accidental overwrite, and against CDN staleness — an overwritten object at a cached path takes time to invalidate at every edge node, so silently allowing overwrite creates a stale-read window). Passing `upsert: true` / `x-upsert: true` allows overwrite; under concurrent uploads to the same path, upsert mode makes the **last** writer win instead of the first.

### 3.2 Resumable uploads via the TUS protocol (large files)
Supabase Storage implements **TUS** (tus.io — an open, client-agnostic resumable-upload protocol) at `https://{project}.storage.supabase.co/storage/v1/upload/resumable`. Rationale: large files over an unreliable connection need to survive a dropped connection without restarting from byte zero.

- Fixed **6 MB chunk size** (not configurable).
- A TUS upload session URL is valid for **24 hours**, after which it must be restarted.
- File size ceiling has been raised over time — Supabase's "Storage v3" announcement specifically called out **resumable uploads up to 50 GB**.
- Off-the-shelf clients: `tus-js-client`, **Uppy** (with first-class React/Vue/Svelte/Angular bindings and a progress UI), `tus-py-client`, and native support in the Kotlin SDK.
- Concurrency: only one client may write to a given upload-session URL at a time; two different clients racing the same final *path* get a 409 unless `x-upsert` is set, mirroring standard-upload semantics.
- Composes with **signed upload URLs** (§4): an authorized user can mint a presigned token and hand it to *another* client, which supplies it via the `x-signature` header on the resumable endpoint — i.e., presigned-direct-upload and resumable-upload are orthogonal and combinable.

### 3.3 S3-compatible endpoint
Supabase Storage exposes `/storage/v1/s3` implementing a practical subset of the S3 API, authenticated with real **AWS Signature v4** request signing (must be explicitly enabled per-project, and uses separate S3-style access keys, not the Supabase JWT). This lets any existing S3 tooling — `aws-cli`, `boto3`, Cyberduck, backup tools, etc. — talk to a Supabase project's storage with zero custom integration code.

- Bucket ops supported: `ListBuckets`, `HeadBucket`, `CreateBucket`, `DeleteBucket`, `GetBucketLocation`. Advanced bucket config (CORS/lifecycle/encryption at the S3-API level) is **not** implemented — those live in Supabase's own bucket config instead.
- Object ops supported: `GetObject`, `PutObject`, `DeleteObject`, `ListObjects(V2)`, `CopyObject`, plus the full **multipart upload** dance (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`AbortMultipartUpload`) — i.e., S3 clients get their own chunked-large-upload path independent of TUS.
- Explicitly **not** supported: object versioning (deletes are permanent, no undelete), server-side encryption, ACLs, object locking, tagging.
- Because "buckets" are a logical prefix inside one physical backing store rather than real S3 buckets, the S3-compat layer is a translation shim over the same `storage.objects`/`storage.buckets` rows every other protocol uses — one metadata source of truth, three wire protocols.

### 3.4 Direct-to-storage vs. proxied
Standard and TUS uploads are **proxied through the storage-api service** (which is what lets it enforce RLS, bucket size/mime constraints, and write the Postgres metadata row atomically with the backend write). The S3-compat endpoint is likewise served by storage-api, not a redirect straight to the backing S3 bucket — so even "S3-native" traffic still passes through the authorization/metadata layer rather than going direct-to-backend.

## 4. Serving — public URLs, signed URLs, signed upload URLs

- **Public URL:** `https://{project}.supabase.co/storage/v1/object/public/{bucket}/{path}` — no auth, servable straight off the CDN edge, generated client-side by `getPublicUrl()` (pure string construction, no network round-trip).
- **Signed URL (`createSignedUrl`):** server-side (or any caller who already has read access) mints a **time-limited** URL for a private object. Signed with a key **separate from the Auth JWT signing key**, specifically so that signed URLs already handed out keep working even if you rotate Auth JWT secrets — a deliberate decoupling of "capability token" from "identity token."
- **Signed upload URL (`createSignedUploadUrl`):** the presigned-direct-upload analogue — an authorized party generates a one-time upload token (default validity **2 hours**) and can hand it to an *unauthenticated* third party, who uploads without needing their own credentials or an RLS check at upload time (the check happened when the token was minted). Composable with the TUS resumable endpoint via the `x-signature` header (§3.2).
- **Download vs. render:** appending `?download` to an object URL forces a browser `Content-Disposition: attachment` (optionally `?download=customname.ext` to rename), vs. the default inline/render behavior.
- **Private-object auth-checked reads:** alternatively to a signed URL, a private object can be fetched via `GET /storage/v1/object/authenticated/{bucket}/{path}` with a bearer token evaluated against RLS per request — this is the path that gets worse CDN cache behavior (§6), since the response depends on caller identity.

## 5. Image transformations

On-the-fly resize/reformat via URL query params against a `render/image` path variant, e.g.:
```
https://{project}.supabase.co/storage/v1/render/image/public/{bucket}/{path}?width=500&height=600&quality=75
```
- `width` / `height`: 1–2500 px; if only one is given, aspect ratio is preserved by cropping the other dimension.
- `resize` mode: `cover` (default — fill + crop to preserve aspect ratio), `contain` (fit within box, preserve aspect ratio, no crop), `fill` (stretch, ignores aspect ratio).
- `quality`: 20–100, default 80.
- `format`: auto-negotiated (serves WebP to clients that accept it, to cut egress) unless `format=origin` opts out.
- Powered by **imgproxy** running as a sidecar service, not a custom Supabase image pipeline — another instance of "compose, don't build" (consistent with the broader Supabase architecture pattern, see `docs/dev/research/supabase.md` §3).
- **Fully on-the-fly, not pre-generated** — no batch/derivative-generation step; a given transform URL is computed on first request and then cached (§6) rather than precomputed at upload time.
- Limits: input image ≤ 25 MB, ≤ 50 MP; gated to paid tiers; billed per-origin-image-transformed beyond a monthly allotment (transform *result* variants aren't separately billed once cached).
- Input formats: PNG/JPEG/WebP/AVIF/GIF/ICO/SVG/HEIC/BMP/TIFF; output: all of those except HEIC (HEIC output falls back to JPEG).

## 6. CDN / caching

Storage objects (including rendered image-transform variants) sit behind a standard pull-through CDN: edge nodes cache from the project's origin region on first miss (`cf-cache-status: MISS`), then serve subsequent requests from the edge (`cf-cache-status: HIT`) — classic geographically-distributed edge caching, not a push model.

The cache-hit-rate story is directly tied to §1's public/private split: **public bucket objects cache extremely well** because the response is identical for every requester (no per-caller authorization computation blocks a cache hit). **Private bucket objects served via the authenticated-fetch path cache poorly**, because every request re-runs an RLS check keyed to caller identity, which the CDN can't safely reuse across different users even when they're requesting the byte-identical object. This is a concrete, general lesson: **coarse "is this public" checks are cheap and cacheable; per-identity authorization checks are not**, so a storage design that wants CDN-grade performance should make "public" a first-class, cheaply-checkable bit rather than relying purely on fine-grained RLS for hot paths.

Overwriting an object at an already-cached path (upsert) is explicitly called out as a stale-read risk — edge invalidation isn't instant across "over 285 cities," so Supabase's own guidance is to prefer new paths over in-place overwrite when freshness matters.

## 7. The self-host story

Supabase Storage (`supabase/storage`, formerly `storage-api`) is a **standalone Node/TypeScript service** — one process, independently deployable from the rest of the Supabase stack:

- **Metadata store:** always Postgres — the `storage` schema described in §1, migrated/owned by the storage-api service itself (docs explicitly say don't hand-edit it).
- **Byte backend:** pluggable — S3-compatible object storage (real AWS S3, or any S3-compatible provider) in production/hosted, or **local disk** for a simple self-hosted/dev deployment. This is the same "storage backend behind an interface" shape Stackbase already uses for `DatabaseAdapter` (SQLite/Postgres) — Supabase Storage applies the identical seam one layer up, for bytes instead of rows.
- **Deployment:** in the reference self-host `docker-compose` stack (see `docs/dev/research/supabase.md` §7), storage-api is one more container behind Kong, alongside an `imgproxy` sidecar for transformations; it needs network access to Postgres (for metadata + RLS evaluation, since it runs queries as a Postgres role the same way PostgREST does) and to whichever byte backend is configured (S3 endpoint/credentials, or a mounted disk path).
- It is not tied to Supabase Auth specifically — it consumes the same JWT-based identity/role convention (`anon`/`authenticated`/`service_role`) the rest of the stack uses, so any JWT issuer producing compatible claims can drive its RLS checks.

## 8. Implications for Stackbase

**The standout idea to steal: RLS-style file authorization, reusing Stackbase's own authz machinery.** Stackbase already has an `authz` component with effective-permissions + range-precise invalidation (see root `CLAUDE.md`: "activated by the authz effectivePermissions slice"). Supabase's core insight — file access rules should be expressed in the *same* authorization language as row access, evaluated by the *same* engine — maps directly onto Stackbase's architecture if file metadata (bucket/path/owner/mimetype/size) is stored as **rows in a regular Stackbase table** (a `_storage_objects`-equivalent, table-numbered like any other table) rather than as a bespoke ACL subsystem. Then:
- A query/mutation function can already express "can this identity read/write this object row" using whatever the authz component's existing permission-check primitive is — no second authorization DSL to build, test, or keep in sync.
- Because Stackbase's reactivity model is read/write-*range* based (not table-level-only), a query listing "files in bucket X visible to user Y" is a normal reactive query — it gets live updates for free when a file's metadata row changes, exactly like today's data browser. That's a capability Supabase's own polling/webhook-flavored Storage arguably doesn't cleanly have (its realtime story is the general Postgres-Changes/Broadcast mechanism from the sibling research doc, not something purpose-built for storage events).
- Concretely: file metadata is a table (`bucket`, `path`, `owner`, `size`, `mimetype`, `createdAt`, etc.); actual bytes live behind a pluggable `BlobAdapter` seam (local disk for `stackbase dev`/single-binary, S3-compatible for production self-host) — directly parallel to the existing `DatabaseAdapter` pattern, so this doesn't introduce a new kind of seam, just one more instance of a pattern Stackbase already has locked in.
- Public vs. private bucket as a coarse first-class flag (not just "whatever the RLS/authz policy happens to allow") is worth keeping as a *distinct, cheap-to-check* bit specifically for CDN cache-ability (§6) — a lesson that generalizes: don't force every read through the full permission-check path if a cheaper "is this public" short-circuit is available and correctness-preserving.

**Candidate features, triaged:**
- **Core (build first, minimal viable file storage):** buckets + object metadata as a Stackbase table; local-disk `BlobAdapter` for dev; standard upload/download through an HTTP endpoint (likely as an `httpAction`-shaped surface, since uploads are non-deterministic/binary — outside the transactional query/mutation model just like actions are); public vs private bucket flag; RLS-equivalent access control reusing the authz component rather than a new mechanism.
- **Near-term / high value, plausibly still core:** **signed URLs with expiry** (`createSignedUrl`) — cheap to implement (an HMAC-signed token + expiry check, no new infra) and unlocks private-file sharing without proxying every read through the authz check; a straightforward S3-adapter-backed `BlobAdapter` for production self-host (mirrors the S3/local-disk split Supabase itself does).
- **Component (opt-in, like `@stackbase/scheduler`/`@stackbase/workflow`), not core:** **resumable/TUS uploads** — real value for large files but is a whole protocol implementation (chunking, session state, resumption) that most apps' MVPs don't need on day one; ship it as an add-on once core storage is proven, the same way scheduler/workflow were sequenced after the reactive core. **Image transformations** likewise — valuable but pulls in an external transform dependency (imgproxy-equivalent or a native resize lib) and is cleanly separable behind a `render/image` URL convention layered on top of core storage; defer to a component or a later slice, not core storage.
- **Deferred / likely skip for v1:** the **S3-compatible endpoint** — high engineering cost (SigV4 verification, multipart-upload emulation, S3 API surface) for a self-hostable BaaS whose primary users are unlikely to be pointing existing S3 tooling at it; revisit only if there's concrete demand for "drop-in S3 client compatibility." Signed **upload** URLs (presigned direct upload) are worth deferring slightly behind signed *download* URLs — same mechanism, but only needed once untrusted/anonymous direct uploads are a real use case.
