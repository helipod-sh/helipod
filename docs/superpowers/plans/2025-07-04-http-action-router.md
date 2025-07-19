# httpAction + public HTTP router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an app expose HTTP endpoints (webhooks, OAuth callbacks, small REST/JSON surfaces) as `httpAction` functions routed by a public HTTP router, running with the full action capability set and fanning writes out reactively via `ctx.runMutation`.

**Architecture:** An `httpAction` is an **action variant** — same non-deterministic profile (`HTTP_ACTION_PROFILE`, already in `profile.ts`: no `ctx.db`, native `fetch`/clock/random), same out-of-transaction execution, same `ctx.runQuery`/`runMutation`/`runAction` orchestration via the executor's `invoke` seam. Its only difference is I/O shape: the handler takes a Web `Request` and returns a Web `Response`. A conventional `http.ts` default-exports an `HttpRouter` (route table); project loading resolves each route's handler to its function path; the dev server matches incoming requests against the resolved table (after its reserved built-in routes) and dispatches to `runtime.runHttpAction`.

**Tech Stack:** TypeScript, Bun (package manager + runtime), vitest (under Bun), Turborepo. Web Fetch API `Request`/`Response`. Packages touched: `@stackbase/executor`, `@stackbase/runtime-embedded`, `@stackbase/cli`, `@stackbase/codegen`.

## Global Constraints

