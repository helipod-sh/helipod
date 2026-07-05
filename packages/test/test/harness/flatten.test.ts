import { describe, it, expect } from "vitest";
import { mutation, query, httpAction } from "@helipod/executor";
import { flattenModules } from "../../src/flatten";

describe("flattenModules", () => {
  it("maps <module>:<fn> paths, strips extensions, keeps nested dirs, and separates schema/http", async () => {
    const messages = { send: mutation(async () => "ok"), list: query(async () => []) };
    const adminUsers = { list: query(async () => []) };
    const schema = { default: { __isSchema: true } }; // stand-in; real defineSchema in later tasks
    const http = { default: { __isRouter: true } };
    const out = await flattenModules({
      "messages.ts": messages,
      "admin/users.ts": adminUsers,
      "schema.ts": schema,
      "http.ts": http,
    });
    expect(Object.keys(out.moduleMap).sort()).toEqual(["admin/users:list", "messages:list", "messages:send"]);
    expect(out.schemaModule).toBe(schema.default);
    expect(out.httpModule).toBe(http.default);
  });

  it("awaits import.meta.glob-style async loaders", async () => {
    const out = await flattenModules({ "a.ts": async () => ({ f: query(async () => 1) }) });
    expect(Object.keys(out.moduleMap)).toEqual(["a:f"]);
  });

  it("still registers http.ts's named httpAction exports into moduleMap (not just the default router)", async () => {
    const ping = httpAction(async () => new Response("ok"));
    const http = { default: { __isRouter: true, routes: [] }, ping };
    const out = await flattenModules({ "http.ts": http });
    expect(out.httpModule).toBe(http.default);
    expect(out.moduleMap["http:ping"]).toBe(ping);
    // the router's own `default` export itself must NOT leak into moduleMap as `http:default`.
    expect(out.moduleMap["http:default"]).toBeUndefined();
  });

  it("normalizes import.meta.glob-style keys (./helipod/ prefix, the DEFAULT_FUNCTIONS_ROOT) to the same function-path root as explicit keys", async () => {
    const send = mutation(async () => "ok");
    const ping = httpAction(async () => new Response("ok"));
    const schema = { __isSchema: true };
    const router = { __isRouter: true, routes: [] };
    const out = await flattenModules({
      "./helipod/messages.ts": { send },
      "./helipod/schema.ts": { default: schema },
      "./helipod/http.ts": { default: router, ping },
    });
    expect(out.moduleMap["messages:send"]).toBe(send);
    expect(out.schemaModule).toBe(schema);
    expect(out.httpModule).toBe(router);
    expect(out.moduleMap["http:ping"]).toBe(ping);
  });

  it("normalizes a glob key with no functions-root dir (./messages.ts) too", async () => {
    const send = mutation(async () => "ok");
    const out = await flattenModules({ "./messages.ts": { send } });
    expect(out.moduleMap["messages:send"]).toBe(send);
  });

  it("strips a caller-supplied non-default functionsRoot instead of the DEFAULT_FUNCTIONS_ROOT", async () => {
    const send = mutation(async () => "ok");
    const out = await flattenModules({ "./backend/messages.ts": { send } }, "backend");
    expect(out.moduleMap["messages:send"]).toBe(send);
  });

  it("does NOT implicitly strip a legacy convex/ prefix when functionsRoot defaults to helipod", async () => {
    const send = mutation(async () => "ok");
    const out = await flattenModules({ "./convex/messages.ts": { send } });
    // No implicit convex/ tolerance: the segment survives as part of the module path.
    expect(out.moduleMap["convex/messages:send"]).toBe(send);
    expect(out.moduleMap["messages:send"]).toBeUndefined();
  });
});
