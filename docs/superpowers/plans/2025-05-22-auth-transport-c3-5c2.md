# C3.5c-2 — Server-Side Request Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dev-server authenticate requests from a client-held token: a `Bearer` header on `POST /api/run`, and a `?token=` query param (or cookie, if present) on the WebSocket upgrade — both threaded as the `identity` the engine already consumes. This completes the transport for in-memory/bearer tokens; the secure httpOnly-cookie default + CSRF is deferred (it needs HTTP Actions — see Scope).

**Architecture:** A pure `requestIdentity({ authorization, cookie })` helper extracts the token (`Authorization: Bearer <t>`, else the `sb_session` cookie). `handleHttpRequest` threads it into `runtime.run(path, args, { identity })` for `/api/run`. `SyncProtocolHandler.connect` gains an optional initial `identity`; the two server backends extract the upgrade token (query `?token=` or cookie) and pass it. Everything reuses C3.5a's `RunOptions.identity` / C3.5c's per-session identity — no new engine concepts.

**Tech Stack:** TypeScript, pnpm/turbo, vitest. Touches `@stackbase/cli` (`http-handler.ts`, `server.ts`) and `@stackbase/sync` (`handler.ts` connect signature).

## Global Constraints

- Identity is an **opaque token** end-to-end; the server never interprets it (auth's facade resolves it). `requestIdentity` returns `string | null`.
- **The `Bearer` token for `/api/run` is the USER's session token (identity), distinct from the admin key** (which authenticates `/_admin/*`). A request that sends the admin key to `/api/run` just resolves to no session → anonymous; harmless.
- Backward compatible: no token → `identity: null` (anonymous), existing behavior unchanged. `connect`'s `identity` param is **optional** (default `null`) so the loopback path and existing callers are unaffected.
- **Scope — deferred to a post-Actions slice (NOT built here):** the secure web *default* — `signIn` setting an `httpOnly + Secure + SameSite=Lax` cookie (a `Set-Cookie` response side-effect needs HTTP Actions) and the double-submit CSRF token. This slice builds the *read* half (server authenticates from a token already in the request); the *write* half (server issues the httpOnly cookie) waits on Actions. Until then, clients hold the token in memory/localStorage and present it via `setAuth()` (WS, done in C3.5c) or the `Bearer` header (HTTP, this slice).
- Strict TS; ESM.

---

### Task 1: `POST /api/run` authenticates from the request token

**Files:**
- Modify: `packages/cli/src/http-handler.ts` (`HttpRequest.cookie`; `requestIdentity`; thread into `/api/run`)
- Modify: `packages/cli/src/server.ts` (populate `req.cookie` in both backends)
- Test: `packages/cli/test/request-auth.test.ts`

**Interfaces:**
- Produces: `requestIdentity(req: { authorization?: string; cookie?: string }): string | null`; `HttpRequest` gains `cookie?: string`; `/api/run` calls `runtime.run(path, args, { identity: requestIdentity(req) })`.

- [ ] **Step 1: Write the failing test**
```ts
// packages/cli/test/request-auth.test.ts
import { describe, it, expect } from "vitest";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { composeComponents, defineComponent } from "@stackbase/component";
import { EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { defineSchema } from "@stackbase/values";
import { query } from "@stackbase/executor";
import { handleHttpRequest, requestIdentity } from "../src/http-handler";

describe("requestIdentity", () => {
  it("reads a Bearer token, else the sb_session cookie, else null", () => {
    expect(requestIdentity({ authorization: "Bearer tok-1" })).toBe("tok-1");
    expect(requestIdentity({ cookie: "a=1; sb_session=tok-2; b=2" })).toBe("tok-2");
    expect(requestIdentity({ authorization: "Bearer tok-1", cookie: "sb_session=tok-2" })).toBe("tok-1"); // bearer wins
    expect(requestIdentity({})).toBeNull();
    expect(requestIdentity({ authorization: "Basic xyz" })).toBeNull();
  });
});

describe("POST /api/run threads identity", () => {
  it("an authenticated /api/run call sees the request token as ctx identity", async () => {
    // an inline component that echoes the ambient identity via a ctx facade
    const idc = defineComponent({ name: "idc", schema: defineSchema({}), modules: {}, context: (cctx) => ({ get: () => cctx.identity }) });
    const appModules = { "whoami:get": query(async (ctx) => (ctx as unknown as { idc: { get(): string | null } }).idc.get()) };
    const { catalog, moduleMap, componentNames, contextProviders } = composeComponents(
      { schemaJson: defineSchema({}).export(), moduleMap: appModules }, [idc]);
    const runtime = await EmbeddedRuntime.create({ store: new SqliteDocStore(new NodeSqliteAdapter()), catalog, modules: moduleMap, componentNames, contextProviders });
    const info = { functions: ["whoami:get"], tables: [] };

    const res = await handleHttpRequest(runtime, { method: "POST", path: "/api/run", body: JSON.stringify({ path: "whoami:get", args: {} }), authorization: "Bearer tok-42" }, info);
    expect(JSON.parse(res.body).value).toBe("tok-42");

    const anon = await handleHttpRequest(runtime, { method: "POST", path: "/api/run", body: JSON.stringify({ path: "whoami:get", args: {} }) }, info);
    expect(JSON.parse(anon.body).value).toBeNull();
  });
});
```
(If `defineComponent` isn't re-exported from `@stackbase/component`, import it from there — it is exported. If `@stackbase/component` isn't a devDep of `@stackbase/cli`, add it; cli already depends on runtime-embedded, and component doesn't depend on cli, so no cycle.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/cli test request-auth` → FAIL (`requestIdentity` missing / identity not threaded → value null instead of "tok-42").

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/http-handler.ts`:
```ts
// HttpRequest gains:
  cookie?: string;

/** The session identity for a request: a Bearer token, else the `sb_session` cookie, else null. */
export function requestIdentity(req: { authorization?: string; cookie?: string }): string | null {
  const auth = req.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  if (req.cookie) {
    for (const part of req.cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === "sb_session") {
        const v = part.slice(eq + 1).trim();
        if (v) return v;
      }
    }
  }
  return null;
}
```
In `/api/run`: `const result = await runtime.run(parsed.path, parsed.args ?? {}, { identity: requestIdentity(req) });`

In `packages/cli/src/server.ts`, populate `req.cookie` where each backend builds the `HttpRequest`:
- Node backend (~line 111, alongside `authorization`): `const cookie = req.headers.cookie ?? undefined;` and add `cookie` to the request object passed to `handleHttpRequest`.
- Bun backend (~line 239, alongside `authorization`): `const cookie = req.headers.get("cookie") ?? undefined;` and add `cookie` to the request object.

- [ ] **Step 4: Run test, typecheck, commit** — `pnpm --filter @stackbase/cli test` → all pass · `pnpm --filter @stackbase/cli exec tsc --noEmit` → clean.
```bash
git add packages/cli/src/http-handler.ts packages/cli/src/server.ts packages/cli/test/request-auth.test.ts
git commit -m "feat(cli): /api/run authenticates from Bearer token or sb_session cookie"
```

---

### Task 2: WebSocket connect-time identity

**Files:**
- Modify: `packages/sync/src/handler.ts` (`connect` optional `identity`)
- Modify: `packages/cli/src/server.ts` (extract upgrade token → `connect(..., identity)`, both backends)
- Modify: `packages/cli/src/http-handler.ts` (export a tiny `cookieToken` reuse) — OR reuse `requestIdentity`
- Test: `packages/sync/test/connect-identity.test.ts`

**Interfaces:**
- Produces: `SyncProtocolHandler.connect(sessionId: string, socket: SyncWebSocket, identity?: string | null)` — initial session identity (default `null`); the server passes the upgrade token (query `?token=` or `sb_session` cookie).

- [ ] **Step 1: Write the failing test**
```ts
// packages/sync/test/connect-identity.test.ts
import { describe, it, expect } from "vitest";
import type { Value, JSONValue } from "@stackbase/sync"; // value types via re-export, else from @stackbase/values
import { SyncProtocolHandler, type SyncUdfExecutor, type SyncWebSocket } from "../src/handler";

function mockSocket(): SyncWebSocket & { sent: unknown[] } {
  const sent: unknown[] = [];
  return { sent, send: (d: string) => sent.push(JSON.parse(d)), bufferedAmount: 0, close: () => {} };
}
class RecordingExecutor implements SyncUdfExecutor {
  calls: Array<string | null | undefined> = [];
  async runQuery(_p: string, _a: JSONValue, identity?: string | null) { this.calls.push(identity); return { value: null as unknown as Value, tables: ["t"] }; }
  async runMutation() { return { value: null as unknown as Value, tables: [], commitTs: 1 }; }
}

describe("connect with initial identity", () => {
  it("a connection opened with an identity runs queries authenticated (no SetAuth needed)", async () => {
    const ex = new RecordingExecutor();
    const h = new SyncProtocolHandler(ex);
    h.connect("s1", mockSocket(), "tok-init");
    await h.handleMessage("s1", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:get", args: {} }], remove: [] }));
    expect(ex.calls.at(-1)).toBe("tok-init");
  });
  it("defaults to null when no identity is provided (backward compatible)", async () => {
    const ex = new RecordingExecutor();
    const h = new SyncProtocolHandler(ex);
    h.connect("s2", mockSocket());
    await h.handleMessage("s2", JSON.stringify({ type: "ModifyQuerySet", add: [{ queryId: 1, udfPath: "me:get", args: {} }], remove: [] }));
    expect(ex.calls.at(-1)).toBeNull();
  });
});
```
(Use whatever `Value`/`JSONValue` import the existing `auth-identity.test.ts` uses — copy that import line.)

- [ ] **Step 2: Run test to verify it fails** — `pnpm --filter @stackbase/sync test connect-identity` → FAIL (`connect` ignores the 3rd arg → identity null).

- [ ] **Step 3: Write minimal implementation**

In `packages/sync/src/handler.ts`, change `connect`:
```ts
  connect(sessionId: string, socket: SyncWebSocket, identity: string | null = null): void {
    this.sessions.set(sessionId, { sessionId, socket, version: { ...INITIAL_VERSION }, identity });
  }
```

In `packages/cli/src/server.ts`, extract the upgrade token and pass it to `connect`. Add a small helper (in this file or reuse `requestIdentity` from http-handler with `{ cookie }`):
- Node backend (the `server.on("upgrade", ...)` block, ~line 145): parse `?token=` from `req.url` and the `req.headers.cookie`; `const identity = tokenFromUrl(req.url) ?? requestIdentity({ cookie: req.headers.cookie });` then `runtime.handler.connect(sessionId, syncSocket, identity);`
- Bun backend (the `upgrade` path, ~line 223): same — read `url.searchParams.get("token")` and the `cookie` header; pass to `connect` (the Bun `open` handler calls `connect` — thread the identity through the `data` passed to `server.upgrade`, e.g. `{ data: { sessionId, identity } }`, then in `websocket.open` call `connect(ws.data.sessionId, sock, ws.data.identity)`).
Add `function tokenFromUrl(url?: string): string | null { const q = (url ?? "").split("?")[1]; if (!q) return null; const t = new URLSearchParams(q).get("token"); return t && t.length ? t : null; }` (or use `URL`).

- [ ] **Step 4: Run test, full workspace, commit** — `pnpm --filter @stackbase/sync test` → all pass · `pnpm --filter @stackbase/cli exec tsc --noEmit` && `pnpm --filter @stackbase/sync exec tsc --noEmit` → clean · `pnpm build && pnpm typecheck && pnpm test` → whole workspace green.
```bash
git add packages/sync/src/handler.ts packages/cli/src/server.ts packages/sync/test/connect-identity.test.ts
git commit -m "feat(sync,cli): WebSocket connect-time identity from upgrade token (query/cookie)"
```

---

## Self-Review

**Spec coverage (against `2025-05-22-ctx-contribution-auth-c3-5-design.md` D3 + build-order C3.5c-2):**
- HTTP request authentication (Bearer / cookie) — Task 1. ✅
- WS connect-time authentication (query token / cookie) — Task 2. ✅
- Distinct from the admin key (Task 1 constraint). ✅
- **Out of scope (blocked on HTTP Actions — documented):** `signIn` setting the `httpOnly + Secure + SameSite=Lax` cookie (`Set-Cookie` response side-effect) + double-submit CSRF. This is the secure web *default*; this slice builds the read half, the cookie-issuing half waits on Actions. The in-memory/bearer path (`setAuth` over WS, `Bearer` over HTTP) is the working transport until then.

**Placeholder scan:** none — runnable code/commands. The two server-backend edits are described per-backend with line anchors; the Bun WS path threads identity via the `upgrade` `data` because `connect` is called in `websocket.open`, not inline.

**Type consistency:** `requestIdentity` (Task 1) returns `string | null`, fed to `RunOptions.identity` (C3.5a); `HttpRequest.cookie` (Task 1) is populated by both server backends; `connect`'s optional `identity` (Task 2) flows to `Session.identity` → the three `runQuery`/`runMutation` sites (C3.5c). The Bun backend threads identity through `server.upgrade(req, { data: { sessionId, identity } })` → `websocket.open` → `connect(sessionId, sock, identity)`.
