# Slice 4 — File storage — Design Spec

**Date:** 2025-07-31
**Status:** Approved design — ready for implementation plan
**Build-order slice:** 4 (the last un-started numbered slice; 1–3, 5, 6 all shipped)

## 1. Goal

Give Stackbase apps **file storage** with Convex-parity DX and a pluggable byte backend that spans the whole deployment spectrum: an indie hacker gets zero-config local-disk storage, and a scaling company gets client→bucket→CDN with **no application-code change** — only a config switch. Files are first-class typed references (`Id<"_storage">`) woven into the reactive data model, byte I/O never blocks the transaction, and the same `ctx.storage` API works whether bytes flow through the server (proxied) or directly to an S3/R2 bucket (presigned).

This applies the project's north star — *lightweight by default, scalable on demand, same app code* — to bytes, using the exact decomposition that made SQLite→Postgres (slice 6c) a bounded slice: one narrow seam + a local-first core default + a cloud adapter behind the same interface.

## 2. Background & what already exists

- A `BlobStore` seam and `ctx.storage` were **reserved at the doc level** (`docs/enduser/configure/configuration.md`) but never built — phantom packages `@stackbase/blobstore-{bun-fs,bun-s3,cf-r2}` and a four-method interface. This slice supersedes that reserved sketch with a fuller design (see the research in `docs/dev/research/file-storage/`).
- The engine already provides every seam this slice hooks: **context providers** (how `ctx.scheduler` is injected — `packages/executor` `ContextProvider`, wired in `packages/runtime-embedded`), the **recurring `Driver` seam** (`onCommit`/`setTimer`, woken by the commit fan-out — used by `components/scheduler`), **codegen** of `Id<TableName>` + system tables (`packages/codegen`), the **HTTP router** with `/api/*` reserved for the engine (`server.setRoutes`/`ResolvedRoute`), and the **action-vs-mutation syscall split** (actions have native capabilities and no `ctx.db`; mutations get the JSON `ctx.db` channel). File storage reuses these unchanged.

## 3. Decision: core built-in, byte backends as adapter packages

Two locked structural decisions (see the brainstorm):

1. **File storage is a core engine feature, not a component.** `Id<"_storage">` is a first-class field type in *user* schemas (`v.id("_storage")` on a `messages` table, stored/queried/joined). Our component system deliberately isolates each component's tables in their own `table_id` namespace, so a `_storage` table hidden in a component namespace could not be the target of `v.id("_storage")` without breaking that isolation. So `_storage` is an **app-namespace system table** and `ctx.storage` is **built-in and always-on** — the exact line Convex draws (storage built-in; R2/S3 are components layered on top). Future add-ons (image transforms, external-CDN backends) are where `components/` fits.

2. **Byte backends are adapter packages behind the seam, not subpaths and not components.** `packages/blobstore-s3` pulls an S3 SDK; making it a subpath of `packages/blobstore` would force that dependency on every FS-only self-host deploy and every `stackbase build` single binary. Separate packages install only the adapter you use — identical reasoning to `docstore-postgres` (pulls `pg`) being separate from `docstore`/`docstore-sqlite`.

## 4. Architecture

### 4.1 Packages

```
packages/blobstore/      # the BlobStore seam + shared types (thin, dependency-light)
packages/blobstore-fs/   # local-filesystem adapter — the zero-config default
packages/blobstore-s3/   # S3/R2 adapter (S3-compatible; covers AWS S3 + Cloudflare R2 + MinIO)
packages/storage/        # the file-storage FEATURE: _storage table def, ctx.storage context
                         # provider, upload/serve/confirm HTTP handlers, the reaper driver
```

`packages/storage` provides `{ systemTable, contextProvider, driver, httpRoutes }` that engine boot installs **unconditionally** (given the configured `BlobStore`) — reusing the same driver/context/route/system-table seams the opt-in components use, but wired by core rather than read from `stackbase.config.ts`.

### 4.2 The `BlobStore` seam (abstracts the byte *path*, not just the store)

