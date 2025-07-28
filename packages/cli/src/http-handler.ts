/**
 * HTTP routing for the dev server — a pure function over the runtime so it's testable without
 * a socket. Routes: the `_dashboard` status page, a health check, `POST /api/run` for direct
 * function invocation, and `/_admin/*` for the admin API (behind an admin key).
 */
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import { getHttpStatus, toStackbaseError } from "@stackbase/errors";
import { matchRoute } from "@stackbase/executor";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { handleAdminRequest, verifyAdminKey, type AdminApi } from "@stackbase/admin";
import type { ResolvedRoute } from "./project";
import type { DeployResult } from "./deploy-apply";

export interface HttpRequest {
  method: string;
  path: string;
  body?: string;
  query?: Record<string, string>;
  authorization?: string;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface ServerInfo {
  functions: string[];
  tables: string[];
}

function json(status: number, value: unknown): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}
function html(body: string): HttpResponse {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body };
}

function bearer(authorization?: string): string | undefined {
  const m = /^Bearer (.+)$/.exec(authorization ?? "");
  return m ? m[1] : undefined;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function dashboardHtml(info: ServerInfo): string {
  const li = (items: string[]) => items.map((i) => `<li><code>${escapeHtml(i)}</code></li>`).join("") || "<li><em>none</em></li>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Stackbase</title>
<style>body{font:14px system-ui;margin:2rem;max-width:48rem}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:4px}</style>
</head><body>
<h1>Stackbase — dev</h1>
<p>The reactive backend is running.</p>
<h2>Tables (${info.tables.length})</h2><ul>${li(info.tables)}</ul>
<h2>Functions (${info.functions.length})</h2><ul>${li(info.functions)}</ul>
</body></html>`;
}

export async function handleHttpRequest(
  runtime: EmbeddedRuntime,
  req: HttpRequest,
  info: ServerInfo,
  admin?: { api: AdminApi; key: string },
  routes?: ResolvedRoute[],
  deploy?: { apply: (files: Array<{ path: string; code: string }>) => Promise<DeployResult> },
): Promise<HttpResponse> {
  if (admin && deploy && req.method === "POST" && req.path === "/_admin/deploy") {
    if (!verifyAdminKey(admin.key, bearer(req.authorization))) return json(401, { ok: false, error: "unauthorized" });
    let files: Array<{ path: string; code: string }>;
    try {
      files = (JSON.parse(req.body ?? "{}") as { files?: Array<{ path: string; code: string }> }).files ?? [];
    } catch {
      return json(400, { ok: false, kind: "load-error", error: "invalid deploy payload" });
    }
    const result = await deploy.apply(files);
    return json(result.ok ? 200 : result.kind === "schema-incompatible" ? 409 : 400, result);
  }
  if (admin && req.path.startsWith("/_admin/")) {
    const res = await handleAdminRequest(admin.api, admin.key, {
      method: req.method,
      path: req.path,
      query: req.query ?? {},
      body: req.body,
      authorization: req.authorization,
    });
    return json(res.status, res.body);
  }
  if (req.method === "GET" && (req.path === "/_dashboard" || req.path === "/_dashboard/")) {
    return html(dashboardHtml(info));
  }
  if (req.method === "GET" && req.path === "/api/health") {
    return json(200, { status: "ok", functions: info.functions.length, tables: info.tables.length });
  }
  if (req.method === "POST" && req.path === "/api/run") {
    try {
      const parsed = JSON.parse(req.body ?? "{}") as { path?: string; args?: JSONValue };
      if (!parsed.path) return json(400, { error: "missing function path" });
      const result = await runtime.run(parsed.path, parsed.args ?? {});
      return json(200, { value: convexToJson(result.value as Value), committed: result.committed });
    } catch (e) {
      const err = toStackbaseError(e);
      return json(getHttpStatus(err), { error: err.message, code: err.code });
    }
  }
  // User httpAction routes — matched AFTER the built-ins, only for non-reserved paths.
  const match = routes && routes.length > 0 ? matchRoute(routes, req.method, req.path) : undefined;
  if (match) {
    try {
      const headers = new Headers(req.headers ?? {});
      if (req.authorization && !headers.has("authorization")) headers.set("authorization", req.authorization);
      const qs = req.query && Object.keys(req.query).length ? "?" + new URLSearchParams(req.query).toString() : "";
      const host = headers.get("host") ?? "localhost";
      const url = `http://${host}${req.path}${qs}`;
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
      const request = new Request(url, { method: req.method, headers, ...(hasBody ? { body: req.body } : {}) });

      const auth = headers.get("authorization") ?? "";
      const identity = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;

      const response = await runtime.runHttpAction(match.handlerPath, request, { identity });
      if (!(response instanceof Response)) {
        return json(500, { error: "httpAction must return a Response" });
      }
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { outHeaders[k] = v; });
      return { status: response.status, headers: outHeaders, body: await response.text() };
    } catch (e) {
      const err = toStackbaseError(e);
      return json(getHttpStatus(err), { error: err.message, code: err.code });
    }
  }

  return json(404, { error: "not found" });
}
