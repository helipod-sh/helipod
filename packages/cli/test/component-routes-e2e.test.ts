import { describe, it, expect, afterAll } from "vitest";
import { defineSchema } from "@stackbase/values";
import { httpAction } from "@stackbase/executor";
import { defineComponent } from "@stackbase/component";
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
