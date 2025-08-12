/**
 * The reserved storage HTTP endpoints — Task 7's mechanics for the proxied-upload / direct-confirm
 * / serve surface `ctx.storage.generateUploadUrl` points at (see `./context.ts`'s doc comment and
 * `storageEndpointPath`). Access control (private vs public, the signed-redirect/`publicUrl`
 * branch for a presigned store) is Task 8 — here every `"ready"` row is served unconditionally.
 *
 * These are NOT app-authored `httpAction`s routed through `@stackbase/executor`'s
 * `http-router.ts` (that indirection resolves a project's own `http.ts` handler VALUES to a
 * `path:name` string for the runtime's module map — see `packages/cli/src/project.ts`'s
 * `ResolvedRoute`). The storage endpoints are engine-owned: each handler closes directly over its
 * `BlobStore` and `deps`, so a later task's server wiring can splice `storageRoutes(...)` in
 * alongside the sync/admin routes without going through the runtime's function dispatch at all.
 *
 * `deps.runMutation`/`deps.runQuery` are expected to reach the privileged `_storage:_finalize` /
 * `_storage:_get` built-ins (`./modules.ts`) — e.g. `EmbeddedRuntime.runSystem`, the same
 * trusted entrypoint `@stackbase/admin`'s `_system:*` built-ins use.
 */
import type { BlobStore, ByteRange } from "@stackbase/blobstore";
import { verifyStorageToken } from "./token";
import type { StorageDoc } from "./modules";

export interface StorageRouteDeps {
  runMutation(path: string, args: unknown): Promise<unknown>;
  runQuery(path: string, args: unknown): Promise<unknown>;
  /** Secret to verify capability tokens minted by `./context.ts`'s `generateUploadUrl`. */
  signingKey: string;
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
   * against `deps.signingKey` at wall-clock `now` (the non-deterministic HTTP layer, so
   * `Date.now()` IS allowed here — unlike inside a mutation). */
  function authorize(url: URL): { id: string } | null {
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");
    if (id === null || token === null) return null;
    if (!verifyStorageToken(deps.signingKey, id, token, Date.now())) return null;
    return { id };
  }

  async function handleUpload(request: Request): Promise<Response> {
    const auth = authorize(new URL(request.url));
    if (auth === null) return textResponse(401, "invalid or expired upload token");
    const { id } = auth;

    const bytes = new Uint8Array(await request.arrayBuffer());
    const contentType = request.headers.get("content-type");
    const info = await blobStore.store(id, bytes, contentType !== null ? { contentType } : undefined);
    await deps.runMutation("_storage:_finalize", { id, size: info.size, sha256: info.sha256 });
    return Response.json({ storageId: id });
  }

  async function handleConfirm(request: Request): Promise<Response> {
    const auth = authorize(new URL(request.url));
    if (auth === null) return textResponse(401, "invalid or expired upload token");
    const { id } = auth;

    const info = await blobStore.finalizeUpload(id);
    if (info === null) return textResponse(409, "upload not found");
    await deps.runMutation("_storage:_finalize", { id, size: info.size, sha256: info.sha256 });
    return Response.json({ storageId: id });
  }

  async function handleServe(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const id = url.pathname.slice(SERVE_PATH_PREFIX.length);
    if (id === "") return textResponse(404, "not found");

    // `id` is an untrusted URL path segment (unlike upload/confirm's token-gated query `id`), so
    // a malformed value must 404 cleanly rather than propagate the id-codec's decode error as an
    // unhandled 500.
    let doc: StorageDoc | null;
    try {
      doc = (await deps.runQuery("_storage:_get", { id })) as StorageDoc | null;
    } catch {
      return textResponse(404, "not found");
    }
    if (doc === null || doc.status !== "ready") return textResponse(404, "not found");

    const range = parseRange(request.headers.get("range"));
    const stream = await blobStore.read(doc.key, range);
    if (stream === null) return textResponse(404, "not found");

    const headers = new Headers();
    if (doc.contentType !== null) headers.set("content-type", doc.contentType);

    if (range !== undefined) {
      const size = doc.size ?? 0;
      const end = range.end ?? size - 1;
      headers.set("content-range", `bytes ${range.start}-${end}/${size}`);
      headers.set("accept-ranges", "bytes");
      return new Response(stream, { status: 206, headers });
    }

    return new Response(stream, { status: 200, headers });
  }

  return [
    { method: "POST", pathPrefix: UPLOAD_PATH, handler: handleUpload },
    { method: "POST", pathPrefix: CONFIRM_PATH, handler: handleConfirm },
    { method: "GET", pathPrefix: SERVE_PATH_PREFIX, handler: handleServe },
  ];
}
