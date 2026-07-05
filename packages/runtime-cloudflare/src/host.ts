/**
 * `DurableObjectRuntimeHost` — the Durable Object's implementation of the shipped `RuntimeHost` seam
 * (`packages/runtime-embedded/src/host.ts`), Task 2 of the Slice-3 build order.
 *
 * A DO is a PORTLESS host: the Worker owns ingress, there is no socket to bind. So `serve()` binds no
 * port — it records the runtime + serve options and returns a `ServerHandle` with the shipped
 * `port: 0` sentinel, a no-op `close()` (a DO hibernates/evicts silently, with no SIGTERM — durable
 * work must survive without `close()`, exactly as the seam documents), and a WORKING `setRoutes()` so
 * the contract is honoured even though a Slice-3 DO has no hot-reload (functions are fixed at deploy).
 *
 * HTTP dispatch then flows through `fetch(request)` — the DO's `fetch` delegates every non-WebSocket
 * request here. Two engine-owned reserved-route families are matched HERE, ahead of the shipped pure
 * dispatcher, mirroring the container's `server.ts` order (storage → component → user/built-in):
 *   - `storageRoutes` — the always-on file-storage `/api/storage/*` endpoints (upload/confirm/serve).
 *     Their `handler(request)` is a native `Request -> Response` closure over the `BlobStore`, so a DO
 *     — which already has a Web `Request` in hand — can call it directly, no `HttpRequest` re-shaping.
 *   - `componentRoutes` — reserved routes contributed by composed components (e.g. auth's OAuth
 *     callbacks). Same `{method,pathPrefix,handler}` shape; matched after storage, before user routes.
 * Everything else reuses the SHIPPED pure dispatcher (`handleHttpRequest`): `/api/health`, `/api/run`
 * (the transactor path — inline fan-out on commit, decision 5), `/_admin/*` (incl. `/_admin/wake` →
 * `runtime.fireDueTimers()`), and user httpAction routes. This is the single place that turns a
 * `Request` into the dispatcher's `HttpRequest` shape and back.
 *
 * WHY match storage/component here rather than in `handleHttpRequest`: those handlers stream native
 * `Response` bodies (raw bytes, 302 redirects, 206 partials) that the `HttpRequest`/`HttpResponse`
 * string shape can't carry; the container splices them in at its own `server.ts` boundary for the
 * same reason. A DO's `fetch` IS that boundary, so we match them here — a single seam change that
 * unblocks BOTH file-storage serving (gap 7c) AND auth OAuth callbacks (gap 8c) on the DO.
 */
import type { EmbeddedRuntime, RuntimeHost, ServeOptions, ServerHandle } from "@helipod/runtime-embedded";
import type { AdminApi } from "@helipod/admin";
import type { ResolvedRoute } from "@helipod/cli/project";
import type { StorageRoute } from "@helipod/storage";
import { handleHttpRequest } from "@helipod/cli/http-handler";

/** The reserved storage-route prefix — a storage route is matched ONLY under it (mirrors
 *  `server.ts`'s `STORAGE_PREFIX` gate), so a user `GET /api/storage/<id>` never collides with an
 *  unrelated app path and the upload/confirm handlers key off method (POST) vs. the serve handler. */
const STORAGE_PREFIX = "/api/storage/";

/** Match an engine-owned `/api/storage/*` route by method + path-prefix (gated to `STORAGE_PREFIX`). */
function matchStorageRoute(routes: StorageRoute[] | undefined, method: string, path: string): StorageRoute | undefined {
  if (!routes || !path.startsWith(STORAGE_PREFIX)) return undefined;
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}

/** Match an engine-owned component-contributed route (e.g. auth's `/api/auth/oauth/*`) — same
 *  `{method,pathPrefix}` shape as a storage route, but not gated to the storage prefix. */
function matchComponentRoute(routes: StorageRoute[] | undefined, method: string, path: string): StorageRoute | undefined {
  if (!routes) return undefined;
  return routes.find((r) => r.method === method && path.startsWith(r.pathPrefix));
}

/** The DO host pins the neutral seam's generics to the concrete types its dispatcher consumes.
 *  `StorageRt` is pinned to `StorageRoute` — the CLI pins both `storageRoutes` and `componentRoutes`
 *  to the same shape, and so does the DO. Deploy and fleet are Slice-6/container-path concerns,
 *  absent on a DO — left at the seam default. */
export type DurableObjectServeOptions = ServeOptions<ResolvedRoute, AdminApi, StorageRoute>;
export type DurableObjectServerHandle = ServerHandle<ResolvedRoute>;

export class DurableObjectRuntimeHost implements RuntimeHost<ResolvedRoute, AdminApi, StorageRoute> {
  private runtime: EmbeddedRuntime | null = null;
  private options: DurableObjectServeOptions | null = null;
  private routes: ResolvedRoute[] = [];
  /** Reserved routes fixed at boot on a DO (no hot-reload): the always-on `/api/storage/*` handlers
   *  and any component-contributed (OAuth) routes. Matched ahead of the pure dispatcher in `fetch`. */
  private storageRoutes: StorageRoute[] = [];
  private componentRoutes: StorageRoute[] = [];

  serve(runtime: EmbeddedRuntime, options: DurableObjectServeOptions): Promise<DurableObjectServerHandle> {
    this.runtime = runtime;
    this.options = options;
    this.routes = options.routes ?? [];
    this.storageRoutes = options.storageRoutes ?? [];
    this.componentRoutes = options.componentRoutes ?? [];
    return Promise.resolve({
      // A sentinel URL — the Worker owns the real ingress URL; the DO never learns it.
      url: "do://helipod",
      // The shipped portless sentinel (`host.ts:34`) — NOT "unbound/failed".
      port: 0,
      // A DO has no shutdown moment; durable work survives without this. No-op by design.
      close: () => Promise.resolve(),
      setRoutes: (r) => {
        this.routes = r;
      },
    });
  }

  /** Dispatch one non-WebSocket request through the shipped pure dispatcher. Called by the DO's
   *  `fetch` after it has ruled out a WS upgrade. Throws if `serve()` hasn't run (a programming error). */
  async fetch(request: Request): Promise<Response> {
    if (!this.runtime || !this.options) throw new Error("[runtime-cloudflare] DurableObjectRuntimeHost.fetch before serve()");
    const url = new URL(request.url);
    const method = request.method;

    // Engine-owned reserved routes, ahead of the pure dispatcher (mirrors `server.ts`): the
    // `/api/storage/*` byte endpoints, then component (OAuth) callbacks. Their handlers consume the
    // native `Request` directly (reading `arrayBuffer()`/`json()` themselves) and stream a native
    // `Response` — so we hand `request` off UNCONSUMED, without reading the body below.
    const storageRoute = matchStorageRoute(this.storageRoutes, method, url.pathname);
    if (storageRoute) return storageRoute.handler(request);
    const componentRoute = matchComponentRoute(this.componentRoutes, method, url.pathname);
    if (componentRoute) return componentRoute.handler(request);

    const body = method === "POST" || method === "PUT" || method === "PATCH" ? await request.text() : undefined;
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (query[k] = v));
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    const info = { functions: this.runtime.functionPaths(), tables: this.runtime.tableNames() };
    const res = await handleHttpRequest(
      this.runtime,
      { method, path: url.pathname, body, query, authorization: request.headers.get("authorization") ?? undefined, headers },
      info,
      this.options.admin,
      this.routes,
    );
    return new Response(res.body, { status: res.status, headers: res.headers });
  }
}
