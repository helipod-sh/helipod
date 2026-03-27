import { describe, it, expect, afterAll } from "vitest";
import { defineSchema } from "@stackbase/values";
import { httpAction } from "@stackbase/executor";
import { defineComponent, composeComponents, type ComponentDefinition } from "@stackbase/component";
import { SqliteDocStore, NodeSqliteAdapter } from "@stackbase/docstore-sqlite";
import { createEmbeddedRuntime, type EmbeddedRuntime } from "@stackbase/runtime-embedded";
import { loadProject, startDevServer, type DevServer } from "../src/index";

const servers: DevServer[] = [];
afterAll(async () => { for (const s of servers) await s.close(); });

const ping = defineComponent({
  name: "ping",
  schema: defineSchema({}),
  modules: {
    hit: httpAction(async (_ctx, request: Request) => {
      const url = new URL(request.url);
      return new Response(JSON.stringify({ ok: true, tail: url.pathname.slice("/api/ping/".length) }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }),
  },
  httpRoutes: [{ method: "GET", pathPrefix: "/api/ping/", handler: "hit" }],
});

it("mounts a composed component's reserved route through the real server", async () => {
  const project = loadProject({ schema: defineSchema({}), modules: {} }, [ping]);
  expect(project.componentRoutes).toEqual([{ method: "GET", pathPrefix: "/api/ping/", handlerPath: "ping:hit" }]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
    componentNames: project.componentNames, contextProviders: project.contextProviders,
    bootSteps: project.bootSteps, drivers: project.drivers,
  });
  // Bind the closures exactly as boot.ts does (the test doesn't go through bootLoaded).
  const componentRoutes = project.componentRoutes.map((r) => ({
    method: r.method, pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: null }),
  }));
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", componentRoutes });
  servers.push(server);
  const res = await fetch(`${server.url}/api/ping/hello`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, tail: "hello" });
});

it("rejects a component httpRoute on a non-reserved path at defineComponent time", () => {
  expect(() => defineComponent({ name: "bad", schema: defineSchema({}),
    modules: { h: httpAction(async () => new Response("x")) },
    httpRoutes: [{ method: "GET", pathPrefix: "/hello/", handler: "h" }] })).toThrow(/reserved path/);
});

// --- Critical regression pins: the reserved-prefix guard must be BIDIRECTIONAL -----------------
// Before the fix, a component declaring pathPrefix "/api/" or "/_" passed both defineComponent AND
// composeComponents (the one-directional check only rejected a prefix that EQUALED or was MORE
// SPECIFIC than a reserved engine prefix, never one that was an ANCESTOR of one) — then silently
// shadowed core engine endpoints like /api/run and /_admin/deploy at dispatch, since
// matchComponentRoute runs before handleHttpRequest. These pin the fix at both the defineComponent
// boundary (author-facing) and the composeComponents boundary (defense-in-depth).

function makeBadComponent(pathPrefix: string) {
  return () =>
    defineComponent({
      name: "shadow",
      schema: defineSchema({}),
      modules: { h: httpAction(async () => new Response("x")) },
      httpRoutes: [{ method: "POST", pathPrefix, handler: "h" }],
    });
}

it("rejects pathPrefix '/api/' — would shadow /api/run, /api/health, /api/sync, /api/storage/*", () => {
  expect(makeBadComponent("/api/")).toThrow();
});

it("rejects pathPrefix '/_' — would shadow /_admin/*, /_fleet/*, /_dashboard", () => {
  expect(makeBadComponent("/_")).toThrow();
});

it("rejects pathPrefix '/api' (no trailing slash) the same way", () => {
  expect(makeBadComponent("/api")).toThrow();
});

it("min-depth: rejects a 1-segment prefix even when it happens not to collide with a listed reserved prefix", () => {
  // "/_x" isn't literally in RESERVED_ENGINE_PREFIXES, but it's a 1-segment /_* prefix — the
  // structural min-depth floor rejects it regardless, so an incomplete reserved list can't matter.
  expect(makeBadComponent("/_x")).toThrow(/too shallow/);
});

it("composeComponents also rejects a same-shape violation as defense-in-depth (not just defineComponent)", () => {
  // Build a ComponentDefinition object bypassing defineComponent's own guard entirely, to prove
  // composeComponents enforces the same rule independently.
  const shadow: ComponentDefinition = {
    name: "shadow2",
    schema: defineSchema({}),
    modules: { h: httpAction(async () => new Response("x")) },
    httpRoutes: [{ method: "POST", pathPrefix: "/api/", handler: "h" }],
  };
  expect(() => composeComponents({ schemaJson: defineSchema({}).export(), moduleMap: {} }, [shadow])).toThrow();
});

it("the exact reserved endpoints /api/run and /_admin/deploy can no longer be shadowed", () => {
  expect(makeBadComponent("/api/")).toThrow(); // would have intercepted /api/run
  expect(makeBadComponent("/_admin/")).toThrow(); // would have intercepted /_admin/deploy directly
  expect(makeBadComponent("/_")).toThrow(); // would have intercepted /_admin/deploy via ancestor
});

it("REGRESSION: a legitimate deep prefix like '/api/auth/oauth/' still composes and still dispatches", async () => {
  const authLike = defineComponent({
    name: "authlike",
    schema: defineSchema({}),
    modules: {
      callback: httpAction(async (_ctx, request: Request) => {
        const url = new URL(request.url);
        return new Response(JSON.stringify({ ok: true, tail: url.pathname.slice("/api/auth/oauth/".length) }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }),
    },
    httpRoutes: [{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "callback" }],
  });
  const project = loadProject({ schema: defineSchema({}), modules: {} }, [authLike]);
  expect(project.componentRoutes).toEqual([{ method: "GET", pathPrefix: "/api/auth/oauth/", handlerPath: "authlike:callback" }]);
  const runtime: EmbeddedRuntime = await createEmbeddedRuntime({
    store: new SqliteDocStore(new NodeSqliteAdapter()),
    catalog: project.catalog, modules: project.moduleMap, tableNumbers: project.tableNumbers,
    componentNames: project.componentNames, contextProviders: project.contextProviders,
    bootSteps: project.bootSteps, drivers: project.drivers,
  });
  const componentRoutes = project.componentRoutes.map((r) => ({
    method: r.method, pathPrefix: r.pathPrefix,
    handler: (request: Request) => runtime.runHttpAction(r.handlerPath, request, { identity: null }),
  }));
  const server = await startDevServer(runtime, { port: 0, ip: "127.0.0.1", componentRoutes });
  servers.push(server);
  const res = await fetch(`${server.url}/api/auth/oauth/github`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, tail: "github" });
});
