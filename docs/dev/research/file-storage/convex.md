---
title: Convex — File Storage Research
status: research
---

# Convex — File Storage Research

> Researched 2025-07-31. Sources: docs.convex.dev/file-storage/overview, /upload-files,
> /serve-files, /store-files, /delete-files, /file-storage/file-metadata (fetched directly);
> the convex-backend Rust reference under `.reference/convex-backend` — specifically
> `crates/file_storage/src/core.rs`, `crates/common/src/types/file_storage.rs`,
> `crates/local_backend/src/storage.rs` (the `/api/storage/*` HTTP handlers),
> `crates/model/src/file_storage/{mod,types}.rs`, `crates/isolate/src/environment/action/storage.rs`,
> and the public client typings `npm-packages/convex/src/server/storage.ts` — studied as
> architecture reference only, no code copied. Claims that could not be confirmed against a
> primary source are flagged "Unknown / not confirmed."

## 1. Data model

Every stored file is represented as one row in a **system table `_storage`**, sitting
alongside a physical blob in an underlying object store (S3-compatible in production; local
disk for self-hosted/dev per the general architecture doc). The row is the *only* part of a
file that participates in the regular document/transaction model — the bytes themselves live
outside it entirely (see §8).

Confirmed fields on the `_storage` row (from `npm-packages/convex/src/server/storage.ts` and
the file-metadata doc):

- **`_id`** — the storage id, typed `Id<"_storage">` in user code. This is the value that gets
  stored inside ordinary user documents (e.g. `messages.body = storageId`) as a first-class
  foreign reference, exactly like any other `Id<"tableName">`.
- **`_creationTime`** — standard system timestamp, same as every other Convex document.
- **`sha256`** — "a base16 encoded sha256 checksum of the file contents." Computed server-side
  during upload (not client-supplied, though a client-supplied digest can be checked against it
  — see §2).
- **`size`** — size of the file in bytes.
- **`contentType`** — the `Content-Type` header supplied at upload time, if any; `null`/absent
  otherwise. Not inferred from bytes — it's whatever the uploader declared.