```ts
export type UploadTarget =
  | { kind: "proxied"; url: string; method: "POST"; headers?: Record<string, string> }
  | { kind: "presigned"; url: string; method: "PUT"; headers?: Record<string, string> };

export interface StoredBlob { size: number; sha256: string | null }

export interface BlobStore {
  /** How should THIS client upload to `key`? FS → always "proxied"; S3 → "presigned" by default. */
  createUploadTarget(key: string, opts: { contentType?: string; expiresInMs: number; now: number }): Promise<UploadTarget>;
  /** Server-proxied / action-generated write. Computes sha256 while streaming. */
  store(key: string, bytes: ReadableStream | Uint8Array, opts?: { contentType?: string }): Promise<StoredBlob>;
  /** After a presigned direct upload: verify the object exists and read its size (sha256 best-effort → may be null). */
  finalizeUpload(key: string): Promise<StoredBlob | null>;
  /** Byte read for serving / action `get`. `range` supports HTTP Range. */
  read(key: string, range?: { start: number; end?: number }): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  /** A freshly-signed, expiring GET url (S3 presigned GET). `now` fed for determinism. Null if unsupported. */
  signGetUrl(key: string, opts: { expiresInMs: number; now: number }): string | null;
  /** A stable public/CDN url for a public object, or null if the backend has none (FS). */
  publicUrl(key: string): string | null;
}
```

`FsBlobStore`: `createUploadTarget` → always `proxied`; `signGetUrl`/`publicUrl` → null (FS serves via our endpoint). `S3BlobStore`: `createUploadTarget` → `presigned` PUT; `signGetUrl` → presigned GET; `publicUrl` → the bucket/CDN url when a public base is configured. A shared **BlobStore conformance suite** (mirroring the DocStore one) pins behavior for both.

### 4.3 The `_storage` system table + `Id<"_storage">`

