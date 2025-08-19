import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { httpRouter, httpAction, mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

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

const router = httpRouter();
router.route({ pathPrefix: "/x", method: "GET", handler: prefixHandler });
router.route({ path: "/x/exact", method: "GET", handler: exactHandler });
router.route({ path: "/hook", method: "POST", handler: webhook });

const httpModule = { default: router, prefixHandler, exactHandler, webhook };

describe("conformance — http router", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({
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
});
