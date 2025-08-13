/**
 * `ctx.storage` — the app-facing file-storage facade, wired as a `ContextProvider` (see
 * `@stackbase/executor`). Mirrors `components/scheduler/src/facade.ts`: a `build(cctx)` in-txn
 * facade that writes `_storage` metadata through the CALLING mutation's own transaction (via
 * `cctx.db`, requiring `write: true`), plus a `buildAction(api)` action-mode facade that has no
 * `db` and instead does native byte I/O against the `BlobStore` and delegates every metadata
 * write/read to the internal `_storage:*` mutations/queries (`./modules.ts`) through `api`.
 *
 * The provider's `namespace` is `""`: `_storage` is an APP-ROOT system table (see
 * `./system-table.ts`), not a component's own namespace, so the facade's `cctx.db` reads/writes
 * the bare `_storage` table in the app root — exactly like the `_storage:*` modules do.
 *
 * ── Determinism (load-bearing) ──────────────────────────────────────────────────────────────
 * `generateUploadUrl` runs INSIDE a mutation, which must stay deterministic (its read/write set
 * drives reactive invalidation, and it may be replayed on OCC conflict). Everything it derives is
 * a pure function of transaction-local inputs:
 *   - The blob `key` is the new row's storage `Id` (`key === storageId`). Ids are unique within
 *     the txn and, crucially, self-consistent: the token below signs the SAME id that lands in the
 *     row, and no wall-clock or ungoverned randomness leaks in (an insert already mints a fresh id
 *     per attempt — the same as every other insert in the engine; a replay simply commits whichever
 *     attempt wins, with its own internally-consistent id/expiry/token).
 *   - `expiresAt` and the capability token's `exp` both come from `cctx.now` (the transaction
 *     timestamp, fixed per attempt) — never `Date.now()`.
 *   - `blobStore.createUploadTarget(key, { now: cctx.now, ... })` is handed `cctx.now`, so a
 *     presigner that signs over a timestamp signs over the deterministic one, not wall-clock.
 * The capability token is an HMAC over `${id}.${exp}` with a fixed signing key — a pure function,
 * so it is stable given stable inputs. (Verified later by the Task 7/8 endpoints via
 * `./token.ts`'s `verifyStorageToken` — the same function `./http.ts`'s `authorize` calls
 * directly; there is no separate `verifyUploadToken` wrapper here, it had zero callers.)
 */
import type { ComponentContext, ActionApi, ContextProvider } from "@stackbase/executor";
import { GuestDatabaseWriter } from "@stackbase/executor";
import type { BlobStore, UploadTarget, BlobMetadata } from "@stackbase/blobstore";
import { STORAGE_TABLE } from "./system-table";
import type { StorageDoc } from "./modules";
import { createStorageToken } from "./token";

/** Default upload-URL validity: 1h — a generous window for a client to finish an upload. */
const DEFAULT_UPLOAD_TTL_MS = 3_600_000;

/**
 * Default GET-url capability-token validity: 1h. A private file's `getUrl` embeds a token so the
 * serve endpoint's no-authz fallback (`./http.ts`'s `handleServe`) accepts it — long enough for a
 * client to actually fetch the bytes after reading the url out of a query result.
 */
const DEFAULT_GET_URL_TTL_MS = 3_600_000;

export interface StorageProviderOpts {
  /** Upload-URL validity window in ms (default 1h). */
  uploadTtlMs?: number;
  /**
   * Secret for the proxied-upload capability token. Must match the secret the upload endpoint
   * (Task 7/8) verifies with. REQUIRED — there is no default. This repo is open-source, so a
   * hardcoded fallback key would be public and would let anyone forge upload capability tokens;
   * the caller (deployment boot, Task 10) must thread its own admin/deployment signing key in.
   */
  signingKey: string;
}

export interface GenerateUploadUrlOpts {
  contentType?: string;
  visibility?: "private" | "public";
}