- **Bun only.** Never `npm`/`pnpm`/`yarn`. Per-package tests: `bun run --filter <pkg> test`. Whole workspace: `bun run build && bun run typecheck && bun run test`. All must be green before a task's commit.
- **`httpAction` is an action variant:** runs OUTSIDE any transaction; NO `ctx.db`; native `fetch`/clock/random (`HTTP_ACTION_PROFILE`); data access ONLY via `ctx.runQuery`/`runMutation`/`runAction` (the executor's `invoke` seam). Reuse the existing action ctx builder (`runActionFn`) — do not fork a parallel context.
- **Bare Convex-parity paths.** User routes match at bare paths (`POST /stripe`). `/api/*` and `/_*` (any path whose first segment starts with `_`, e.g. `/_admin`, `/_dashboard`) are RESERVED — a route registered under them throws at `route()` time.
- **Path matching:** exact `path` OR `pathPrefix` (exactly one per route), no named params. Precedence: an exact `path` match wins; otherwise the LONGEST matching `pathPrefix` for that method wins. Method must match.
- **Discovery:** the project's `http.ts` module default-exports the `HttpRouter`. No other file is scanned for routes.
- **Identity is the raw session token** (`packages/sync/src/handler.ts:235` sets `session.identity = msg.token`; `components/auth/src/context.ts:11` resolves `cctx.identity` as a session token). Extract the token from `Authorization: Bearer <token>` and pass it as `opts.identity`; absent/malformed → `null` (the handler still runs and can self-auth from raw headers).
- **Buffered body (v1).** Read the full request body; return a full `Response`. Response bodies are serialized as UTF-8 text (`HttpResponse.body: string`) — text/JSON fully supported; streaming and non-UTF-8 binary response bodies are deferred (non-goal).
- **Errors:** handler throws/rejects → `500`; handler returns a non-`Response` → `500` ("httpAction must return a Response"); no route matches → fall through to existing static/404; route under a reserved prefix → error at load; body over the existing `/api/run` size limit → `413`; method mismatch → `404` fall-through (no `405` in v1).
- **Definers live in `packages/executor`** and are re-exported through the generated `_generated/server` template — there is no `packages/server`.
- Never let engine code learn which database it is on (no adapter-specific leaks). N/A to this slice but holds.

---

## File Structure

- `packages/executor/src/functions.ts` — **modify**: add the `httpAction` definer next to `action`.
- `packages/executor/src/executor.ts` — **modify**: replace the `httpAction` throw (line ~159); generalize `runActionFn` to take a `logKind`.
- `packages/executor/src/http-router.ts` — **create**: `httpRouter()`/`HttpRouter` (authoring surface, holds handler values) + `matchRoute()` (pure lookup, exact>longest-prefix) + reserved-prefix validation.
- `packages/executor/src/index.ts` — **modify**: export `httpAction`, `httpRouter`, and the router types.
- `packages/runtime-embedded/src/runtime.ts` — **modify**: add `runHttpAction(path, request, opts)` (mirrors `runAction`, passes the `Request` through untouched, returns the `Response`).
- `packages/cli/src/project.ts` — **modify**: recognize `type:"httpAction"` in the moduleMap/manifest; extract the `http` module's default router; resolve each route's handler value → its function path into `ProjectArtifacts.routes`.
- `packages/cli/src/http-handler.ts` — **modify**: add `headers` to `HttpRequest`; add the route-dispatch arm (after built-ins, before 404): build a `Request`, resolve the Bearer token, call `runHttpAction`, translate the `Response`.
- `packages/cli/src/server.ts` — **modify**: capture all request headers into `HttpRequest.headers`; thread the resolved `routes` into `handleHttpRequest` (both Node and Bun backends).
- `packages/cli/src/cli.ts` — **modify**: thread `artifacts.routes` from load → `startDevServer`/reload path.
- `packages/codegen/src/generate.ts` — **modify**: the generated `server.ts` re-exports `httpAction`/`httpRouter`; `UdfType` gains `httpAction` where the manifest needs it.
- Tests: `packages/executor/test/http-action.test.ts`, `packages/executor/test/http-router.test.ts`, `packages/runtime-embedded/test/http-action.test.ts`, `packages/cli/test/http-routing.test.ts`, `packages/cli/test/http-action-e2e.test.ts`.
- `CLAUDE.md`, `examples/auth-demo/convex/http.ts` — **modify/create**: docs + a runnable example.

---

## Task 1: `httpAction` definer + executor run path

**Files:**
- Modify: `packages/executor/src/functions.ts`
- Modify: `packages/executor/src/executor.ts:158-160` (the type dispatch) and the `runActionFn` method
- Modify: `packages/executor/src/index.ts:22`
- Test: `packages/executor/test/http-action.test.ts`

**Interfaces:**
- Produces: `httpAction(def): RegisteredFunction` where `def` is `((ctx, request: Request) => Response | Promise<Response>)` or `{ handler: same }`, tagged `type: "httpAction"`. The executor runs it exactly like an action (native ctx: `runQuery`/`runMutation`/`runAction`; NO `ctx.db`), passing the `Request` as the handler's second arg and returning the handler's `Response` as `UdfResult.value` (no serialization).

- [ ] **Step 1: Write the failing test** (`packages/executor/test/http-action.test.ts`)

Mirror the harness of the existing action executor test (read `packages/executor/test/` for the file that constructs `InlineUdfExecutor` with an `invoke` stub — reuse its `ExecutorDeps` setup verbatim). The two behaviors to assert:

```ts
import { describe, it, expect } from "vitest";
import { httpAction, action, InlineUdfExecutor } from "../src";
// ... reuse the sibling action test's makeExecutor()/deps harness (transactor, catalog, queryRuntime, invoke stub) ...

describe("httpAction executor", () => {
  it("runs a Request -> Response handler outside any txn, no ctx.db", async () => {
    const seen: unknown[] = [];
    const fn = httpAction(async (ctx, request: Request) => {
      seen.push((ctx as { db?: unknown }).db);           // must be undefined
      const body = await request.text();
      return new Response(`echo:${body}`, { status: 201, headers: { "x-test": "1" } });
    });
    const exec = makeExecutor();                          // from the sibling harness
    const req = new Request("http://x/webhook", { method: "POST", body: "hi" });
    const res = await exec.run(fn, req, { path: "http:echo" });
    const response = res.value as Response;
    expect(seen[0]).toBeUndefined();                      // no ctx.db on an httpAction
    expect(response.status).toBe(201);
    expect(response.headers.get("x-test")).toBe("1");
    expect(await response.text()).toBe("echo:hi");
    expect(res.committed).toBe(false);                    // ran outside any txn
  });

  it("ctx.runMutation reaches the invoke seam", async () => {
    const calls: Array<{ path: string; args: unknown }> = [];
    const fn = httpAction(async (ctx) => {
      await (ctx as { runMutation: (p: string, a: unknown) => Promise<unknown> }).runMutation("app:mark", { id: 1 });
      return new Response("ok");
    });
    const exec = makeExecutor({ onInvoke: (path, args) => { calls.push({ path, args }); return { value: null }; } });
    await exec.run(fn, new Request("http://x/w", { method: "POST" }), { path: "http:m" });
    expect(calls).toEqual([{ path: "app:mark", args: { id: 1 } }]);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/executor test http-action`
Expected: FAIL — `httpAction` is not exported / executor throws `"the inline executor does not yet run httpAction functions"`.

- [ ] **Step 3: Add the `httpAction` definer** (`packages/executor/src/functions.ts`, after `action`)

```ts
type HttpActionDef =
  | { handler: (ctx: unknown, request: Request) => Response | Promise<Response> }
  | ((ctx: unknown, request: Request) => Response | Promise<Response>);

/**
 * `httpAction` — an action whose I/O is a raw Web `Request` -> `Response` (instead of JSON
 * args -> value). Same non-deterministic context as `action` (runQuery/runMutation/runAction,
 * native fetch/clock; NO ctx.db); routed by the public HTTP router (see `./http-router.ts`).
 */
export function httpAction(def: HttpActionDef): RegisteredFunction {
  const handler = typeof def === "function" ? def : def.handler;
  return { type: "httpAction", handler: handler as RegisteredFunction["handler"] };
}
```

- [ ] **Step 4: Wire the executor** (`packages/executor/src/executor.ts`)

Change the type dispatch (line ~159-160) so httpAction reuses the action ctx builder with a distinct log kind:

```ts
    if (fn.type === "httpAction") return this.runActionFn<T>(fn, args, options, "httpAction");
    if (fn.type === "action") return this.runActionFn<T>(fn, args, options);
```

Generalize `runActionFn`'s signature and its two `logSink.push` calls to use the passed kind:

```ts
  private async runActionFn<T>(
    fn: RegisteredFunction,
    args: unknown,
    options: RunOptions,
    logKind: LogKind = "action",
  ): Promise<UdfResult<T>> {
```

and in BOTH `this.deps.logSink?.push({ ... kind: "action" ... })` calls inside that method, replace `kind: "action"` with `kind: logKind`. Everything else in `runActionFn` is unchanged — it already passes `args` straight to `fn.handler(actionCtx, args)` (so a `Request` flows through untouched) and returns `{ value, committed: false, ... }` (so a `Response` is returned unserialized).

> If `LogKind` (imported in this file) does not already include `"httpAction"`, add it to the `LogKind` union at its definition (`@stackbase/errors` or wherever `logSink` types live — grep `type LogKind`). The `UdfType` union in `profile.ts` already includes `"httpAction"`.

- [ ] **Step 5: Export it** (`packages/executor/src/index.ts:22`)

```ts
export { query, mutation, action, httpAction } from "./functions";
```

- [ ] **Step 6: Run the test — verify it passes**

Run: `bun run --filter @stackbase/executor test http-action`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add packages/executor/src/functions.ts packages/executor/src/executor.ts packages/executor/src/index.ts packages/executor/test/http-action.test.ts
git commit -m "feat(executor): httpAction definer + run path (an action whose I/O is Request->Response)"
```

---

## Task 2: `HttpRouter` + `matchRoute` (the pure route table)

**Files:**
- Create: `packages/executor/src/http-router.ts`
- Modify: `packages/executor/src/index.ts`
- Test: `packages/executor/test/http-router.test.ts`

**Interfaces:**
- Consumes: `RegisteredFunction` (Task 1's `httpAction` produces these; a route's `handler` is one).
- Produces:
  - `httpRouter(): HttpRouter` where `HttpRouter = { route(spec: RouteSpec): void; readonly routes: RouteEntry[]; lookup(method: string, path: string): RouteEntry | undefined }`.
  - `RouteSpec = { path?: string; pathPrefix?: string; method: string; handler: RegisteredFunction }` (exactly one of `path`/`pathPrefix`).
  - `RouteEntry = { method: string; path?: string; pathPrefix?: string; handler: RegisteredFunction }`.
  - `matchRoute<R extends { method: string; path?: string; pathPrefix?: string }>(routes: readonly R[], method: string, path: string): R | undefined` — pure; exact `path` wins, else longest matching `pathPrefix`; method must match. Used by BOTH the authoring router's `lookup` and (Task 5) the server on the resolved table.
  - `isReservedHttpPath(path: string): boolean` — true for a path under `/api/` or whose first segment starts with `_`.

- [ ] **Step 1: Write the failing test** (`packages/executor/test/http-router.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { httpRouter, matchRoute, isReservedHttpPath, type RouteEntry } from "../src";

const fn = (n: string) => ({ type: "httpAction" as const, handler: () => new Response(n) });

describe("httpRouter registration", () => {
  it("requires exactly one of path / pathPrefix", () => {
    const r = httpRouter();
    expect(() => r.route({ method: "GET", handler: fn("a") } as never)).toThrow(/exactly one of/);
    expect(() => r.route({ path: "/a", pathPrefix: "/a/", method: "GET", handler: fn("a") } as never)).toThrow(/exactly one of/);
  });
  it("rejects reserved prefixes at registration", () => {
    const r = httpRouter();
    expect(() => r.route({ path: "/api/run", method: "POST", handler: fn("x") })).toThrow(/reserved/);
    expect(() => r.route({ pathPrefix: "/_admin/", method: "GET", handler: fn("x") })).toThrow(/reserved/);
  });
  it("records routes", () => {
    const r = httpRouter();
    const h = fn("s");
    r.route({ path: "/stripe", method: "POST", handler: h });
    expect(r.routes).toEqual([{ method: "POST", path: "/stripe", handler: h }]);
  });
});

describe("matchRoute", () => {
  const routes: RouteEntry[] = [
    { method: "POST", path: "/stripe", handler: fn("exact") },
    { method: "GET", pathPrefix: "/oauth/", handler: fn("short") },
    { method: "GET", pathPrefix: "/oauth/google/", handler: fn("long") },
  ];
  it("exact path + method", () => {
    expect(matchRoute(routes, "POST", "/stripe")?.handler).toBe(routes[0].handler);
  });
  it("method mismatch -> undefined", () => {
    expect(matchRoute(routes, "GET", "/stripe")).toBeUndefined();
  });
  it("longest matching prefix wins", () => {
    expect(matchRoute(routes, "GET", "/oauth/google/cb")?.handler).toBe(routes[2].handler);
    expect(matchRoute(routes, "GET", "/oauth/github/cb")?.handler).toBe(routes[1].handler);
  });
  it("no match -> undefined", () => {
    expect(matchRoute(routes, "GET", "/nope")).toBeUndefined();
  });
});

describe("isReservedHttpPath", () => {
  it("reserves /api/* and /_*", () => {
    expect(isReservedHttpPath("/api/run")).toBe(true);
    expect(isReservedHttpPath("/_admin/x")).toBe(true);
    expect(isReservedHttpPath("/_dashboard")).toBe(true);
    expect(isReservedHttpPath("/stripe")).toBe(false);
    expect(isReservedHttpPath("/webhooks/x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/executor test http-router`
Expected: FAIL — module `../src` has no `httpRouter`/`matchRoute`/`isReservedHttpPath`.

- [ ] **Step 3: Implement** (`packages/executor/src/http-router.ts`)

```ts
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
```

- [ ] **Step 4: Export** (`packages/executor/src/index.ts`)

Add:
```ts
export { httpRouter, matchRoute, isReservedHttpPath } from "./http-router";
export type { HttpRouter, RouteSpec, RouteEntry } from "./http-router";
```

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun run --filter @stackbase/executor test http-router`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/executor/src/http-router.ts packages/executor/src/index.ts packages/executor/test/http-router.test.ts
git commit -m "feat(executor): HttpRouter + matchRoute (exact>longest-prefix) + reserved-path guard"
```

---

## Task 3: `runtime.runHttpAction`

**Files:**
- Modify: `packages/runtime-embedded/src/runtime.ts` (add the method near `runAction`, ~line 355)
- Test: `packages/runtime-embedded/test/http-action.test.ts`

**Interfaces:**
- Consumes: Task 1's executor httpAction path; `isInternalPath` (already used by `run`/`runAction`).
- Produces: `runHttpAction(path: string, request: Request, opts?: { identity?: string | null }): Promise<Response>` on `EmbeddedRuntime` — looks the path up in `this.modules`, requires `fn.type === "httpAction"`, runs it through the executor passing the `Request` **untouched** (NOT `jsonToConvex`), returns the handler's `Response`. Gated: `isInternalPath(path)` throws `FunctionNotFoundError`.

- [ ] **Step 1: Write the failing test** (`packages/runtime-embedded/test/http-action.test.ts`)

Mirror the sibling action runtime test's setup (read `packages/runtime-embedded/test/` for how it builds a runtime via `createEmbeddedRuntime`/`setModules` with an httpAction module). Assert:

```ts
it("runHttpAction runs an httpAction by path and returns its Response", async () => {
  // modules: { "http:ping": httpAction(async () => new Response("pong", { status: 200 })) }
  const res = await runtime.runHttpAction("http:ping", new Request("http://x/ping", { method: "GET" }));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("pong");
});
it("threads identity and rejects internal paths", async () => {
  // module "http:whoami" returns new Response(<the identity it saw via a runQuery/ctx.auth stub>)
  await expect(runtime.runHttpAction("http:_secret", new Request("http://x/s"))).rejects.toThrow(/unknown function/);
});
it("rejects a non-httpAction path", async () => {
  await expect(runtime.runHttpAction("app:someQuery", new Request("http://x/q"))).rejects.toThrow(/not an httpAction/);
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/runtime-embedded test http-action`
Expected: FAIL — `runHttpAction` is not a function.

- [ ] **Step 3: Implement** (`packages/runtime-embedded/src/runtime.ts`, right after `runAction`)

```ts
  /** Directly invoke an httpAction (for the public HTTP router). Passes the raw `Request` through
   *  untouched and returns the handler's `Response`. Public gate: blocks `_`-prefixed paths. */
  async runHttpAction(path: string, request: Request, opts?: { identity?: string | null }): Promise<Response> {
    if (isInternalPath(path)) throw new FunctionNotFoundError(`unknown function: ${path}`);
    const fn = this.modules[path];
    if (!fn) throw new FunctionNotFoundError(`unknown function: ${path}`);
    if (fn.type !== "httpAction") throw new Error(`${path} is not an httpAction`);
    const result = await this.executor.run<Response>(fn, request as unknown as never, {
      path,
      namespace: namespaceForPath(path, this.componentNames),
      contextProviders: this.contextProviders,
      policyRegistry: this.policyRegistry,
      policyProviders: this.policyProviders,
      relationRegistry: this.relationRegistry,
      functionKind: this.functionKind,
      identity: opts?.identity ?? null,
    });
    return result.value;
  }
```

> Note: unlike `run`/`runAction`, do NOT wrap `request` in `jsonToConvex` — the `Request` is passed to the handler as-is (the executor's `runActionFn` forwards `args` directly to the handler). The `as unknown as never` cast bridges `executor.run`'s `args: unknown` parameter without pulling `Request` into the `Value` domain.

- [ ] **Step 4: Run the test — verify it passes**

Run: `bun run --filter @stackbase/runtime-embedded test http-action`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-embedded/src/runtime.ts packages/runtime-embedded/test/http-action.test.ts
git commit -m "feat(runtime): runHttpAction — dispatch an httpAction by path, Request->Response, gated"
```

---

## Task 4: Project loading — register httpActions + resolve the route table

**Files:**
- Modify: `packages/cli/src/project.ts` (recognize `httpAction`; extract + resolve the router)
- Test: `packages/cli/test/http-routing.test.ts`

**Interfaces:**
- Consumes: `loaded.modules` (path → exports, from `loadConvexDir`); the `http` module's `default` export is an `HttpRouter` (Task 2); `RouteEntry` handlers are `RegisteredFunction` values.
- Produces: `ProjectArtifacts.routes: ResolvedRoute[]` where `ResolvedRoute = { method: string; path?: string; pathPrefix?: string; handlerPath: string }`. Also: httpAction exports are now in `composed.moduleMap` (so `runtime.runHttpAction` finds them by path) and in the codegen manifest.

- [ ] **Step 1: Write the failing test** (`packages/cli/test/http-routing.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { httpAction, httpRouter } from "@stackbase/executor";
import { loadProject } from "../src/project";
import { defineSchema } from "@stackbase/values";

function makeLoaded() {
  const ping = httpAction(async () => new Response("pong"));
  const router = httpRouter();
  router.route({ path: "/ping", method: "GET", handler: ping });
  return {
    schema: defineSchema({}),
    modules: {
      http: { ping, default: router },       // http.ts: named httpAction + default-exported router
    },
  };
}

describe("loadProject http routing", () => {
  it("registers httpActions in the moduleMap and resolves routes to paths", () => {
    const art = loadProject(makeLoaded() as never);
    expect(art.moduleMap["http:ping"]?.type).toBe("httpAction");
    expect(art.routes).toEqual([{ method: "GET", path: "/ping", handlerPath: "http:ping" }]);
  });
  it("errors when a route's handler is not an exported httpAction", () => {
    const router = httpRouter();
    router.route({ path: "/x", method: "GET", handler: httpAction(async () => new Response("z")) }); // inline, not exported
    const loaded = { schema: defineSchema({}), modules: { http: { default: router } } };
    expect(() => loadProject(loaded as never)).toThrow(/handler .* must be an exported httpAction/);
  });
}
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/cli test http-routing`
Expected: FAIL — `art.routes` is undefined; httpAction not registered.

- [ ] **Step 3: Add `httpAction` to the codegen manifest** (`packages/cli/src/project.ts:59`)

Registration into `appModuleMap` is ALREADY automatic: line 58 (`appModuleMap[`${path}:${name}`] = value`) runs for every `isRegisteredFunction(value)`, and an `httpAction` IS a `RegisteredFunction` — so `composed.moduleMap["http:ping"]` already exists without any change here (this is what `runtime.runHttpAction` looks up). The `default`-exported router has no `.type`, so `isRegisteredFunction` rejects it — it is NOT registered as a function. Good.

The only change needed is the MANIFEST push (line 59), so httpActions appear in codegen/the dashboard listing:
```ts
      if (value.type === "query" || value.type === "mutation" || value.type === "action" || value.type === "httpAction") {
        functions.push({ name, type: value.type, visibility: "public" });
```
This requires `AnalyzedFunction["type"]` / `UdfType` in `@stackbase/codegen` to include `"httpAction"`. Widen it now (it is a compile dependency for this push): in `packages/codegen/src/generate.ts:12` change `export type UdfType = "query" | "mutation" | "action" | "httpAction";` and check any exhaustive `switch`/mapped-type over `UdfType` in that file still compiles (httpActions are listed in the manifest but are NOT added to the callable `api` object — they are HTTP endpoints, never invoked via `ctx.run*` by path). Grep `AnalyzedFunction` in `packages/codegen/src` and confirm its `type` field flows from `UdfType`; widen at the single source.

- [ ] **Step 4: Extract + resolve the router into `ProjectArtifacts.routes`** (`packages/cli/src/project.ts`)

Add the `ResolvedRoute` type and a resolution step. After `composed` is built (so `composed.moduleMap` has every registered function under its path), do:

```ts
export interface ResolvedRoute {
  method: string;
  path?: string;
  pathPrefix?: string;
  handlerPath: string;
}

// ... inside loadProject, after building `composed` and before the return:
const routes: ResolvedRoute[] = [];
const router = loaded.modules["http"]?.default as { routes?: Array<{ method: string; path?: string; pathPrefix?: string; handler: RegisteredFunction }> } | undefined;
if (router?.routes) {
  // identity map: RegisteredFunction value -> its function path, over the APP moduleMap.
  const pathByFn = new Map<RegisteredFunction, string>();
  for (const [path, fn] of Object.entries(appModuleMap)) pathByFn.set(fn, path);
  for (const r of router.routes) {
    const handlerPath = pathByFn.get(r.handler);
    if (!handlerPath) {
      const where = r.path ?? r.pathPrefix ?? "?";
      throw new Error(`http.route for "${where}" handler must be an exported httpAction (declare it as a named export of an app module)`);
    }
    routes.push({ method: r.method, ...(r.path !== undefined ? { path: r.path } : { pathPrefix: r.pathPrefix }), handlerPath });
  }
}
```

Add `routes` to the returned `ProjectArtifacts` object and to its interface (`routes: ResolvedRoute[]`).

> `appModuleMap` keys are the app-level function paths (e.g. `"http:ping"`) — the SAME identity objects the router references, because `loaded.modules["http"].ping` and the router's `handler` are the same `RegisteredFunction`. Use `appModuleMap` (app functions), not `composed.moduleMap` (which also holds component-namespaced functions) for the identity map. Confirm `appModuleMap`'s key format matches what `runtime.runHttpAction` will look up (Task 3 uses `this.modules[path]`, and `this.modules` is `composed.moduleMap`, which includes the app functions under the same keys — verify `"http:ping"` is present in `composed.moduleMap`).

- [ ] **Step 5: Run the test — verify it passes**

Run: `bun run --filter @stackbase/cli test http-routing`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/project.ts packages/cli/test/http-routing.test.ts
git commit -m "feat(cli): register httpActions + resolve http.ts router to a path-keyed route table"
```

---

## Task 5: Server dispatch — route incoming requests to httpActions

**Files:**
- Modify: `packages/cli/src/http-handler.ts` (add `headers` to `HttpRequest`; the dispatch arm)
- Modify: `packages/cli/src/server.ts` (capture all headers; thread `routes` into `handleHttpRequest` — both backends)
- Modify: `packages/cli/src/cli.ts` (thread `artifacts.routes` into the server + reload)
- Test: extend `packages/cli/test/http-routing.test.ts` with `handleHttpRequest` cases

**Interfaces:**
- Consumes: `runtime.runHttpAction` (Task 3); `matchRoute` (Task 2); `ResolvedRoute[]` (Task 4).
- Produces: `handleHttpRequest(runtime, req, info, admin?, routes?: ResolvedRoute[])`. `HttpRequest` gains `headers?: Record<string, string>`. A matched request is dispatched to the httpAction; its `Response` becomes the `HttpResponse`.

- [ ] **Step 1: Write the failing test** (extend `packages/cli/test/http-routing.test.ts`)

Build a real runtime via `createEmbeddedRuntime` with an httpAction that echoes a header and body (mirror how `packages/cli/test/action-e2e.test.ts` or `http-handler`-level tests construct the runtime — a runtime-level test, not the full socket server). Then:

```ts
it("dispatches a matched route to the httpAction and returns its Response", async () => {
  // runtime modules: { "http:echo": httpAction(async (_c, req) => new Response(`m:${req.method} b:${await req.text()} h:${req.headers.get("x-sig")}`, { status: 200 })) }
  const routes = [{ method: "POST", path: "/echo", handlerPath: "http:echo" }];
  const res = await handleHttpRequest(runtime, {
    method: "POST", path: "/echo", body: "hi", headers: { "x-sig": "abc" },
  }, info, undefined, routes);
  expect(res.status).toBe(200);
  expect(res.body).toBe("m:POST b:hi h:abc");
});
it("unmatched path falls through to 404", async () => {
  const res = await handleHttpRequest(runtime, { method: "GET", path: "/nope" }, info, undefined, []);
  expect(res.status).toBe(404);
});
it("a throwing httpAction becomes 500", async () => {
  // modules: { "http:boom": httpAction(async () => { throw new Error("kaboom"); }) }
  const res = await handleHttpRequest(runtime, { method: "POST", path: "/boom" }, info, undefined, [{ method: "POST", path: "/boom", handlerPath: "http:boom" }]);
  expect(res.status).toBe(500);
});
it("built-in routes still win over user routes", async () => {
  const res = await handleHttpRequest(runtime, { method: "GET", path: "/api/health" }, info, undefined, [{ method: "GET", pathPrefix: "/", handlerPath: "http:echo" }]);
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body).status).toBe("ok"); // health, not the catch-all httpAction
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `bun run --filter @stackbase/cli test http-routing`
Expected: FAIL — `handleHttpRequest` ignores `routes`; `/echo` returns 404.

- [ ] **Step 3: Extend `HttpRequest` + add the dispatch arm** (`packages/cli/src/http-handler.ts`)

Add `headers` to the interface:
```ts
export interface HttpRequest {
  method: string;
  path: string;
  body?: string;
  query?: Record<string, string>;
  authorization?: string;
  headers?: Record<string, string>;
}
```

Update the signature and add the dispatch arm AFTER the `POST /api/run` block and BEFORE the final `return json(404, ...)`:

```ts
import { convexToJson, type JSONValue, type Value } from "@stackbase/values";
import { getHttpStatus, toStackbaseError } from "@stackbase/errors";
import { matchRoute } from "@stackbase/executor";
import type { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { handleAdminRequest, type AdminApi } from "@stackbase/admin";
import type { ResolvedRoute } from "./project";   // defined + exported in Task 4 — single source of truth

export async function handleHttpRequest(
  runtime: EmbeddedRuntime,
  req: HttpRequest,
  info: ServerInfo,
  admin?: { api: AdminApi; key: string },
  routes?: ResolvedRoute[],
): Promise<HttpResponse> {
  // ... existing built-in arms unchanged (/_admin, /_dashboard, /api/health, POST /api/run) ...

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
```

> The built-in arms already short-circuit before this block, so a user `pathPrefix: "/"` cannot shadow `/api/*` or `/_*` (those return first). The `413` body-size limit is enforced upstream in `server.ts`'s `readBody` (unchanged) — an over-limit body never reaches here.

- [ ] **Step 4: Capture headers + thread `routes` in the server** (`packages/cli/src/server.ts`)

In BOTH `startNodeServer` (~line 100-125) and `startBunServer` (~line 213-243), where the `HttpRequest` object is built (`{ method, path, body, query, authorization }`), add `headers`:
- Node: `headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")) as Record<string, string>`.
- Bun: `headers: Object.fromEntries(req.headers)` (Bun's `req.headers` is a `Headers`).

And pass a `routes` value into `handleHttpRequest(runtime, httpReq, info, admin, routes)`. Thread `routes` in via `DevServerOptions` (add `routes?: ResolvedRoute[]` to that interface) so `startDevServer`/`startNodeServer`/`startBunServer` receive it. Import `ResolvedRoute` from `./http-handler`.

- [ ] **Step 5: Thread routes from load + reload** (`packages/cli/src/cli.ts`)

Where `startDevServer(runtime, info, options)` is called after the initial `loadProject` (~line 75+), pass `options.routes = artifacts.routes` (the `ProjectArtifacts.routes` from Task 4). On hot reload (where `runtime.setModules(next.project.moduleMap)` is called, ~line 123), also update the server's route table for the next request. If the server reads `options.routes` by reference per request, mutate the array in place: `options.routes.length = 0; options.routes.push(...next.project.routes)`. Otherwise add a `devServer.setRoutes(next.project.routes)` mirroring `setModules`. Pick whichever matches how `setModules` already propagates to the running server — grep `setModules` in `server.ts`/`cli.ts` and follow the same mechanism.

- [ ] **Step 6: Run the tests — verify they pass**

Run: `bun run --filter @stackbase/cli test http-routing`
Expected: PASS (all dispatch cases).

- [ ] **Step 7: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add packages/cli/src/http-handler.ts packages/cli/src/server.ts packages/cli/src/cli.ts packages/cli/test/http-routing.test.ts
git commit -m "feat(cli): dispatch public httpAction routes (after built-ins) — Request->Response, Bearer identity"
```

---

## Task 6: Codegen re-export, example, E2E through the dev server, docs

**Files:**
- Modify: `packages/codegen/src/generate.ts` (generated `server.ts` re-exports; `UdfType`)
- Create: `examples/auth-demo/convex/http.ts`
- Create: `packages/cli/test/http-action-e2e.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything from Tasks 1-5, through the real `stackbase dev` server.

- [ ] **Step 1: Codegen re-export** (`packages/codegen/src/generate.ts`)

Update the generated `server.ts` content (line ~183) to also export `httpAction`/`httpRouter`:
```ts
  const content = `${options.header ?? DEFAULT_HEADER}export { query, mutation, action, httpAction, httpRouter } from "@stackbase/executor";
```
(`UdfType` was already widened to include `"httpAction"` in Task 4 — no further codegen type change here; this step is only the template-string re-export. Confirm the generated `api` type still EXCLUDES httpActions from the callable surface — they are HTTP endpoints, not `ctx.run*` targets.)

- [ ] **Step 2: Example** (`examples/auth-demo/convex/http.ts`)

```ts
import { httpAction, httpRouter } from "./_generated/server";
import { api } from "./_generated/api";

/** A webhook that records a ping and (if a mutation exists) writes via ctx.runMutation. */
export const ping = httpAction(async (_ctx, request) => {
  const who = new URL(request.url).searchParams.get("who") ?? "anon";
  return new Response(JSON.stringify({ ok: true, who }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const http = httpRouter();
http.route({ path: "/ping", method: "GET", handler: ping });
export default http;
```
(Keep it minimal and self-contained; do not depend on a mutation that the example doesn't already have. If the E2E needs a reactive-write demonstration, define its own project fixture in the test rather than bloating the example.)

- [ ] **Step 3: Write the failing E2E** (`packages/cli/test/http-action-e2e.test.ts`)

Mirror `packages/cli/test/action-e2e.test.ts` (real `startDevServer` + WS client + real HTTP `fetch`). Fixture: a project whose `http.ts` routes `POST /hook` → an httpAction that reads the JSON body and `ctx.runMutation`s a row into a `pings` table; plus a `pings.list` query subscribed over WS. Assertions:
```ts
// 1. start the real dev server; open a WS client; subscribe to api.pings.list -> initial [].
// 2. real HTTP: await fetch(`${url}/hook`, { method: "POST", body: JSON.stringify({ msg: "hi" }) })
//    -> assert response.status 200 and the JSON body the handler returned.
// 3. assert the WS subscription pushes a QueryUpdated containing the new ping row
//    (the webhook's ctx.runMutation fanned out reactively) — bounded waitFor.
// 4. assert GET an unknown path (`${url}/nope`) returns 404.
// 5. assert a project whose http.ts routes a reserved path (`/api/x`) fails to load
//    (loadProject throws /reserved/) — a separate small fixture or a direct loadProject call.
```
If any real-server wiring gap surfaces (e.g. routes not threaded through `cli.ts`, headers dropped), FIX at root cause — do not weaken assertions. Subscribe event-drivenly, not via a polling timer, if you need to observe a transient state (see the saga E2E's harness note).

- [ ] **Step 4: Run the E2E — verify it fails, then passes**

Run: `bun run --filter @stackbase/cli test http-action-e2e`
Expected: FAIL first (fixture not wired), then PASS once Tasks 1-5 carry it. Root-cause any gap.

- [ ] **Step 5: Docs** (`CLAUDE.md`)

Move `httpAction` + the public HTTP router OUT of the "Honestly deferred" paragraph into the shipped set. State accurately: `httpAction` functions (an action variant, `Request`→`Response`), a conventional `http.ts` default-exporting an `httpRouter()` with exact-`path`/`pathPrefix` routes at bare Convex-parity paths (`/api/*` and `/_*` reserved), `Bearer`-token identity, webhook→`ctx.runMutation`→reactive fan-out proven end-to-end through the real dev server. Keep the remaining slice-5 deferrals accurate: streaming bodies, automatic CORS, named path params, per-route middleware are non-goals; file storage (slice 4) and production deploy tooling (slice 6) remain unbuilt.

- [ ] **Step 6: Whole workspace green + commit**

Run: `bun run build && bun run typecheck && bun run test`
```bash
git add packages/codegen/src/generate.ts examples/auth-demo/convex/http.ts packages/cli/test/http-action-e2e.test.ts CLAUDE.md
git commit -m "test(cli): httpAction E2E through the dev server (webhook->mutation->reactive); codegen + example + docs"
```

---

## Notes for the executor of this plan

- **DRY:** `matchRoute` is the single lookup used by both the authoring `HttpRouter.lookup` and the server; do not reimplement precedence logic in `http-handler.ts`. `runActionFn` is the single action-context builder shared by `action` and `httpAction`; do not fork it.
- **YAGNI:** no `405`, no CORS, no path params, no streaming, no per-route middleware in this slice (see Global Constraints / non-goals).
- **The identity contract** is the raw session token (not a resolved subject) — pass the `Bearer` token straight through as `opts.identity`.
- **Reserved paths** are guarded at BOTH ends: `route()` rejects registration (Task 2), and the server's built-in arms return before the user-route match (Task 5) — so even a malformed resolved table can't shadow `/api/*` or `/_*`.
- **The E2E is the load-bearing gate** (Task 6): it has caught mechanism-invisible bugs 4× in this project. It must exercise the real `stackbase dev` server, a real HTTP request, and the reactive fan-out — not a runtime-level stub.
