---
title: PocketBase — File Storage Research
status: research
---

# PocketBase — File Storage Research

> Researched 2025-07-31. Sources: pocketbase.io/docs/files-handling/, pocketbase.io/docs/api-files/, pocketbase.io/docs/api-rules-and-filters/, pocketbase.io/docs/collections/, plus the general architecture note at `docs/dev/research/pocketbase.md` (section 6, "Auth & files") which this document extends with file-storage-only depth.

## 1. Data model — files are a field type, not a separate abstraction

PocketBase has **no standalone "storage" object or bucket concept visible to the schema**. Instead, a `file` field is one of the ordinary field types you attach to a collection (alongside `text`, `number`, `relation`, `select`, `json`, etc.), exactly like any other column.

- **Single file:** a `file` field with "Max Files" = 1 stores one filename (string) on the record.
- **Multiple files:** setting "Max Select"/"Max Files" ≥ 2 turns the field into an array of filenames on the record (a JSON array column under the hood, same storage pattern as a multi-select field).
- The record itself only ever stores **filenames as strings** (or an array of strings) — never bytes, never a full path, never a URL. The actual bytes live on disk (or S3) at a path PocketBase derives deterministically from `collectionId/recordId/filename`. The URL-building convention (`/api/files/{collection}/{record}/{filename}`) mirrors that same triple.
- **Filename generation:** on upload, PocketBase sanitizes the original filename and appends a random ~10-character suffix, e.g. `test_52iwbgds7l.png`. This avoids collisions across re-uploads of a same-named file and makes filenames effectively unguessable identifiers, which is load-bearing for the "protected file" security model (below) — you can't just recreate the URL by guessing.
- Per-field options set on the collection schema: **Max Select** (file count), **Max Size** (default cap ~5MB, adjustable per field), **allowed MIME types**, and a **Protected** toggle (see §5).
- There is no separate "files"/"storage" table or global registry of uploaded files independent of the record that owns them. A file's only durable existence in the data model is as an entry in its owning record's array field — delete the record (or clear the field) and the filename reference is gone; an on-delete hook then removes the bytes from disk/S3.

## 2. Storage backend — one global choice, local FS or S3, not per-file

Storage backend is a **single, instance-wide configuration switch**, set once in Dashboard → Settings → Files storage (or the equivalent `Settings` API/migration) — not a per-field or per-file choice.

- **Local filesystem (default).** Files land under `pb_data/storage/<collectionId>/<recordId>/<filename>`. This is the zero-config path: works immediately on `pocketbase serve` with no setup, and composes with the rest of the single-binary story (backup = zip `pb_data/`, everything colocated with `data.db`).
- **S3-compatible.** Switching to S3 (AWS S3, MinIO, Wasabi, DigitalOcean Spaces, Vultr Object Storage, etc.) is a config change — endpoint, bucket, region, access key/secret, optional forcePathStyle — entered once in the admin UI. After the switch, **all** file reads/writes for **all** collections go through S3; PocketBase's existing local files are not auto-migrated (an admin has to move them, e.g. via a one-off script) but the API surface (`/api/files/...` URLs, field config) does not change from the client's point of view.
- It's a **binary global toggle**, not a per-collection or per-field decision — you cannot keep collection A's files on local disk and collection B's in S3 simultaneously. This matches PocketBase's "one dial for storage backend" simplicity philosophy, same as the rest of the system (see the general research note's §2 "single-binary model").

## 3. Upload flow — server-proxied multipart, no presigned direct-to-bucket path

Uploads always go **through the PocketBase process** as an ordinary `multipart/form-data` request against the existing Records create/update REST endpoints — there is no separate "get me a presigned upload URL" endpoint and no direct-to-bucket upload path, even when the backend is S3.

- Client sends `POST /api/collections/{collection}/records` (or `PATCH .../records/{id}`) with a `FormData` body: ordinary text fields plus one or more `File`/`Blob` values (JS SDK) or `MultipartFile` (Dart SDK) under the file field's name. A plain JS object with File/Blob props works too — the SDK detects it needs multipart and switches transport automatically.
- **Multi-file field modifiers**, since the field is an array:
  - `fieldname` normally *replaces* the whole array (send the full desired filename set, or new files).
  - `fieldname+` (trailing `+`) — **append/prepend** new files to the existing array without touching what's already there.
  - `fieldname-` with an array of existing filenames as the value — **delete** just those named files from the field.
  - Setting the field to `[]` / empty string — delete all files in that field.
- Because every upload transits the PocketBase process (even for S3 backend), PocketBase can apply the collection's `createRule`/`updateRule` gate, enforce Max Size/MIME-type/Max Files constraints, and generate the sanitized-filename-plus-suffix, all before bytes ever reach the store. The tradeoff (spelled out for contrast, since it's the opposite of Supabase Storage and Convex's `generateUploadUrl`/R2 pattern) is that **every uploaded byte flows through the API server's process/bandwidth**, even in the S3-backed configuration — there is no client-direct-to-bucket short-circuit. This keeps the security/validation model simple (one code path enforces rules) at the cost of not offloading bandwidth to the object store for large files.

## 4. Serving / download — file URL, `?token=`, `?thumb=`, `?download=`

**Base URL pattern:** `GET /api/files/{collectionIdOrName}/{recordId}/{filename}` — the exact same triple (collection, record, filename) that a file field's value implies. This endpoint is what every file field renders to on the client SDKs (`pb.files.getURL(record, filename)` builds it for you).

Query parameters recognized by that one endpoint (all optional, composable):

- **`?thumb=WxH`** — on-the-fly image thumbnail generation (see §6).
- **`?token=<fileToken>`** — required only for files on **protected** fields (see §5); a short-lived signed token obtained separately.
- **`?download=1`** (or `t`/`true`) — forces `Content-Disposition: attachment` so the browser downloads rather than inline-renders the file, instead of the default inline/preview behavior.

Responses: `200` with the file bytes (streamed from disk or proxied from S3), `404` if the file/record/collection doesn't exist (or, for protected files, if the view rule isn't satisfied — see §5), `400` on a filesystem/storage-backend initialization failure.

