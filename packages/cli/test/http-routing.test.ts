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
