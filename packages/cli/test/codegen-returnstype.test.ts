import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { mutation, query, action } from "@stackbase/executor";
import { generateApi } from "@stackbase/codegen";
import { loadProject } from "../src/index";

describe("codegen — returnsType derived from the returns validator (D10)", () => {
  const schema = defineSchema({ items: defineTable({ n: v.number() }) });
  const appModule = {
    add: mutation({
      args: { name: v.string(), count: v.number() },
      returns: v.string(),
      handler: (_ctx, a) => `${a.name}:${a.count}`,
    }),
    ping: query((_ctx) => "pong"), // no returns declared -> stays any downstream
    summarize: action({
      returns: v.object({ ok: v.boolean(), total: v.number() }),
      handler: async () => ({ ok: true, total: 1 }),
    }),
  };

  it("populates the manifest entry's returnsType for a function with returns", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const mod = project.manifest.find((m) => m.path === "app");
    const add = mod?.functions.find((f) => f.name === "add");
    const ping = mod?.functions.find((f) => f.name === "ping");
    const summarize = mod?.functions.find((f) => f.name === "summarize");
    expect(add?.returnsType).toBe("string");
    expect(ping?.returnsType).toBeUndefined(); // no returns -> stays any downstream
    expect(summarize?.returnsType).toBeDefined();
    expect(summarize?.returnsType).toContain("ok");
    expect(summarize?.returnsType).toContain("boolean");
    expect(summarize?.returnsType).toContain("total");
  });

  it("emits the derived returns type into the generated api.d.ts", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const api = generateApi(project.manifest);
    // The `add` FunctionReference carries `string` as its Returns slot; `ping` falls back to `any`.
    expect(api.content).toMatch(/add:\s*FunctionReference<"mutation",\s*"public",\s*\{[^}]*\},\s*string>/);
    expect(api.content).toMatch(/ping:\s*FunctionReference<"query",\s*"public",\s*any,\s*any>/);
    expect(api.content).toMatch(/summarize:\s*FunctionReference<"action",\s*"public",\s*any,\s*\{[^}]*ok[^}]*\}/);
  });

  it("does not disturb argsType when both args and returns are declared", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const mod = project.manifest.find((m) => m.path === "app");
    const add = mod?.functions.find((f) => f.name === "add");
    expect(add?.argsType).toContain("name");
    expect(add?.argsType).toContain("count");
  });
});
