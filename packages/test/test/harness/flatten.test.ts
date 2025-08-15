import { describe, it, expect } from "vitest";
import { mutation, query } from "@stackbase/executor";
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
});
