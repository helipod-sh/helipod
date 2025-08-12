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
 * implementation shared with the Task 7 endpoints' verify side. Pure/deterministic (no
 * wall-clock, no randomness), so it is safe to compute inside a mutation and reproducible on
 * replay.
 */
export function signUploadToken(signingKey: string, payload: { id: string; exp: number }): string {
  return createStorageToken(signingKey, payload.id, payload.exp);
}

/** Append the capability token (+ its `exp`) to a proxied upload URL's querystring. */
function withUploadToken(url: string, id: string, exp: number, signingKey: string): string {
  const token = signUploadToken(signingKey, { id, exp });
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}exp=${exp}&token=${token}`;
}

function toMetadata(doc: StorageDoc | null): BlobMetadata | null {
  if (doc === null) return null;
  return { size: doc.size, contentType: doc.contentType, sha256: doc.sha256 };
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
        // A proxied upload is served by our own endpoint, so gate it with a capability token; a
        // presigned target already carries the store's own auth in its URL — leave it untouched.
        const finalTarget: UploadTarget =
          target.kind === "proxied" ? { ...target, url: withUploadToken(target.url, id, exp, signingKey) } : target;
        return { storageId: id, target: finalTarget };
      },

      async getUrl(id) {
        const doc = await readDoc(id);
        if (doc === null) return null;
        if (doc.visibility === "public") return blobStore.publicUrl(doc.key) ?? storageEndpointPath(id);
        return storageEndpointPath(id);
      },

      async getMetadata(id) {
        return toMetadata(await readDoc(id));
      },

      async delete(id) {
        // Transactional tombstone only — the physical blob is reclaimed by the reaper (Task 9);
        // byte I/O (`blobStore.delete`) can't run inside the transactor.
        const doc = await db.get(id);
        if (doc === null) return;
        await db.delete(id);
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
        if (doc === null) return null;
        if (doc.visibility === "public") return blobStore.publicUrl(doc.key) ?? storageEndpointPath(id);
        return storageEndpointPath(id);
      },

      async getMetadata(id) {
        return toMetadata(await getDoc(id));
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
