import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { httpRouter, httpAction, mutation, query } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  saved: defineTable({ label: v.string() }),
});

const mod = {
  save: mutation(async (ctx: A, args: { label: string }) => ctx.db.insert("saved", args)),
  read: query(async (ctx: A) => ctx.db.query("saved", "by_creation").collect()),
};

// httpAction handlers MUST be named exports of the `http.ts` module — an inline handler passed
// directly to `route()` errors at route-resolution time ("must be an exported httpAction",
// `packages/test/src/compose.ts`), because the resolver finds a route's dispatch path by scanning
// the module map for the handler VALUE's identity.
export const prefixHandler = httpAction(async () => new Response("prefix", { status: 200 }));
export const exactHandler = httpAction(async () => new Response("exact", { status: 200 }));
export const webhook = httpAction(async (ctx: A, req: Request) => {
  const body = (await req.json()) as { label: string };
  await ctx.runMutation("mod:save", { label: body.label });
  return new Response("ok", { status: 200 });
});

// Exercises `ctx.runQuery` from an httpAction — only `runMutation` was covered before.
export const readHandler = httpAction(async (ctx: A) => {
  const rows = await ctx.runQuery("mod:read", {});
  return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
});

// Proves the `Request` is fully decoded: a JSON body handler...
export const echoBody = httpAction(async (_ctx: A, req: Request) => {
  const body = (await req.json()) as { n: number };
  return new Response(JSON.stringify({ doubled: body.n * 2 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

// ...and a query-string handler.
export const echoQuery = httpAction(async (_ctx: A, req: Request) => {
  const url = new URL(req.url);
  return new Response(url.searchParams.get("name") ?? "", { status: 200 });
});

// Surfaces whether `ctx.db` is present on an httpAction's ctx — actions run outside the
// transaction and must have no `ctx.db` (see `packages/executor/src/executor.ts`'s
// `runActionFn`, which builds `actionCtx` from `{ runQuery, runMutation, runAction }` plus
// context-provider facades only — `db` is never one of those keys).
export const dbCheckHandler = httpAction(async (ctx: A) => {
  return new Response(JSON.stringify({ hasDb: "db" in ctx, dbType: typeof ctx.db }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const router = httpRouter();
router.route({ pathPrefix: "/x", method: "GET", handler: prefixHandler });
router.route({ path: "/x/exact", method: "GET", handler: exactHandler });
router.route({ path: "/hook", method: "POST", handler: webhook });
router.route({ path: "/read", method: "GET", handler: readHandler });
router.route({ path: "/echo-body", method: "POST", handler: echoBody });
router.route({ path: "/echo-query", method: "GET", handler: echoQuery });
router.route({ path: "/db-check", method: "GET", handler: dbCheckHandler });

const httpModule = {
  default: router,
  prefixHandler,
  exactHandler,
  webhook,
  readHandler,
  echoBody,
  echoQuery,
  dbCheckHandler,
};

describe("conformance — http router", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({
      modules: { "http.ts": httpModule, "mod.ts": mod, "schema.ts": { default: schema } },
    });
  });

  afterEach(async () => {
    await t.close();
  });

  it("an exact-path route wins over a longer pathPrefix route for the same method", async () => {
    const exact = await t.fetch(new Request("http://t/x/exact", { method: "GET" }));
    expect(await exact.text()).toBe("exact");

    // A sibling path under the same prefix still falls through to the prefix handler.
    const prefixed = await t.fetch(new Request("http://t/x/other", { method: "GET" }));
    expect(await prefixed.text()).toBe("prefix");
  });

  it("a request with the wrong method for a registered path 404s", async () => {
    const res = await t.fetch(new Request("http://t/hook", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("a webhook httpAction's ctx.runMutation commits, visible to a follow-up query", async () => {
    const res = await t.fetch(
      new Request("http://t/hook", {
        method: "POST",
        body: JSON.stringify({ label: "from-webhook" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);

    const rows = await t.query("mod:read", {});
    expect(rows).toMatchObject([{ label: "from-webhook" }]);
  });

  it("a reserved path (/api/*) is rejected at route() registration time", () => {
    const r = httpRouter();
    expect(() => r.route({ path: "/api/x", method: "GET", handler: exactHandler })).toThrow();
  });

  it("a reserved path (/_*) is also rejected at route() registration time", () => {
    const r = httpRouter();
    expect(() => r.route({ path: "/_internal", method: "GET", handler: exactHandler })).toThrow();
    // Sanity: the reservation is on the first path segment, not merely a leading underscore
    // anywhere — a pathPrefix form is caught the same way.
    expect(() => r.route({ pathPrefix: "/_admin", method: "GET", handler: exactHandler })).toThrow();
  });

  it("a path with no registered route at all 404s (distinct from a wrong-method 404 on a known path)", async () => {
    const res = await t.fetch(new Request("http://t/totally/unknown/path", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("an httpAction can read data via ctx.runQuery, not just ctx.runMutation", async () => {
    await t.mutation("mod:save", { label: "seen-by-query" });
    const res = await t.fetch(new Request("http://t/read", { method: "GET" }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toMatchObject([{ label: "seen-by-query" }]);
  });

  it("an httpAction handler can read a decoded JSON request body", async () => {
    const res = await t.fetch(
      new Request("http://t/echo-body", {
        method: "POST",
        body: JSON.stringify({ n: 21 }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ doubled: 42 });
  });

  it("an httpAction handler can read the request's query string", async () => {
    const res = await t.fetch(new Request("http://t/echo-query?name=helipod", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("helipod");
  });

  it("an httpAction's ctx has no ctx.db — actions run outside the transaction", async () => {
    const res = await t.fetch(new Request("http://t/db-check", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hasDb: false, dbType: "undefined" });
  });

  it("route() with an inline (non-exported) handler is rejected at resolution time", async () => {
    // Same schema/mod modules, but a fresh router whose handler is a plain inline httpAction
    // never re-exported by the module map — the resolver in `packages/test/src/compose.ts`
    // finds a route's dispatch path by scanning the module map for the handler VALUE's
    // identity, so a handler that isn't itself a named export can never be found.
    const inlineHandler = httpAction(async () => new Response("inline", { status: 200 }));
    const badRouter = httpRouter();
    badRouter.route({ path: "/inline", method: "GET", handler: inlineHandler });
    const badHttpModule = { default: badRouter };

    await expect(
      createTestHelipod({
        modules: { "http.ts": badHttpModule, "mod.ts": mod, "schema.ts": { default: schema } },
      }),
    ).rejects.toThrow(/must be an exported httpAction/);
  });
});
