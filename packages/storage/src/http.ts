/**
 * The reserved storage HTTP endpoints — Task 7's mechanics for the proxied-upload / direct-confirm
 * / serve surface `ctx.storage.generateUploadUrl` points at (see `./context.ts`'s doc comment and
 * `storageEndpointPath`), plus Task 8's access control on the serve endpoint: private-by-default,
 * gated by an optional `deps.checkRead` authz seam (falling back to a capability-token check when
 * authz isn't composed), with public-file/signed-redirect preferred over streaming bytes directly.
 *
 * These are NOT app-authored `httpAction`s routed through `@helipod/executor`'s
 * `http-router.ts` (that indirection resolves a project's own `http.ts` handler VALUES to a
 * `path:name` string for the runtime's module map — see `packages/cli/src/project.ts`'s
 * `ResolvedRoute`). The storage endpoints are engine-owned: each handler closes directly over its
 * `BlobStore` and `deps`, so a later task's server wiring can splice `storageRoutes(...)` in
 * alongside the sync/admin routes without going through the runtime's function dispatch at all.
 *
 * `deps.runMutation`/`deps.runQuery` are expected to reach the privileged `_storage:_finalize` /
 * `_storage:_get` built-ins (`./modules.ts`) — e.g. `EmbeddedRuntime.runSystem`, the same
 * trusted entrypoint `@helipod/admin`'s `_system:*` built-ins use.
 */
import type { BlobStore, ByteRange } from "@helipod/blobstore";
import { isValidDocumentId } from "@helipod/id-codec";
import { DocumentNotFoundError } from "@helipod/errors";
import { verifyStorageToken, type TokenScope } from "./token";
import { isReclaimable } from "./context";
import type { StorageDoc } from "./modules";
import { STORAGE_TABLE_NUMBER } from "./system-table";

export interface StorageRouteDeps {
  runMutation(path: string, args: unknown): Promise<unknown>;
  runQuery(path: string, args: unknown): Promise<unknown>;
  /** Secret to verify capability tokens minted by `./context.ts`'s `generateUploadUrl`. */
  signingKey: string;
  /**
   * Optional authz seam for the serve endpoint's `"private"` branch: resolves whether `identity`
   * (the raw `Authorization: Bearer <token>` value off the request, or `null` if absent — same
   * convention as `httpAction`, no resolution performed here) may read the `_storage` doc `id`.
   * Deliberately NOT wired to `components/authz` from this package — see `./http.ts`'s module
   * doc comment: this stays a plain dependency so `packages/storage` never imports authz, and a
   * later task supplies the real effective-permissions check at server-wiring time.
   *
   * When undefined (authz not composed into the deployment), `handleServe` falls back to
   * requiring a valid `?token=` capability token (verified via `verifyStorageToken`) instead of
   * failing open — see `handleServe`'s doc comment.
   */
  checkRead?(identity: string | null, id: string): Promise<boolean>;
}

export interface StorageRoute {
  method: string;
  pathPrefix: string;
  handler: (request: Request) => Response | Promise<Response>;
}

const UPLOAD_PATH = "/api/storage/upload";
const CONFIRM_PATH = "/api/storage/confirm";
const SERVE_PATH_PREFIX = "/api/storage/";

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

/**
 * Extract the raw `Authorization: Bearer <token>` value off a request, passed straight through as
 * `identity` with no resolution performed — same convention `httpAction` uses (see
 * `packages/executor`'s http-router notes). `null` when the header is absent or not a `Bearer`
 * scheme.
 */
function parseBearerIdentity(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? (m[1] ?? null) : null;
}

/**
 * Parse a single-range `Range: bytes=start-end` (or open-ended `bytes=start-`) header. Multi-range
 * (`bytes=0-1,5-6`) and any other malformed value fall back to `undefined` — a full-content
 * response, matching `BlobStore.read`'s `range?: ByteRange` contract (no partial support wanted).
 */
function parseRange(header: string | null): ByteRange | undefined {
  if (header === null) return undefined;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (m === null) return undefined;
  const start = Number(m[1]);
  const endStr = m[2];
  return endStr === "" || endStr === undefined ? { start } : { start, end: Number(endStr) };
}

/**
 * `storageRoutes(blobStore, deps)` — builds the three reserved handlers as plain
 * `{ method, pathPrefix, handler }` entries (no named path params in this repo's route shape —
 * see `packages/executor/src/http-router.ts`'s `matchRoute`; the serve handler below parses the
 * id from the path suffix itself). A later task wires these directly into the CLI/serve server's
 * route table.
 */
