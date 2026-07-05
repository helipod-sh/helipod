import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@helipod/values";
import { mutation, query } from "@helipod/executor";
import { generateApi } from "@helipod/codegen";
import { loadProject } from "../src/index";

describe("codegen — argsType derived from the args validator", () => {
  const schema = defineSchema({ items: defineTable({ n: v.number() }) });
  const appModule = {
    add: mutation({ args: { name: v.string(), count: v.number() }, handler: (_ctx, a) => `${a.name}:${a.count}` }),
    ping: query((_ctx) => "pong"), // no args
  };

  it("populates the manifest entry's argsType for a function with args", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const mod = project.manifest.find((m) => m.path === "app");
    const add = mod?.functions.find((f) => f.name === "add");
    const ping = mod?.functions.find((f) => f.name === "ping");
    expect(add?.argsType).toBeDefined();
    expect(add?.argsType).toContain("name");
    expect(add?.argsType).toContain("string");
    expect(add?.argsType).toContain("count");
    expect(ping?.argsType).toBeUndefined(); // no args -> stays any downstream
  });

  it("emits the derived args type into the generated api.d.ts", () => {
    const project = loadProject({ schema, modules: { app: appModule } });
    const api = generateApi(project.manifest);
    // The `add` FunctionReference carries the object type; `ping` falls back to `any`.
    expect(api.content).toMatch(/add:\s*FunctionReference<"mutation",\s*"public",\s*\{[^}]*name[^}]*\}/);
    expect(api.content).toMatch(/ping:\s*FunctionReference<"query",\s*"public",\s*any/);
  });
});
