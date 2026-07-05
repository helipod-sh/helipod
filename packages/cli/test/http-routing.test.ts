import { describe, it, expect } from "vitest";
import { httpAction, httpRouter } from "@helipod/executor";
import { SqliteDocStore, NodeSqliteAdapter } from "@helipod/docstore-sqlite";
import { createEmbeddedRuntime } from "@helipod/runtime-embedded";
import { loadProject } from "../src/project";
import { handleHttpRequest, type ServerInfo } from "../src/http-handler";
import { defineSchema } from "@helipod/values";

function makeLoaded() {
  const ping = httpAction(async () => new Response("pong"));
  const router = httpRouter();
  router.route({ path: "/ping", method: "GET", handler: ping });
  return {
    schema: defineSchema({}),
    modules: {
      http: { ping, default: router }, // http.ts: named httpAction + default-exported router
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
});

describe("handleHttpRequest — dispatch to httpAction routes", () => {
  const echo = httpAction(async (_ctx, req: Request) => {
    const body = await req.text();
    return new Response(`m:${req.method} b:${body} h:${req.headers.get("x-sig")}`, { status: 200 });
  });
  const boom = httpAction(async () => {
    throw new Error("kaboom");
  });

  async function makeRuntime() {
    const project = loadProject({
      schema: defineSchema({}),
      modules: { http: { echo, boom } },
    } as never);
    const runtime = await createEmbeddedRuntime({
      store: new SqliteDocStore(new NodeSqliteAdapter()),
      catalog: project.catalog,
      modules: project.moduleMap,
    });
    const info: ServerInfo = { functions: Object.keys(project.moduleMap), tables: Object.keys(project.tableNumbers) };
    return { runtime, info };
  }

  it("dispatches a matched route to the httpAction and returns its Response", async () => {
    const { runtime, info } = await makeRuntime();
    const routes = [{ method: "POST", path: "/echo", handlerPath: "http:echo" }];
    const res = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/echo", body: "hi", headers: { "x-sig": "abc" } },
      info,
      undefined,
      routes,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("m:POST b:hi h:abc");
  });

  it("unmatched path falls through to 404", async () => {
    const { runtime, info } = await makeRuntime();
    const res = await handleHttpRequest(runtime, { method: "GET", path: "/nope" }, info, undefined, []);
    expect(res.status).toBe(404);
  });

  it("a throwing httpAction becomes 500", async () => {
    const { runtime, info } = await makeRuntime();
    const res = await handleHttpRequest(
      runtime,
      { method: "POST", path: "/boom" },
      info,
      undefined,
      [{ method: "POST", path: "/boom", handlerPath: "http:boom" }],
    );
    expect(res.status).toBe(500);
  });

  it("built-in routes still win over user routes", async () => {
    const { runtime, info } = await makeRuntime();
    const res = await handleHttpRequest(
      runtime,
      { method: "GET", path: "/api/health" },
      info,
      undefined,
      [{ method: "GET", pathPrefix: "/", handlerPath: "http:echo" }],
    );
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { status: string }).status).toBe("ok"); // health, not the catch-all httpAction
  });
});
