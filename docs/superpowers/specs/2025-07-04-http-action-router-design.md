# `httpAction` + public HTTP router — design

**Status:** approved (brainstorming) — 2025-07-04
**Slice:** completes build-order slice 5 (Actions + scheduled functions/crons). The scheduled-functions/crons half (`@stackbase/scheduler`) and the actions themselves shipped; this is the remaining deferred piece — `httpAction` definitions + a public HTTP router for webhooks/custom HTTP endpoints.
**Reference:** Convex `httpRouter()` / `httpAction` (`convex/http.ts` default-export convention; exact `path` + `pathPrefix` matching, no named params). Studied, not copied.

---

## 1. Goal

Let an app author expose HTTP endpoints — webhooks (Stripe, GitHub), OAuth callbacks, small custom REST/JSON surfaces — that run server-side with the full action capability set, and orchestrate transactional data access via `ctx.runMutation`/`runQuery`/`runAction` so a webhook's write **fans out reactively** to live subscriptions.

**The one concept: an `httpAction` is an action whose I/O is a raw Web `Request` → `Response`** (instead of JSON args → JSON value). It reuses the entire action runtime — same non-deterministic profile (no `ctx.db`, native `fetch`/clock/random), same out-of-transaction execution, same `invoke` orchestration seam. The only new machinery is (a) the definer + executor I/O shape and (b) a route table + a public router in front of it.

---

## 2. Locked decisions (from brainstorming)

