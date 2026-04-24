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
 * request here, and this reuses the SHIPPED pure dispatcher (`handleHttpRequest`): `/api/health`,
 * `/api/run` (the transactor path — inline fan-out on commit, decision 5), `/_admin/*` (incl.
 * `/_admin/wake` → `runtime.fireDueTimers()`), and user httpAction routes. This is the single place
 * that turns a `Request` into the dispatcher's `HttpRequest` shape and back.
 */
import type { EmbeddedRuntime, RuntimeHost, ServeOptions, ServerHandle } from "@stackbase/runtime-embedded";
import type { AdminApi } from "@stackbase/admin";
import type { ResolvedRoute } from "@stackbase/cli/project";
import { handleHttpRequest } from "@stackbase/cli/http-handler";

/** The DO host pins the neutral seam's generics to the concrete types its dispatcher consumes. Deploy
 *  and fleet are Slice-6/container-path concerns, absent on a DO — left at the seam default. */
export type DurableObjectServeOptions = ServeOptions<ResolvedRoute, AdminApi>;
export type DurableObjectServerHandle = ServerHandle<ResolvedRoute>;

export class DurableObjectRuntimeHost implements RuntimeHost<ResolvedRoute, AdminApi> {
  private runtime: EmbeddedRuntime | null = null;
  private options: DurableObjectServeOptions | null = null;
  private routes: ResolvedRoute[] = [];

  serve(runtime: EmbeddedRuntime, options: DurableObjectServeOptions): Promise<DurableObjectServerHandle> {
    this.runtime = runtime;
    this.options = options;
    this.routes = options.routes ?? [];
    return Promise.resolve({
      // A sentinel URL — the Worker owns the real ingress URL; the DO never learns it.
      url: "do://stackbase",
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