Internally (from the Rust reference, `FileStorageEntry` in
`crates/model/src/file_storage/types.rs`) the system row carries one field not exposed to
developers: **`storageKey`** — "the object key we use in the backing store," which is a
**different UUID from the storage id handed out to developers**. This indirection means the
public `Id<"_storage">` is decoupled from wherever/however the physical bytes are actually
keyed in the underlying blob store — the backend is free to change its physical storage keying
scheme without changing any developer-visible id. `storage_id` itself used to be the literal
identifier returned to developers pre-1.6 ("Used to generate URLs. Used to be the primary
storage id before convex 1.6") — the two were once conflated and were deliberately split apart.

The `_storage` table is queried like any other system table: `ctx.db.system.get("_storage", id)`
/ `ctx.db.system.query("_storage").collect()` inside queries and mutations — this is now the
**preferred** way to read metadata (see §4), superseding the older `ctx.storage.getMetadata()`
action-only call, which returns a similarly-shaped but not identical `FileMetadata` object
(`{ storageId, sha256, size, contentType }` — note `storageId` as a plain string field there,
not `_id`).

## 2. Upload flow

Two supported paths, both terminating in the same place: a new `_storage` row plus bytes
durably written to the blob backend.

### (a) Upload-URL indirection (the default/recommended path, arbitrary file size)

Three steps, split across a mutation → raw HTTP POST → a second mutation:

1. **A mutation calls `ctx.storage.generateUploadUrl()`**, returning a short-lived signed URL:

   ```ts
   export const generateUploadUrl = mutation({
     args: {},
     handler: async (ctx) => {
       return await ctx.storage.generateUploadUrl();
     },
   });
   ```

   Internally (`crates/file_storage/src/core.rs::generate_upload_url_with_origin`) this issues
   a **signed, time-bounded authorization token** via a "key broker"
   (`key_broker.issue_store_file_authorization`) and returns
   `"{origin}/api/storage/upload?token={token}"`. **The token/URL is valid for 1 hour**
   (`STORE_FILE_AUTHORIZATION_VALIDITY = 60 * 60s` in `local_backend/src/storage.rs`, matching
   the docs: "The upload URL expires in 1 hour and so should be fetched shortly before the
   upload is made.") Note the URL carries no file identity yet — it authorizes *an* upload to
   *this deployment/component*, not a specific storage id.

2. **The client POSTs the raw file bytes directly to that URL** (not through any Convex
   function call):

   ```ts
   const postUrl = await generateUploadUrl();
   const result = await fetch(postUrl, {
     method: "POST",
     headers: { "Content-Type": selectedImage.type },
     body: selectedImage,
   });
   const { storageId } = await result.json();
   ```

   Server-side, this hits a plain HTTP handler (`storage_upload` in `local_backend/src/storage.rs`)
   that: validates the token, reads optional `Content-Type`/`Content-Length`/HTTP `Digest`
   (sha256) headers, streams the body straight into the blob store computing size + sha256 as
   it goes (`upload_file` → `try_write_parallel_and_hash`), and — if the client supplied an
   expected sha256 via the `Digest` header — **rejects the upload with `Sha256Mismatch` if the
   computed hash disagrees**. This all happens **completely outside any Convex transaction** —
   there is no `tx` in scope during the byte-streaming; it is answered by a stateless HTTP
   endpoint that only talks to the blob store. **File size is not limited by Convex** at this
   layer; the only constraint stated in the docs is that the **POST itself has a 2-minute
   timeout**.
   Once the bytes are fully written, the handler makes a **brand-new, separate transaction**
   (`store_file_entry`, opened fresh via `self.database.begin(Identity::system())`) purely to
   insert the `_storage` metadata row and returns `{ storageId }` as the JSON response. The
   code comment is explicit about why: *"Start/Complete transaction after the slow upload
   process to avoid OCC risk."* — i.e. never hold a transaction open across a slow, unbounded
   network write, because in an OCC system a long-lived transaction is a long-lived conflict
   window.

3. **A second, ordinary mutation persists the returned `storageId` into a real document**:

   ```ts
   export const sendImage = mutation({
     args: { storageId: v.id("_storage"), author: v.string() },
     handler: async (ctx, args) => {
       await ctx.db.insert("messages", { body: args.storageId, author: args.author });
     },
   });
   ```

   This step *is* fully transactional/reactive in the normal way — it's a plain document
   insert, and any subscribed query whose read set covers that table sees it fan out live like
   any other write.

### (b) Storing from within an action (`ctx.storage.store`)

For server-generated content (e.g. calling DALL·E, or re-encoding a file) there is no client
upload leg at all. An action fetches/produces a `Blob` and stores it directly:

```ts
const response = await fetch(imageUrl);
const image = await response.blob();
const storageId = await ctx.storage.store(image, { sha256 }); // sha256 optional, verifies integrity
```

`store()` is only available on `ctx.storage` inside **actions and HTTP actions** (the
`StorageActionWriter` interface — not on the plain `StorageWriter` available in mutations),
because actions are the non-transactional, side-effecting escape hatch. Just as with the
upload-URL path, the byte write happens outside any transaction; the action must then
explicitly hand the resulting id to a mutation to record it against real data:

```ts
await ctx.runMutation(internal.images.storeResult, { storageId, prompt: args.prompt });
```

There is also a **third, smaller path** mentioned in the docs for files under 20 MiB: an
`httpAction` can itself read the incoming `Request` body as a `Blob` and call
`ctx.storage.store(blob)` in one round trip (no separate `generateUploadUrl` call needed) —
useful when you already have an HTTP action doing auth/validation and don't want a second
hop. This trades the "no size limit" property of the upload-URL path for one fewer request,
at the 20 MiB HTTP-action response/body ceiling (see §7).

### Why the indirection exists

The unifying reason across both paths: **the transactional function core (queries/mutations)
never sees raw bytes.** A blob write is (a) unbounded in size and (b) unbounded in *time*
(client upload speed, remote fetch latency) — exactly the two properties an OCC transaction
must not have, because a transaction holds a read-set/write-set watch window open and a
slow/huge blob write would either block the single committer or blow up conflict-retry cost.
So Convex physically separates "write the bytes" (a plain, stateless, transaction-free HTTP
operation) from "record a reference to the bytes" (an ordinary fast document write, fully
inside the transactional/reactive model). The `Id<"_storage">` is the seam between the two
worlds — it's just a normal document id/foreign-key value everywhere in the reactive system;
only the code paths that mint it or resolve it to bytes (`generateUploadUrl`, `store`,
`getUrl`, `get`) know anything about blobs at all.

## 3. Download / serving

**Primary path — `ctx.storage.getUrl(storageId)`.** Available in queries, mutations, and
actions (part of the base `StorageReader` interface). Returns a plain string URL (or `null` if
the file no longer exists) that resolves via ordinary HTTP GET:

```ts
const url = await ctx.storage.getUrl(message.body);
```

Server-side (`get_url_batch` in `core.rs`) this is just string formatting —
`"{canonical_origin}/api/storage/{storage_id}{component_query}"` — there is **no signature,
no expiry, no per-request token** on this URL. It is a stable, durable, unauthenticated public
URL for as long as the file exists. The GET handler (`storage_get` in
`local_backend/src/storage.rs`) serves the blob with:
- **HTTP Range support** — but **only a single `Range` (start, end) pair**; if the client's
  `Range` header requests multiple discontiguous ranges the server responds
  `416 Range Not Satisfiable` rather than trying to satisfy them (explicitly attributed in the
  comment to the constraint that "underlying AWS S3 only supports a single range"). Supports
  `Accept-Ranges: bytes` and returns `206 Partial Content` with a proper `Content-Range` header
  when a satisfiable single range is given.
- **A `Digest` response header** carrying the sha256 (so a client can verify integrity without
  a separate metadata call).
- **`Cache-Control: private, max-age=2592000`** (30 days) on every GET — the code comment notes
  *"Storage GETs are immutable. Browser can cache for a long time"* — since a given storage id
  never changes its bytes (only deletion invalidates it), aggressive caching is safe.
- Streaming is chunked with a capped internal chunk size (32 KiB) purely for usage-metering
  granularity/fairness, not a client-visible limit.

**Access-controlled path — HTTP actions calling `ctx.storage.get(storageId)`.** For any case
where "everyone with the URL can read it forever" is unacceptable, the documented pattern is to
**not** use `getUrl` at all: instead write an `httpAction` that authenticates the caller first
(cookies/bearer token/whatever), then calls `ctx.storage.get(storageId)` — which returns a
`Blob` (or `null`) — and manually constructs `new Response(blob)`. Because this goes through a
normal `httpAction`, every request re-runs the auth check; nothing about the URL itself is
privileged. The documented ceiling here: **HTTP action responses are capped at 20 MiB**, so this
path is explicitly *not* a fit for serving large files — `getUrl`'s direct-from-storage path has
no such ceiling.

**No image-transform/resizing pipeline, no signed-URL-with-expiry primitive, and no built-in
CDN layer are part of core file storage** — Unknown/not confirmed whether any such feature
exists even as an add-on; the docs explicitly point elsewhere (e.g. a separate Cloudflare R2
component) for "expiring URLs," implying core storage deliberately doesn't offer them.

## 4. The `ctx.storage` API surface (exact shapes)

From `npm-packages/convex/src/server/storage.ts` (the public TS typings), the interface is
layered by function kind — reads only broaden as you move from `query` → `mutation` → `action`:

```ts
// Base — available via ctx.storage in queries, mutations, actions
interface StorageReader {
  getUrl(storageId: Id<"_storage">): Promise<string | null>;
  /** @deprecated */ getMetadata(storageId: Id<"_storage">): Promise<FileMetadata | null>;
}

// Mutations add write capability (still no direct byte I/O)
interface StorageWriter extends StorageReader {
  generateUploadUrl(): Promise<string>;
  delete(storageId: Id<"_storage">): Promise<void>;
}

// Actions/httpActions add direct byte-level I/O — the only place raw Blobs appear
interface StorageActionWriter extends StorageWriter {
  get(storageId: Id<"_storage">): Promise<Blob | null>;
  store(blob: Blob, options?: { sha256?: string }): Promise<Id<"_storage">>;
}
```

Notably: **`get`/`store` (raw Blob I/O) do not exist on `ctx.storage` in queries or mutations at
all** — not just discouraged, structurally absent from the type. Queries/mutations can only
mint upload URLs, read metadata/URLs, and delete — never touch bytes. This is the type system
enforcing the "no blobs inside the transaction" rule from §2/§8 at the API-surface level, not
just by convention.

`FileMetadata` (the older, `getMetadata`-only shape, now superseded by reading `_storage`
directly via `ctx.db.system.get`):
```ts
type FileMetadata = {
  storageId: string;   // plain string, not Id<"_storage">, in this legacy shape
  sha256: string;
  size: number;
  contentType: string | null;
};
```

## 5. Access control

There is **no built-in access-control layer for file storage** — Convex deliberately keeps this
orthogonal to auth. Two concrete consequences, both explicit in the docs:

- **`getUrl`-issued URLs are bearer tokens by construction.** "Anyone with the URL can access
  the file" with no further authorization check, no expiry. The developer is responsible for
  deciding *who gets handed the URL* (e.g. only returning it from an authenticated query) —
  the URL itself carries no identity/permission check once minted.
- **The only revocation mechanism is deletion.** There is no way to invalidate a previously
  issued URL for a still-existing file; if a URL leaked or access needs to be revoked, the
  documented answer is delete the file (and re-upload under a new storage id if it's still
  needed, sharing the new URL only with authorized parties going forward).
- For genuinely per-request-authorized access (dynamic permissions, expiring links, revocable
  access), the documented escape hatch is: don't use `getUrl` — write an `httpAction` that
  checks auth on every request before calling `ctx.storage.get()` and streaming the blob back
  manually (§3). This reuses the exact same `identity`/auth primitives available to any other
  `httpAction` (e.g. `ctx.auth.getUserIdentity()`) — there's no storage-specific auth concept.

## 6. Lifecycle: deletion, GC, dedup

- **Deletion (`ctx.storage.delete(storageId)`)** is callable from mutations, actions, and HTTP
  actions. In the Rust reference (`FileStorageModel::delete_file`), deleting removes the
  `_storage` system document via the ordinary `SystemMetadataModel::delete` path — i.e. **the
  metadata-row deletion is a normal transactional document delete**, participating in OCC/commit
  like any other write. What is **not** shown/confirmed in the reference at this layer is the
  synchronous-vs-async fate of the underlying physical blob in the object store — Unknown / not
  confirmed whether blob-bytes deletion from the backing store happens inline in the same
  request or is swept up later by a background GC process; the architecture strongly implies
  the latter given the general pattern of keeping slow I/O off the transaction path, but no
  direct evidence of a GC worker was found in the crates inspected.
- **After deletion, any previously issued `getUrl` link 404s** — confirmed directly in the
  public TS docstring: "Once a file is deleted, any URLs previously generated by
  `storage.getUrl` will return 404s."
  - **No orphan-file cleanup tooling is documented** for the case where a client calls
    `generateUploadUrl`/uploads bytes but the follow-up mutation that would have referenced the
    `storageId` is never called (abandoned upload) — the row + blob would simply sit in
    `_storage` unreferenced by any user document until a developer notices and deletes it
    manually (e.g. via a scheduled cleanup mutation querying `_storage` and diffing against
    referenced ids). This is a real gap developers hit in practice; Convex does not solve it
    for you.
- **No content-addressed dedup.** Confirmed by inspecting `FileStorageEntry` and `upload_file`/
  `store_file_entry`: every upload — even of byte-identical content — mints a **fresh
  `StorageUuid`** and a **fresh underlying `storageKey`**, and inserts a brand-new `_storage`
  row. `sha256` is computed and stored purely for **integrity verification** (matching an
  optional client-supplied digest and exposing it via the `Digest` response header on GET), not
  as a dedup/content-addressing key. Two uploads of the same bytes produce two fully independent
  storage ids, two rows, and (implied) two copies of the bytes in the backing store.

## 7. Limits

- **Upload (client → `generateUploadUrl` POST):** no documented file-size ceiling from Convex
  itself ("the file size is not limited"); the constraint is the **POST request has a 2-minute
  timeout** — practically an upload-bandwidth-dependent ceiling, not a byte-count one.
  Underlying object-store limits (e.g. S3 single-PUT ~5 GiB) are inherited but not called out in
  docs — Unknown / not confirmed as a hard developer-facing number.
- **`store()` from an action / one-shot `httpAction` upload:** capped indirectly by the action
  runtime's own limits (argument size limits differ by runtime: 16 MiB for the V8 runtime vs
  5 MiB for the opt-in Node runtime, per the general architecture doc) when the blob arrives as
  part of an argument rather than a raw HTTP body stream.
- **HTTP action response (serving path via `ctx.storage.get` + manual `Response`):** hard
  **20 MiB** cap — explicitly documented, explicitly called out as unsuitable for large files
  ("aren't a fit for serving larger files through Convex"). The `getUrl`-direct path has no such
  cap since it bypasses the httpAction response pipeline entirely.
- **Content-type handling:** purely a pass-through of whatever `Content-Type` header (if any)
  the uploader supplied — **not sniffed/validated/inferred from bytes** server-side. A client
  that omits or lies about `Content-Type` gets exactly that (or nothing) stored in the
  `contentType` field; Convex does no MIME validation.
- **Range requests:** single-range only (see §3) — a hard architectural limit inherited from the
  S3-compatible backing store, not a policy choice that could trivially be lifted.

## 8. Transactionality — how files fit the reactive/transactional model

This is the load-bearing design decision underlying everything above, stated plainly:

**Blob bytes never enter the OCC transaction. Only the `Id<"_storage">` reference — an ordinary
document/foreign-key value — does.** Concretely:

- The *byte write* (whether via the signed upload-URL POST or `ctx.storage.store()` in an
  action) is answered by **stateless, transaction-free code** that talks directly to the blob
  backend. There is no `Transaction`/`tx` object in scope while streaming bytes.
- Recording that the file *exists* — inserting the `_storage` metadata row — is a **separate,
  freshly-opened, fast transaction**, deliberately begun *after* the slow upload completes
  (`core.rs`'s own comment: avoid OCC risk from a long-lived transaction watching a slow I/O
  operation).
- Making the file *mean something to your app* — attaching its `storageId` to a `messages` row,
  a `users.avatar` field, etc. — is a **third, completely ordinary mutation**, no different from
  any other document write. This is the only step that is reactive in the normal sense: a
  subscribed query reading that document's table will see its read set intersect the write and
  get pushed a new result. The file's *existence* in `_storage` is not itself something a
  developer subscribes to directly in the common case, though nothing stops a query from doing
  `ctx.db.system.query("_storage")...` and being reactively re-run the same as for any table.
- Net effect: **the reactivity/OCC model treats a stored file exactly like an opaque external
  resource referenced by id** — structurally identical to how a mutation might store a URL to
  an S3 object it uploaded via `fetch` in an action, except Convex owns the storage backend and
  gives you the small set of `ctx.storage.*` primitives instead of making you hand-roll
  S3-SDK calls and your own id scheme. The "storage" feature is really "a blob store + a system
  table of references to it," deliberately kept as thin and inspectable as any other document
  table, with none of its own bespoke transactional semantics.

## Implications for Stackbase

**What to borrow — directly, with high confidence:**

1. **The upload-URL indirection is the right shape, and for the same reason.** Stackbase's
   transaction manager is a single-writer OCC committer (per `system-design.md`) — an unbounded,
   slow client upload must never hold that transaction open. Mint a short-lived, single-use
   signed URL from a mutation (`ctx.storage.generateUploadUrl()`-equivalent), let the client POST
   raw bytes to a stateless HTTP endpoint outside the function-execution path entirely, then
   have that endpoint open a brand-new fast transaction just to insert the metadata row and
   return `{ storageId }`. Never make the transactional core stream bytes.
2. **`Id<"_storage">` as a first-class foreign-key value is exactly the seam to reuse.** It
   should behave like any other `Id<"table">` in Stackbase's codegen/validators (`v.id("_storage")`),
   storable in user documents, flowing through the normal reactive read/write-set machinery —
   *only* the handful of storage primitives (mint-upload-url / store / getUrl / get / delete)
   need to know a blob sits behind it.
3. **A `_storage` system table** (`_id`, `_creationTime`, `size`, `sha256`, `contentType`) is a
   clean, minimal metadata shape to copy near-verbatim. Exposing it via the same
   `ctx.db.system.get`/`query` mechanism Stackbase already needs for other system tables (if any
   exist yet) keeps this consistent rather than bolting on a separate `getMetadata` call — Convex
   itself moved *toward* this and deprecated the separate call, a useful signal to start there
   directly rather than repeat the churn.
4. **Split the `ctx.storage` interface by function-kind capability, enforced by types, not
   convention** — `get`/`store` (raw Blob I/O) only exist on the action-context variant;
   queries/mutations get read-URL/delete/generate-upload-url only. This mirrors Stackbase's
   existing query/mutation/action trust boundaries (no `ctx.db` in actions, no `fetch` in
   queries/mutations) and is cheap to add as one more axis on the same context-construction code
   that already differentiates those three.
5. **No signed/expiring download URLs, no dedup, no image transforms in the core primitive** —
   Convex's restraint here is deliberate and it keeps the core small and easy to reason about.
   Stackbase should resist scope-creeping slice 4 into a media pipeline; ship the thin blob +
   reference primitive first, exactly as Convex did, and treat transforms/expiring-links as
   later, optional, decoupled features (Convex pushes those to a separate R2 component, not core).
6. **30-day immutable `Cache-Control` on serve responses** is a free, essentially risk-free win
   given storage ids are content-immutable once written (only deletion changes anything) — worth
   copying directly rather than re-deriving.

**What to watch / open questions Stackbase should resolve explicitly rather than inherit
silently:**

1. **Orphaned uploads are a real, user-visible gap in Convex** — an uploaded-but-never-referenced
   blob has no automatic cleanup story. Given Stackbase's "storage is pluggable, `DatabaseAdapter`
   only" architecture and its heavier emphasis on self-hosting simplicity (`docker compose up`),
   this is a good place to do *slightly* better — e.g. a TTL/reap policy for `_storage` rows with
   no inbound reference after N hours — without contradicting anything Convex teaches, since
   Convex simply never solved it.
2. **Blob GC on delete is unconfirmed even in the reference implementation** — Stackbase must
   decide explicitly (not by omission) whether `ctx.storage.delete()` reaps the physical bytes
   synchronously in the same request or via a background sweep, and document which. Given
   Stackbase's storage adapter is pluggable (local disk for self-host, presumably S3-compatible
   for scale-out), a synchronous-delete-then-async-verify or a soft-delete+sweep design should be
   picked deliberately, not left as an accident of implementation order.
3. **Bearer-URL access model is a genuine security trade Stackbase's docs must call out loudly**,
   matching Convex's own explicit warning — self-hosters especially need this spelled out since
   there's no managed-platform safety net; consider whether Stackbase's `httpAction` + auth
   primitives (already shipped) are sufficient to make the "gate access via an authenticated
   httpAction" escape hatch as easy to reach for as `getUrl`, so it doesn't become the unused,
   forgotten safe path the way it arguably is in Convex today.
4. **Range-request single-pair limitation is inherited from S3 semantics, not a Convex design
   choice** — if Stackbase's default self-host storage backend is plain local disk rather than
   an S3-compatible store, multi-range support may be cheap to offer and worth the small
   incremental win, rather than reflexively copying a constraint whose root cause (S3's own
   limit) may not apply.
5. **No documented per-deployment total storage quota/usage-limit mechanics were surfaced** by
   this research (usage tracking clearly exists internally — `usage_tracking::StorageUsageTracker`
   — but its policy/limits are a hosted-billing concern, not a core-storage-feature one). Not
   relevant to Stackbase's initial self-hosted-only design point, but flag as Unknown / not
   confirmed rather than assume "no limits needed."