1. **Bare Convex-parity paths.** User routes live at bare paths (`POST /stripe`, `GET /oauth/callback`), matched AFTER the built-in routes. `/api/*` and `/_*` are **reserved** for the engine; a route registered under them fails fast at load.
2. **Exact `path` + `pathPrefix` matching, no named params.** `http.route({ path, method, handler })` and `http.route({ pathPrefix: "/webhooks/", method, handler })`. No `:id` params (Convex parity) — the handler reads the raw URL for anything dynamic.
3. **`http.ts` default-export discovery.** The project exposes a conventional `http.ts` that default-exports the router (Convex's `convex/http.ts` convention); project loading picks it up.
4. **Identity from `Authorization: Bearer`,** resolved the same way queries/actions do, so `ctx.auth` works. The handler always has the raw `Request` headers for custom schemes (webhook-signature verification), and a missing/invalid token simply means absent identity — the handler still runs (httpActions commonly self-auth).
5. **Buffered body model (v1).** The request body is fully read (text or bytes); the handler returns a full `Response` (any content-type, any bytes). Streaming request/response bodies are deferred (they belong with file-storage, slice 4).

---

## 3. API — the authoring surface

```ts
// convex-parity: project's http.ts
import { httpRouter } from "@stackbase/server";
import { httpAction } from "@stackbase/server";
import { api } from "./_generated/api";

export const stripeWebhook = httpAction(async (ctx, request) => {
  const sig = request.headers.get("stripe-signature");
  const body = await request.text();                 // fully buffered
  // ... verify sig with body (native crypto/fetch available) ...
  await ctx.runMutation(api.orders.markPaid, { orderId });   // commits + fans out reactively
  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "content-type": "application/json" },
  });
});

const http = httpRouter();
http.route({ path: "/stripe", method: "POST", handler: stripeWebhook });
http.route({ pathPrefix: "/oauth/", method: "GET", handler: oauthCallback });
export default http;
```

- `httpAction(handler)` → `{ type: "httpAction", handler: (ctx, request: Request) => Response | Promise<Response> }`. `ctx` is the **action context** (`runQuery`/`runMutation`/`runAction`, `ctx.auth`; NO `ctx.db`) — identical to a normal `action`, only the second arg (`Request`) and return (`Response`) differ.
- `httpRouter()` → an `HttpRouter` with `.route({ path?, pathPrefix?, method, handler })` and `.lookup(method, path)`. Exactly one of `path`/`pathPrefix` per route.

---

## 4. The mechanism (definer · executor · router · server)

**(a) Definer — `packages/executor/src/functions.ts`.** Add `httpAction(def)` mirroring `action(def)`, tagging `type: "httpAction"`. The handler signature is `(ctx, request: Request) => Response | Promise<Response>`.

**(b) Executor — `packages/executor/src/executor.ts`.** Replace the `if (fn.type === "httpAction") throw …` guard (line ~159) with a real run path. It builds the SAME action context the `action` path builds (native capabilities via `HTTP_ACTION_PROFILE` — already present in `profile.ts`; `runQuery`/`runMutation`/`runAction` via the injected `invoke` seam; no `ctx.db`), passes the raw `Request` as the handler argument, and returns the handler's `Response` **directly** — no `convexToJson`, because a `Response` is not a `Value`. Runs OUTSIDE any transaction, a fresh independent top-level run, exactly like an action.

**(c) Router — `packages/server/src/http-router.ts` (new).** A pure data structure. `route()` records `{ method, path|pathPrefix, handlerPath }`; validates exactly one of `path`/`pathPrefix`, and rejects any path under `/api/` or `/_` at registration time with a clear error. `lookup(method, path)` resolves a request: **exact `path` match wins; otherwise the longest matching `pathPrefix` for that method wins**; returns the handler's function path (or none). Because it's pure and side-effect-free, it's unit-tested without a server.
> The router stores the httpAction's **function path** (e.g. `"app:stripeWebhook"`), not the handler closure — dispatch goes through the runtime by path (so hot-reload swaps the handler, and the same `isInternalPath` gate applies).

**(d) Project loading — `packages/cli`.** Discover the project's `http.ts` default-export (the `HttpRouter`), extract its route table, and thread it into the server alongside the modules map. Hot reload rebuilds the table on change.

**(e) Server — `packages/cli/src/http-handler.ts`.** In `handleHttpRequest`, AFTER the reserved built-ins (`/_admin/*`, `/_dashboard`, `/api/health`, `POST /api/run`) and BEFORE the final 404: consult the route table via `lookup(method, path)`. On a match:
1. Build a Web `Request` from the incoming `HttpRequest` — method, full URL (scheme+host+path+query), headers, and the buffered body.
2. Resolve identity from the `Authorization: Bearer` token (same resolver other entrypoints use); absent/invalid → no identity, handler still runs.
3. Invoke `runtime.runHttpAction(handlerPath, request, identity)`.
4. Translate the returned `Response` → `HttpResponse` (status, headers, body — reading `Response.arrayBuffer()`/`.text()` for the buffered body).

**(f) Runtime — `packages/runtime-embedded/src/runtime.ts`.** Add `runHttpAction(path, request, identity)`: gate with `isInternalPath` (a `_`-prefixed segment is unreachable from the public HTTP surface, exactly like `run`/`runAction`), run through the executor's httpAction path, return the `Response`.

---

## 5. Data flow (a Stripe webhook, end to end)

1. `POST /stripe` reaches the dev server → `handleHttpRequest`.
2. Not `/_admin`·`/_dashboard`·`/api/*` → `lookup("POST", "/stripe")` → `"app:stripeWebhook"`.
3. Build a Web `Request` (method, URL, headers, buffered body); resolve identity from `Bearer` if present.
4. `runtime.runHttpAction("app:stripeWebhook", request, identity)` → executor runs it **outside any txn** with native capabilities.
5. The handler verifies the raw signature, then `ctx.runMutation(api.orders.markPaid, …)` — which commits in its own transaction and **fans out reactively** to live subscriptions whose read-set intersects the write (the same path the action E2E already proves).
6. The handler returns `new Response(...)`; the server translates it to `HttpResponse` and sends it.

---

## 6. Error handling

- **Handler throws / rejects** → `500`, with a safe error body (dev: the message + code; prod: generic). Convex parity: an uncaught error is a 500.
- **No route matches** → fall through to the existing static-file/`404` path (unchanged).
- **Route under a reserved prefix (`/api/`, `/_`)** → error at **load time** (fail fast when `http.ts` is loaded), not per request, naming the offending path.
- **Body too large** → `413`, reusing the body-size limit the server already enforces for `POST /api/run`.
- **Method matches a path but not the method** → **`404` fall-through** in v1 (a path with no matching `(method, path)` route simply doesn't match, and falls through to static/404). A proper `405 Method Not Allowed` is a deferred nicety — not worth the extra lookup complexity for webhooks, which use fixed methods.
- **Handler returns a non-`Response`** → `500` with a clear "httpAction must return a Response" message.

---

## 7. Testing

- **Unit — router (`packages/server/test/http-router.test.ts`):** exact-vs-prefix precedence; longest-prefix-wins; method mismatch; exactly-one-of path/pathPrefix validation; reserved-prefix rejection at registration.
- **Unit — definer + executor (`packages/executor/test/http-action.test.ts`):** `httpAction` tags `type:"httpAction"`; the executor runs it (`Request` in → `Response` out), has NO `ctx.db`, and its `ctx.runMutation` reaches a target through the `invoke` seam.
- **E2E through the shipped `stackbase dev` server (`packages/cli/test/http-action-e2e.test.ts`):** a project whose `http.ts` routes `POST /webhook` → an httpAction that reads the body and `ctx.runMutation`s a row. Start the real server; fire a real HTTP `POST /webhook`; assert (a) the `Response` (status + body) and (b) that the mutation's write **fanned out to a separate live WS subscription** — proving the webhook→mutation→reactive path end-to-end. Also assert a reserved-path route (`/api/foo`) fails project load, and an unknown path 404s. This is the "test through the shipped entrypoint" discipline that has caught 4 mechanism-invisible bugs in this project.
- **Regression:** all existing tests green — httpAction is purely additive (the executor guard is replaced, not the action/query/mutation paths; the server gains a new match arm after the built-ins).

---

## 8. File structure

- **Modify:** `packages/executor/src/functions.ts` (the `httpAction` definer), `packages/executor/src/executor.ts` (run path replacing the throw), `packages/cli/src/http-handler.ts` (the dispatch arm), `packages/runtime-embedded/src/runtime.ts` (`runHttpAction`), `packages/cli` project loading (discover `http.ts`), `packages/server/src/index.ts` (export `httpRouter`/`httpAction` if re-exported there).
- **New:** `packages/server/src/http-router.ts` (the `HttpRouter`), plus the three test files above.
- **Docs:** `CLAUDE.md` (move `httpAction`/public HTTP router OUT of "Honestly deferred" into shipped); an `http.ts` example in `examples/auth-demo` (or a dedicated example) if it clarifies the pattern.

---

## 9. Non-goals (v1)

- **Streaming request/response bodies** — deferred to file-storage (slice 4), which is where large upload/download actually needs it.
- **Automatic CORS / `OPTIONS` handling** — the handler's job (Convex is mostly hands-off); a handler can add CORS headers itself.
- **Named path params (`/users/:id`)** — exact + `pathPrefix` + read the URL (Convex parity).
- **Per-route auth/rate-limit middleware** — compose in the handler; authz + a future rate-limit component cover this.
- **A separate httpActions domain** (Convex's `*.convex.site`) — single-port dev server; reserved prefixes are the isolation mechanism instead.