A stored file is a row in a built-in **app-namespace system table `_storage`** (reserved table number in `id-codec`, emitted into the app's `DataModel` by codegen so `Id<"_storage">` and `v.id("_storage")` resolve like any table id):

```
_storage: {
  _id: Id<"_storage">;
  _creationTime: number;
  status: "pending" | "ready";     // pending until bytes are confirmed; see §5
  key: string;                     // internal physical backend key (not exposed to app code)
  size: number | null;            // known once ready
  contentType: string | null;
  sha256: string | null;          // computed on proxied writes; null on the direct path (§5)
  visibility: "private" | "public"; // private by default (§6)
  expiresAt: number | null;        // for pending rows: reap deadline (§7)
}
```

A **pending row is created at `generateUploadUrl` time** (not on completion) so unconfirmed/failed uploads are table-visible for the reaper (§7). `key` is engine-generated (`<uuid>` under a namespace); app code never sees it — only `Id<"_storage">`.

### 4.4 `ctx.storage` API, tiered by determinism

`ctx.storage` is added by `packages/storage`'s context provider (exactly as `ctx.scheduler` is). The tiering rides the existing action-vs-mutation split:

| Callable in | Method | Mechanism |
|---|---|---|
| query / mutation | `getUrl(id, opts?)`, `getMetadata(id)` | `ctx.db` syscall (row read) — deterministic |
| mutation | `generateUploadUrl(opts?)`, `delete(id)` | `ctx.db` syscall (row write) — deterministic (§4.5) |
| **action only** | `store(bytes, opts)`, `get(id)` | **native** BlobStore call (bytes are not JSON-serializable) |

Byte I/O (`store`/`get`) cannot cross the JSON syscall channel, so it lives only on the **action context** (which already has native capabilities and no `ctx.db`) — the same structural boundary that gates `fetch`. Metadata ops are ordinary row reads/writes through `ctx.db`, so they inherit reactivity, OCC, and authz for free.

### 4.5 Determinism: `generateUploadUrl` stays a mutation

`generateUploadUrl` mints a signed upload target with an expiry, yet remains a **deterministic mutation** because Stackbase mutations see "now" as the fixed **transaction timestamp**: `expiresAt = txTime + TTL`, and the signature is a pure function of `(payload, key)`. The `BlobStore.createUploadTarget`/`signGetUrl` methods take `now` explicitly so the adapter signs against the transaction clock, not wall-clock — keeping replay identical. (This is Convex's approach.) **Fallback:** if a backend's presign cannot be fed a deterministic timestamp (e.g. the S3 SDK reads wall-clock internally — verified during implementation), that backend's `generateUploadUrl` degrades to **action tier** instead; the FS/proxied path always remains a mutation. The app-facing shape is unaffected either way (the client calls `ctx.storage.generateUploadUrl` and awaits a target).

### 4.6 Backend selection

`boot.ts` gains `makeBlobStore(opts)` alongside `makeStore`: default `FsBlobStore` rooted at `<data-dir>/storage`; `S3BlobStore` when S3 config is present (`--storage-bucket`/`STACKBASE_STORAGE_BUCKET` + endpoint/region/credentials via standard env, optional `STACKBASE_STORAGE_PUBLIC_URL` for the CDN base). Threaded through `bootLoaded`/`bootProject` into the engine, exactly parallel to the DocStore backend selection. FS is the zero-config default.

## 5. Upload flows (both paths; the confirm step)

**Proxied** (FS always; S3 optional / small files):
1. `generateUploadUrl()` (mutation) → creates a `pending` `_storage` row, returns `{ id, target: { kind: "proxied", url: "/api/storage/upload?token=…" } }`. The token is a signed capability (txTime expiry) naming the `key` + `id`.
2. Client `POST`s bytes to the reserved endpoint → the handler validates the token, `store()`s the bytes (computing `sha256`), and flips the row to `ready` (size/sha256/contentType).
3. Done — the `Id<"_storage">` is now referenceable. No orphan window (bytes and the ready-commit happen server-side together).

**Presigned direct** (S3, the scale path):
1. `generateUploadUrl()` → `pending` row + `{ id, target: { kind: "presigned", url: "<bucket PUT url>", … } }`.
2. Client `PUT`s bytes **straight to the bucket** (our server never sees them).
3. The client SDK's upload helper calls the reserved **confirm endpoint** (`POST /api/storage/confirm` with the `id` + token, symmetric with the upload and serve endpoints) → the handler `finalizeUpload(key)`s (HEAD the object, verify existence + size) and flips the row to `ready` via an internal mutation. `sha256` is **best-effort → `null`** here (we never saw the bytes; S3's ETag is MD5/multipart-dependent, not worth faking). Audit-only, no dedup in v1. (`confirm` is an SDK/endpoint mechanism, not an app-facing `ctx.storage` method.)

Either way, the `ready` commit is an ordinary transaction that **fans out reactively** — a live `useQuery` over "my files" updates the instant an upload completes.

## 6. Serving, access control, CDN

`getUrl(id)` returns a **stable** url (deterministic — same id → same string), never a fresh-signed one, so it is safe to call in queries:
- **Private file (default)** → `/api/storage/:id` (our serve endpoint).
- **Public file** (`visibility: "public"`) → the backend `publicUrl(key)` (bucket/CDN url) when available, else our endpoint.

The **serve endpoint** (`GET /api/storage/:id`, an engine-reserved httpAction — non-deterministic context) does the per-request work: it checks **authz** (reusing the `authz` component's effective-permissions against the `_storage` row — file authorization is the *same* engine as row authorization), then either streams the bytes via `BlobStore.read()` (FS, with **HTTP Range** support for media seeking) or `302`-redirects to a freshly-`signGetUrl`'d bucket GET (S3). Public files skip the auth round-trip and are CDN-cacheable; per-identity private serving trades cacheability for authorization (the Supabase lesson).

**Secure by default:** files are `private` unless explicitly made `public` — diverging from Convex's public-bearer-by-default. If the `authz` component is not composed, private serving falls back to the signed-capability token model (unguessable, expiring), so access control degrades gracefully rather than failing open.

## 7. Failure, orphans, GC (the reaper)

Because metadata commits only after bytes land, **a mid-upload failure never leaves a dangling `Id<"_storage">`** in user data. Residue is handled by a **built-in reaper driver** (the `Driver` seam — `onCommit` + a wall-clock `setTimer`, like the scheduler's driver, but wired by core so it needs no composed component):
- A `pending` row past `expiresAt` → delete the row **and** best-effort `BlobStore.delete(key)` (reaps abandoned direct-upload bucket objects).
- `ctx.storage.delete(id)` (mutation) tombstones the `_storage` row transactionally; the physical blob is reclaimed **asynchronously** by the reaper (byte deletion is I/O and cannot run inside the transactor).

Retry semantics for v1: single-shot uploads are **retryable from scratch** (re-request an upload URL). Resume-from-offset is a deferred capability (§10).

## 8. Error handling

- **No backend / unwritable FS dir** at boot → fail fast with a clear operator message (never silent).
- **Upload token invalid/expired** → 401/403 at the endpoint; the pending row is left for the reaper.
- **`confirm` before bytes exist** (client lied / upload failed) → `finalizeUpload` returns null → the endpoint errors and the row stays `pending` (reaped later).
- **Byte read of a missing/`pending` object** → serve endpoint 404.
- **S3 errors** (network, auth, missing bucket) propagate as thrown errors from the adapter, surfaced at the action/endpoint boundary — the transactor is never involved in byte I/O, so a bucket outage can't wedge a transaction.

## 9. Testing

- **Shared `BlobStore` conformance suite** (like the DocStore one), run against FS (hermetic temp dir) and S3 (against MinIO).
- **The ship gate — a MinIO container E2E** (`packages/cli/test/storage-e2e.test.ts`), mirroring the Postgres `postgres:16` proof: bring up a `minio` container, run `stackbase serve` with S3 config against it, and assert through the **real server**: proxied upload → `ready` + reactive fan-out to a pre-opened WS subscription; **presigned direct upload → `confirm` → serve**; `Id<"_storage">` stored in a user doc and read back via a live query; private serve enforces authz; **orphan reap** deletes an unconfirmed pending upload's bucket object; delete reclaims the blob.
- FS gets an equivalent hermetic end-to-end run through the real server (no container).

## 10. Scope

**In scope (slice 4):** the `blobstore` seam + `blobstore-fs` (default) + `blobstore-s3` (S3/R2/MinIO); `packages/storage` (the `_storage` system table, `ctx.storage`, upload/serve/confirm reserved endpoints, the reaper driver); codegen for `Id<"_storage">`; backend selection in `boot.ts`; both upload paths (proxied + presigned-direct) with the confirm step; private-by-default serving with authz reuse + signed/expiring urls + public opt-in + Range support; orphan reaping; dashboard browse of `_storage`; the shared conformance suite + the MinIO container E2E ship gate; end-user docs.

**Out of scope / deferred:** TUS/multipart **resumable uploads** for very large files (v1 = single-shot, up to the backend's single-PUT limit); image **transforms/thumbnails** (a component on top of `getUrl`); content-addressed **dedup** (upgrade `sha256` audit → refcounted); additional backends (Azure Blob, GCS) behind the same seam; a full S3-compatible *server* endpoint.

## 11. Success criteria

1. An app stores a file and references it as `Id<"_storage">` in a user document; a live `useQuery` sees the reference the instant the upload commits; `getUrl` serves the bytes with authz enforced.
2. The **same app code** works on FS (zero-config) and on S3 (config switch) — proven by the shared conformance suite passing on both and the MinIO E2E.
3. **Presigned direct-to-bucket upload** works end-to-end (bytes never transit the server), confirmed and served, through the real `stackbase serve`.
4. A failed/abandoned upload is reaped (no orphan bytes, no dangling reference).
5. Byte I/O never blocks or wedges the transactor; `ctx.storage` byte ops are action-only, metadata ops are reactive.
6. `bun run build`/`typecheck`/`test` green; no blobstore/S3 specifics leak outside `packages/blobstore*` (the engine never learns which byte backend it's on); the S3 SDK is not a dependency of an FS-only build.

## 12. Resolved design questions (from the research §9)

1. **sha256 on the direct path** → best-effort, **`null`** in v1 (audit-only; no dedup).
2. **Confirm step** → explicit client `confirm(id)` for the **direct** path only; proxied uploads self-confirm server-side.
3. **Orphan reap** → a **built-in reaper driver** (core-wired, not the opt-in scheduler); TTL via the pending row's `expiresAt`.
4. **`getUrl` default** → **private + our serve endpoint** (secure by default); `public` opt-in returns a stable CDN url.
5. **Blob delete** → metadata tombstone is transactional; **physical delete is async** via the reaper.
6. **Single-PUT ceiling → multipart/TUS boundary** → v1 single-shot up to the backend limit; resumable is the deferral line.
7. **Range/streaming** → **full Range** on the FS serve endpoint; S3 serving delegates ranges to the bucket/CDN.
8. **S3 adapter in slice 4** → **yes**, with the MinIO container E2E as the ship gate.
9. **Who chooses the upload path** → the **backend's native default** (FS proxied, S3 presigned); the client upload helper handles either `UploadTarget.kind` transparently. An explicit `prefer`/policy override is deferred (v1.1).