/** The `ctx.storage` facade inside a query/mutation (`build`). */
export interface StorageWriter {
  generateUploadUrl(opts?: GenerateUploadUrlOpts): Promise<{ storageId: string; target: UploadTarget }>;
  getUrl(id: string): Promise<string | null>;
  getMetadata(id: string): Promise<BlobMetadata | null>;
  delete(id: string): Promise<void>;
}

/**
 * The `ctx.storage` facade inside an action (`buildAction`). `getUrl`/`getMetadata` mirror the
 * `build` facade's read-only semantics (so a function body is portable between mutation and action);
 * `store`/`get` add the native byte I/O only an action can do.
 */
export interface StorageActionWriter {
  store(bytes: Uint8Array | ReadableStream<Uint8Array>, opts?: GenerateUploadUrlOpts): Promise<string>;
  get(id: string): Promise<ReadableStream<Uint8Array> | null>;
  getUrl(id: string): Promise<string | null>;
  getMetadata(id: string): Promise<BlobMetadata | null>;
}

/** The stable, deterministic download endpoint path for a private (or public-without-CDN) file. */
export function storageEndpointPath(id: string): string {
  return `/api/storage/${id}`;
}

/**
 * The capability token minted for a `proxied` upload URL — see `./token.ts` for the HMAC
 * implementation shared with the Task 7 endpoints' verify side. Scoped `"upload"` (see
 * `./token.ts`'s scope-tagging note) so it can never be replayed against the serve endpoint's
 * GET-capability check. Pure/deterministic (no wall-clock, no randomness), so it is safe to
 * compute inside a mutation and reproducible on replay.
 */
export function signUploadToken(signingKey: string, payload: { id: string; exp: number }): string {
  return createStorageToken(signingKey, "upload", payload.id, payload.exp);
}

/**
 * Append the upload-endpoint's capability params to a proxied upload URL's querystring: the `id`
 * (which `_storage` doc this uploads into), its `exp`, and the HMAC `token` over `(id, exp)`. The
 * `BlobStore.createUploadTarget` for a proxied backend returns only the bare endpoint path (`/api/
 * storage/upload`) — the store is engine-agnostic and doesn't know our endpoint's `id`/token
 * contract, so the context provider (which owns that contract and knows the id) supplies all three.
 * `authorize` in `./http.ts` reads `id`+`token` back off exactly these params.
 */