export function storageRoutes(blobStore: BlobStore, deps: StorageRouteDeps): StorageRoute[] {
  /** Shared token-gate for the upload/confirm endpoints: `id`+`token` from the query, verified
   * against `deps.signingKey` — for the given `scope` (`"upload"` for both endpoints; the serve
   * endpoint's fallback below verifies its own `"get"`-scoped token separately) — at wall-clock
   * `now` (the non-deterministic HTTP layer, so `Date.now()` IS allowed here — unlike inside a
   * mutation). A `"get"`-scoped token (e.g. one lifted off a leaked `getUrl()`) recomputes to a
   * different HMAC under `"upload"` and is rejected here — see `./token.ts`'s scope-tagging note. */
  function authorize(url: URL, scope: TokenScope): { id: string } | null {
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    if (id === null || token === null) return null;
    if (!verifyStorageToken(deps.signingKey, scope, id, token, Date.now())) return null;
    return { id };
  }

  /**
   * Shared finalize-call wrapper: `_storage:_finalize` throws `DocumentNotFoundError` both for a
   * truly-missing row AND — since the resurrection-guard fix — for a `pending` row that is
   * tombstoned/expired (a `ctx.storage.delete()`'d file, or an abandoned upload the reaper hasn't
   * swept yet). Either way, the upload this capability token pointed at is gone; surface that as a
   * clean 404 rather than letting it propagate as an uncaught rejection that a server's outer
   * catch-all would turn into a generic 500. Any OTHER error (a real backend failure) is rethrown
   * as-is, so it still surfaces as a 500 upstream — this must not mask a genuine outage as "not
   * found".
   */
  async function callFinalize(id: string, size: number, sha256: string | null): Promise<Response | null> {
    try {
      await deps.runMutation("_storage:_finalize", { id, size, sha256 });
      return null;
    } catch (e) {
      if (e instanceof DocumentNotFoundError) return textResponse(404, "upload not found (expired or deleted)");
      throw e;
    }
  }

  /**
   * Layer-2 defense-in-depth (see `./token.ts`'s scope-tagging note, the primary fix): load the
   * `_storage` row and refuse to proceed unless it is CURRENTLY a live pending upload, even though
   * the caller already presented a validly-scoped, unexpired capability token. Without this, a
   * still-unexpired `"upload"`-scoped token could be replayed against an already-`ready` row (or a
   * deleted/expired one) to overwrite its bytes — `_storage:_finalize`'s own resurrection guard
   * catches the deleted/expired case AFTER the bytes are already written, which is too late to
   * protect the blob store's content; checking here, before any `blobStore.store`/`finalizeUpload`
   * call, means a rejected request never touches the backing bytes at all.
   *
   * Returns `null` when the row is safe to proceed against (a live pending upload); otherwise the
   * `Response` to return as-is.
   */
  async function checkLivePending(id: string): Promise<Response | null> {
    let doc: StorageDoc | null;
    try {
      doc = (await deps.runQuery("_storage:_get", { id })) as StorageDoc | null;
    } catch {
      return textResponse(500, "internal error");
    }
    if (doc === null) return textResponse(404, "upload not found");
    if (doc.status === "ready") return textResponse(409, "already finalized");
    if (isReclaimable(doc, Date.now())) return textResponse(404, "upload not found (expired or deleted)");
    return null;
  }

  async function handleUpload(request: Request): Promise<Response> {
    const auth = authorize(new URL(request.url), "upload");
    if (auth === null) return textResponse(401, "invalid or expired upload token");
    const { id } = auth;

    const notLivePending = await checkLivePending(id);
    if (notLivePending !== null) return notLivePending;

    const bytes = new Uint8Array(await request.arrayBuffer());
    const contentType = request.headers.get("content-type");
    const info = await blobStore.store(id, bytes, contentType !== null ? { contentType } : undefined);
    const notFound = await callFinalize(id, info.size, info.sha256);
    if (notFound !== null) return notFound;
    return Response.json({ storageId: id });
  }

  async function handleConfirm(request: Request): Promise<Response> {
    const auth = authorize(new URL(request.url), "upload");
    if (auth === null) return textResponse(401, "invalid or expired upload token");
    const { id } = auth;

    // Symmetric with `handleUpload`'s pre-check — `_storage:_finalize` (called below via
    // `callFinalize`) already rejects a `ready`/tombstoned row, but checking here too means a
    // replayed confirm never even calls `blobStore.finalizeUpload` against an already-settled row.
    const notLivePending = await checkLivePending(id);
    if (notLivePending !== null) return notLivePending;

    const info = await blobStore.finalizeUpload(id);
    if (info === null) return textResponse(409, "upload not found");
    const notFound = await callFinalize(id, info.size, info.sha256);
    if (notFound !== null) return notFound;
    return Response.json({ storageId: id });
  }

  async function handleServe(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.pathname.slice(SERVE_PATH_PREFIX.length);
    if (id === "") return textResponse(404, "not found");

    // `id` is an untrusted URL path segment (unlike upload/confirm's token-gated query `id`), so
    // validate its shape up front — a malformed value 404s cleanly here, BEFORE `runQuery` is ever
    // called, so a genuine backend failure from `runQuery` (a real id, a real error) is never
    // masked as "not found" below.
    if (!isValidDocumentId(id, STORAGE_TABLE_NUMBER)) return textResponse(404, "not found");

    let doc: StorageDoc | null;
    try {
      doc = (await deps.runQuery("_storage:_get", { id })) as StorageDoc | null;
    } catch {
      return textResponse(500, "internal error");
    }
    if (doc === null || doc.status !== "ready") return textResponse(404, "not found");

    // Access control: private-by-default. A `"public"` doc skips the check entirely (its bytes
    // are meant to be world-readable); a `"private"` doc requires either the authz seam or, when
    // authz isn't composed, a valid capability token — this must short-circuit BEFORE any
    // `blobStore.read`/`signGetUrl` call, so a failed check never touches the backing bytes.
    if (doc.visibility === "private") {
      if (deps.checkRead !== undefined) {
        const identity = parseBearerIdentity(request);
        let ok: boolean;
        try {
          ok = await deps.checkRead(identity, id);
        } catch {
          // A throwing authz check (e.g. the effective-permissions bridge hit a backend error) must
          // become a clean 500 here, not an unhandled rejection out of the engine-owned route.
          return textResponse(500, "internal error");
        }
        if (!ok) return textResponse(403, "forbidden");
      } else {
        const token = url.searchParams.get("token");
        // Scoped `"get"` — see `./token.ts`'s scope-tagging note: an `"upload"`-scoped token
        // (e.g. one lifted off a proxied-upload URL) recomputes to a different HMAC under `"get"`
        // and must not authorize a read here.
        if (token === null || !verifyStorageToken(deps.signingKey, "get", id, token, Date.now())) {
          return textResponse(403, "forbidden");
        }
      }
    }

    // Prefer a redirect over streaming bytes through this process: a public doc's CDN url, or a
    // private doc's short-lived presigned GET (only reachable once the check above has passed).
    // `Date.now()` is wall-clock, non-deterministic — fine here since this handler is the
    // non-deterministic HTTP layer, not a mutation/query.
    const redirectUrl =
      doc.visibility === "public"
        ? blobStore.publicUrl(doc.key)
        : await blobStore.signGetUrl(doc.key, { expiresInMs: 60_000, now: Date.now() });
    if (redirectUrl !== null) return new Response(null, { status: 302, headers: { location: redirectUrl } });

    const size = doc.size ?? 0;
    const headers = new Headers();
    if (doc.contentType !== null) headers.set("content-type", doc.contentType);

    const range = parseRange(request.headers.get("range"));
    if (range !== undefined) {
      // A last-byte-pos past EOF is invalid per RFC 7233 — clamp it so the header and the bytes
      // actually read always agree. A start at/past EOF (or negative/non-finite) can't be
      // satisfied at all: 416, no read attempted.
      if (!Number.isFinite(range.start) || range.start < 0 || range.start >= size) {
        const rejectHeaders = new Headers({ "content-range": `bytes */${size}` });
        return new Response(null, { status: 416, headers: rejectHeaders });
      }
      const clampedEnd = Math.min(range.end ?? size - 1, size - 1);

      const stream = await blobStore.read(doc.key, { start: range.start, end: clampedEnd });
      if (stream === null) return textResponse(404, "not found");

      headers.set("content-range", `bytes ${range.start}-${clampedEnd}/${size}`);
      headers.set("accept-ranges", "bytes");
      headers.set("content-length", String(clampedEnd - range.start + 1));
      return new Response(stream, { status: 206, headers });
    }

    const stream = await blobStore.read(doc.key);
    if (stream === null) return textResponse(404, "not found");
    headers.set("content-length", String(size));
    return new Response(stream, { status: 200, headers });
  }

  return [
    { method: "POST", pathPrefix: UPLOAD_PATH, handler: handleUpload },
    { method: "POST", pathPrefix: CONFIRM_PATH, handler: handleConfirm },
    { method: "GET", pathPrefix: SERVE_PATH_PREFIX, handler: handleServe },
  ];
}
