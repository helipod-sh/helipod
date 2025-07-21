/**
 * The public HTTP router — a pure route table an app builds in its `http.ts` and default-exports.
 * Holds httpAction handler VALUES; project loading (packages/cli) resolves each to its function
 * path for dispatch. `matchRoute` is the shared lookup used by both this router and the dev server.
 */
import type { RegisteredFunction } from "./functions";

export interface RouteSpec {
  path?: string;
  pathPrefix?: string;
  method: string;
  handler: RegisteredFunction;
}
export interface RouteEntry {
  method: string;
  path?: string;
  pathPrefix?: string;
  handler: RegisteredFunction;
}
export interface HttpRouter {
  route(spec: RouteSpec): void;
  readonly routes: RouteEntry[];
  lookup(method: string, path: string): RouteEntry | undefined;
}

/** `/api/*` and any path whose first segment starts with `_` are reserved for the engine. */
export function isReservedHttpPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/") || /^\/_/.test(path);
}

/** Exact `path` match wins; else the longest matching `pathPrefix`; method must always match. */
export function matchRoute<R extends { method: string; path?: string; pathPrefix?: string }>(
  routes: readonly R[],
  method: string,
  path: string,
): R | undefined {
  let best: R | undefined;
  let bestLen = -1;
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.path !== undefined) {
      if (r.path === path) return r; // exact match: highest precedence, return immediately
      continue;
    }
    if (r.pathPrefix !== undefined && path.startsWith(r.pathPrefix) && r.pathPrefix.length > bestLen) {
      best = r;
      bestLen = r.pathPrefix.length;
    }
  }
  return best;
}

export function httpRouter(): HttpRouter {
  const routes: RouteEntry[] = [];
  return {
    routes,
    route(spec) {
      const hasPath = spec.path !== undefined;
      const hasPrefix = spec.pathPrefix !== undefined;
      if (hasPath === hasPrefix) throw new Error("http.route requires exactly one of `path` or `pathPrefix`");
      const p = (spec.path ?? spec.pathPrefix)!;
      if (isReservedHttpPath(p)) throw new Error(`http.route path "${p}" is reserved (/api/* and /_* belong to the engine)`);
      routes.push({ method: spec.method, ...(hasPath ? { path: spec.path } : { pathPrefix: spec.pathPrefix }), handler: spec.handler });
    },
    lookup(method, path) {
      return matchRoute(routes, method, path);
    },
  };
}