function withUploadToken(url: string, id: string, exp: number, signingKey: string): string {
  const token = signUploadToken(signingKey, { id, exp });
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}id=${encodeURIComponent(id)}&exp=${exp}&token=${token}`;
}

/**
 * The confirm-endpoint URL for a PRESIGNED direct-to-bucket upload: `POST /api/storage/confirm`
 * with the same `id`/`exp`/`token` capability params the upload endpoint uses. A presigned target's
 * `url` is the bucket's own presigned PUT (carrying the store's auth, not ours), so — unlike the
 * proxied path, where the same endpoint both receives bytes and finalizes — the client needs a
 * SEPARATE, engine-authenticated call to flip the row to `ready` after the direct PUT. The client
 * can't mint this token itself (it never sees the signing key), so the provider surfaces the whole
 * URL on the target. See `handleConfirm` in `./http.ts`.
 */
function confirmUrl(id: string, exp: number, signingKey: string): string {
  const token = signUploadToken(signingKey, { id, exp });
  return `/api/storage/confirm?id=${encodeURIComponent(id)}&exp=${exp}&token=${token}`;
}

/**
 * The download url for a PRIVATE file: the serve endpoint plus a GET-capability token, so the
 * serve endpoint's no-authz fallback (`./http.ts`'s `handleServe`) accepts the read. `exp` MUST be
 * a deterministic input (the transaction timestamp `cctx.now + ttl`, never `Date.now()`) when this
 * is called from inside a query/mutation, so the returned url — and the whole read set — is stable
 * across an OCC replay; the token itself is a pure HMAC over `(scope, id, exp)`, scoped `"get"` (see
 * `./token.ts`'s scope-tagging note) so it can never be replayed against the upload/confirm
 * endpoints to overwrite this file's bytes — a private `getUrl()` is meant to be embedded in pages
 * and can leak into logs/history/Referer, so it must not double as an upload capability.
 */
function privateGetUrl(id: string, exp: number, signingKey: string): string {
  return `${storageEndpointPath(id)}?token=${createStorageToken(signingKey, "get", id, exp)}`;
}

function toMetadata(doc: StorageDoc | null): BlobMetadata | null {
  if (doc === null) return null;
  return { size: doc.size, contentType: doc.contentType, sha256: doc.sha256 };
}

/**
 * A row that no longer names a usable file: a `pending` row whose `expiresAt` has passed — i.e. an
 * abandoned/never-confirmed upload OR a `delete()` tombstone (which flips the row to an
 * immediately-expired `pending` state). Either way the reaper will remove it, and its bytes are not
 * servable, so `getUrl`/`getMetadata` treat it as absent (return `null`) rather than handing back a
 * url that would only 404 or metadata for a file that's on its way out. A pending upload with a
 * FUTURE expiry (in flight, not yet confirmed) is left visible, unchanged.
 *
 * Exported so `./http.ts`'s `handleUpload`/`handleConfirm` can reuse the exact same "is this row
 * still a live pending upload" test as a defense-in-depth pre-check before ever touching blob
 * bytes — a valid, unexpired capability token alone must not be enough to overwrite an
 * already-finalized (`ready`) or deleted/expired row.
 */
export function isReclaimable(doc: StorageDoc, now: number): boolean {
  return doc.status === "pending" && doc.expiresAt !== null && doc.expiresAt <= now;
}

/**
 * `storageContextProvider(blobStore, opts)` — the `ctx.storage` context provider.
 *
 * `opts.signingKey` is REQUIRED (no default — see `StorageProviderOpts.signingKey`'s doc comment):
 * the caller must thread the same deployment/admin signing key in here AND into `./http.ts`'s
 * `StorageRouteDeps.signingKey` on the endpoint side (Task 7/8), or issued tokens won't verify.
 *
 * `write: true` is load-bearing: without it `cctx.db` is a read-only reader and every write in
 * `build` throws (see `ContextProvider.write` in `@stackbase/executor`). With it, and only during a
 * mutation, `cctx.db` is a `GuestDatabaseWriter` scoped to the calling mutation's transaction — so
 * `generateUploadUrl`/`delete` are transactional and fan out reactively on commit like any write.
 */
export function storageContextProvider(blobStore: BlobStore, opts: StorageProviderOpts): ContextProvider {
  if (!opts.signingKey) throw new Error("storage: signingKey is required");
  const uploadTtlMs = opts.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS;
  const signingKey = opts.signingKey;

  const build = (cctx: ComponentContext): StorageWriter => {
    const db = cctx.db as GuestDatabaseWriter;
    const readDoc = async (id: string): Promise<StorageDoc | null> =>
      (await db.get(id)) as unknown as StorageDoc | null;

    return {
      async generateUploadUrl(o) {
        const contentType = o?.contentType ?? null;
        const visibility = o?.visibility ?? "private";
        const exp = cctx.now + uploadTtlMs;
        // Insert the pending row first to mint its id, then adopt that id as the blob `key`
        // (key === storageId) so the key is deterministic — no `crypto.randomUUID()` in a mutation.
        const id = await db.insert(STORAGE_TABLE, {
          status: "pending",
          key: "",
          size: null,
          contentType,
          sha256: null,
          visibility,
          expiresAt: exp,
        } as never);
        await db.replace(id, {
          status: "pending",
          key: id,
          size: null,
          contentType,
          sha256: null,
          visibility,
          expiresAt: exp,
        } as never);

        const target = await blobStore.createUploadTarget(id, {
          ...(contentType !== null ? { contentType } : {}),
          expiresInMs: uploadTtlMs,
          now: cctx.now,
        });
        // A proxied upload is served by our own endpoint, so gate it with the id + capability
        // token. A presigned target's URL already carries the bucket's own auth (leave it
        // untouched), but the client still needs an engine-authenticated way to finalize the row
        // after the direct PUT — surface a `confirmUrl` carrying the same capability params.
        const finalTarget: UploadTarget =
          target.kind === "proxied"
            ? { ...target, url: withUploadToken(target.url, id, exp, signingKey) }
            : { ...target, confirmUrl: confirmUrl(id, exp, signingKey) };
        return { storageId: id, target: finalTarget };
      },

      async getUrl(id) {
        const doc = await readDoc(id);
        if (doc === null || isReclaimable(doc, cctx.now)) return null;
        if (doc.visibility === "public") return blobStore.publicUrl(doc.key) ?? storageEndpointPath(id);
        // Deterministic: `cctx.now` (the txn timestamp), not wall-clock — keeps `getUrl` query-safe.
        return privateGetUrl(id, cctx.now + DEFAULT_GET_URL_TTL_MS, signingKey);
      },

      async getMetadata(id) {
        const doc = await readDoc(id);
        return doc === null || isReclaimable(doc, cctx.now) ? null : toMetadata(doc);
      },

      async delete(id) {
        // Transactional tombstone — NOT a hard row delete. Byte I/O (`blobStore.delete`) can't run
        // inside the transactor, so the physical blob is reclaimed asynchronously by the reaper
        // (`storageReaper` → `_storage:_reapExpired`). That sweep finds reclaimable blobs by
        // scanning `_storage` rows, so the row must SURVIVE the delete carrying its `key`: flip it
        // to an immediately-expired `pending` state (`expiresAt = cctx.now`), which the very next
        // reaper pass reaps (row + blob) — the delete's own commit touches `_storage`, waking the
        // reaper's `onCommit`. A hard `db.delete(id)` here would drop the key before any blob I/O
        // could run and leak the blob forever (the reaper would have nothing left to find).
        const doc = await db.get(id);
        if (doc === null) return;
        await db.replace(id, { ...doc, status: "pending", expiresAt: cctx.now } as never);
      },
    };
  };

  const buildAction = (api: ActionApi): StorageActionWriter => {
    const getDoc = (id: string): Promise<StorageDoc | null> =>
      api.runQuery<StorageDoc | null>("_storage:_get", { id });

    return {
      async store(bytes, o) {
        const contentType = o?.contentType ?? null;
        const visibility = o?.visibility ?? "private";
        // The full blob is already in hand, so there's no in-flight "pending" phase to model:
        // pick a fresh key, write+hash the bytes, then insert a `ready` row in one mutation via
        // `_insertReady` (designed for exactly this path — see its doc in ./modules.ts). Actions
        // are non-deterministic, so `crypto.randomUUID()` for the key is fine here; the key lives
        // only in the row's `key` column and every read goes through it, so it need not equal the
        // returned storage id (unlike the deterministic mutation-upload path, which uses key === id).
        const key = crypto.randomUUID();
        const info = await blobStore.store(key, bytes, contentType !== null ? { contentType } : undefined);
        return api.runMutation<string>("_storage:_insertReady", {
          key,
          size: info.size,
          sha256: info.sha256,
          contentType,
          visibility,
        });
      },

      async get(id) {
        const doc = await getDoc(id);
        if (doc === null) return null;
        return blobStore.read(doc.key);
      },

      async getUrl(id) {
        const doc = await getDoc(id);
        // Action mode is non-deterministic, so wall-clock `Date.now()` is fine as the "now" for
        // both the reclaimable check and the token expiry.
        if (doc === null || isReclaimable(doc, Date.now())) return null;
        if (doc.visibility === "public") return blobStore.publicUrl(doc.key) ?? storageEndpointPath(id);
        return privateGetUrl(id, Date.now() + DEFAULT_GET_URL_TTL_MS, signingKey);
      },

      async getMetadata(id) {
        const doc = await getDoc(id);
        return doc === null || isReclaimable(doc, Date.now()) ? null : toMetadata(doc);
      },
    };
  };

  return {
    name: "storage",
    namespace: "",
    write: true,
    build,
    buildAction,
  };
}