## 5. Access control — protected vs public, tied to the collection's `viewRule`

File access is **not a separate ACL system** — it rides entirely on the same declarative per-collection API rules (`listRule`/`viewRule`/`createRule`/`updateRule`/`deleteRule`) that gate ordinary record CRUD (see the general research note §3). There is no independent "file permissions" table.

- **Public (default) fields:** any `file` field not marked "Protected" is servable at its `/api/files/...` URL to anyone who can construct it — no auth check at all beyond the filename being unguessable (the random suffix). This is the common case for e.g. public avatar images.
- **Protected fields:** toggled per-field in the schema. A protected file's URL **404s unless** the request satisfies the owning record's `viewRule` — the exact same expression evaluated for `GET /api/collections/{c}/records/{id}`. So "can this file be downloaded" is defined by the same rule that decides "can this record be viewed," not a bespoke permission.
- **The `?token=` mechanism exists because file requests are plain unauthenticated `GET`s** (an `<img src>` can't attach an `Authorization` header). The client separately calls `POST /api/files/token` (requires a valid `Authorization` header — superuser or an authenticated auth record) to mint a short-lived token (JS SDK: `pb.files.getToken()`), then appends `?token=...` to the file URL. The token stands in for `@request.auth.*` inside the `viewRule` evaluation — it is what lets the rule engine know *who* is asking, since there's no other identity signal on that bare GET. PocketBase docs describe the token as "short-lived" (community/docs reference ~2 minutes); it is minted per-download-session, not stored, and not reusable indefinitely.
- The rule engine additionally recognizes `@request.context == "protectedFile"` as one of its context values, letting a rule author write a rule that behaves differently specifically during a protected-file check versus a normal record read/write, if needed.

## 6. Thumbnails / image transforms

Built into the same `/api/files/...` endpoint via `?thumb=`, no separate image-processing service or config:

- `WxH` — crop to the exact `W×H` box, anchored center.
- `WxHt` — crop, anchored top.
- `WxHb` — crop, anchored bottom.
- `WxHf` — **fit** inside the `W×H` box without cropping (letterboxed/contained, aspect preserved).
- `0xH` — resize to height `H`, width auto-scaled to preserve aspect ratio.
- `Wx0` — resize to width `W`, height auto-scaled to preserve aspect ratio.
- Supported source formats: jpg, png, gif (first frame only for animated gifs), and webp is only partially supported.
- **Fallback behavior:** if the requested thumb size doesn't match a configured/derivable size, or the file isn't an image at all, PocketBase returns the **original file** rather than erroring — a deliberate "never 404 over a cosmetic parameter" choice.
- Thumbnails are generated **on demand at request time** (not pre-generated at upload time into a fixed set of sizes) — any `WxH` combination in the URL works without prior per-field configuration of allowed sizes.

## 7. Limits, lifecycle, and the self-host operational story

- **Size/count limits are per-field schema config**, not global: default max size is roughly ~5MB per file (adjustable upward per field), and Max Files/Max Select caps how many files a multi-file field can hold. MIME-type allowlists are also per-field.
- **Lifecycle is tied to the owning record.** There is no independent garbage-collection sweep for orphaned files under normal operation — deleting a record (or clearing/replacing a file field's value) triggers PocketBase to remove the corresponding bytes from local disk or the S3 bucket as part of that same operation. Files never outlive the record that references them through the ordinary API path (bypassing the API directly against `data.db`/the bucket could, of course, orphan bytes — same caveat as the realtime bypass noted in the general research doc).
- **Self-host backup story:** because local-FS storage lives under `pb_data/storage/` alongside `data.db`, the same "zip up `pb_data/`" backup story that covers the whole app also covers uploaded files — no separate backup target to remember. (The general note's caveat about the built-in ZIP backup going read-only and being discouraged above ~2GB applies equally to storage-heavy instances; `sqlite3 .backup`/`rsync`/Litestream-style approaches don't by themselves cover the `storage/` directory, which would need its own `rsync`.) Switching to S3 moves file bytes out of that single backup story — file backups become the object store's own responsibility (bucket versioning/lifecycle rules), decoupled from the SQLite backup.

## Implications for Stackbase

PocketBase is Stackbase's closest self-host peer on this axis (single-binary/Docker, local-first, optional S3), so several of its patterns map directly onto slice 4:

**What maps well, worth adopting the shape of:**
- **Server-proxied upload as the default/only path.** For a self-host-first product, routing all upload bytes through the same process that already terminates the connection (no presigned-URL dance, no bucket credentials handed to the client) is the right complexity tradeoff at Tier 0 — same reasoning PocketBase made. We can still leave room for a future presigned/direct-to-object-store fast path as an opt-in for Tier 2 without it being required for v1.
- **Local filesystem as the zero-config default storage backend**, with a single instance-wide config switch to S3-compatible storage for scaling up — not a per-field or per-record choice. This matches our own "SQLite adapter is the zero-config default, Postgres is the scale-up swap" pattern (`DatabaseAdapter` seam) — file storage should get an analogous `StorageAdapter` seam (local FS default, S3-compatible adapter later), engine-agnostic the same way the DB adapter is.
- **On-the-fly thumbnails with a small crop/fit vocabulary** (`WxH`/`WxHt`/`WxHb`/`WxHf`/`0xH`/`Wx0`) and graceful fallback to the original when unsupported — cheap to implement, high perceived value, no separate image pipeline needed.
- **Short-lived token gating for protected file downloads.** Since a bare `GET`/`<img src>` can't carry a normal bearer/session header, minting a short-lived, single-purpose file token (analogous to `pb.files.getToken()`) is the right shape for letting our own access-rule/authz layer gate file reads without forcing every image tag through a custom fetch+blob-URL dance.
- **Files are deleted with their owning row.** Tying file lifecycle to record lifecycle (rather than requiring a manual GC sweep) avoids orphaned-blob accumulation and keeps backups coherent — worth preserving as a default, whichever storage abstraction we settle on.

**Where our model should differ (Convex-style reactive/reference model, not PocketBase's field-embedded model):**
- PocketBase has **no independent storage abstraction** — a file field *is* the filename array on the record, and the file's row-level access control *is* the owning record's `viewRule`. That's elegant for PocketBase's REST-CRUD-rules world, but it doesn't fit our reactivity model: queries must record precise, replayable **read sets** over tables, and "a file's presence/absence" needs to be an ordinary table-backed fact the invalidation engine can reason about, not a side-channel filesystem check.
- Following Convex's shape instead: file storage should be its own **`_storage` system table** holding metadata (storage id, content type, size, checksum, creation time), with app schemas storing an **`Id<"_storage">` reference** on whatever field wants to point at a file — not the raw filename. This gives us (a) reactive queries over file metadata through the normal read-set/invalidation machinery (a query that lists a record's attachments re-runs correctly when a new file metadata row commits — PocketBase's file writes are invisible to its own realtime/read-set tracking entirely, since they don't flow through the record-write path the same way), (b) the ability for multiple records/fields to reference the same stored blob by id without duplicating bytes, and (c) upload as a mutation-adjacent step (`ctx.storage.generateUploadUrl()`/`ctx.storage.store()` from an action, Convex-style) that writes a `_storage` row transactionally, rather than uploads being an implicit side effect of the record-create multipart request the way PocketBase does it.
- Access control should route through our existing **effectivePermissions/API-rule-equivalent** on the `_storage` table (or on whatever table holds the reference), not be hard-wired to "the file's owning record's view rule" — that's PocketBase-specific coupling we don't need to inherit, since our authz model is already table/range-based rather than per-collection-rule based.
- Multi-file-per-field affordances (the `+`/`-` filename-array modifiers) are a REST-CRUD-shaped concern; in our mutation-function model, "attach multiple files to a record" is just ordinary application code writing an array of `Id<"_storage">` values — no bespoke wire-protocol modifier needed.
