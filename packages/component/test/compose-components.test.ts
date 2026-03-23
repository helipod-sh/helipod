import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query, httpAction } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";
import { composeComponents } from "../src/compose";

const appSchema = defineSchema({ messages: defineTable({ body: v.string() }) }).export();
const auth = defineComponent({
  name: "auth",
  schema: defineSchema({ sessions: defineTable({ token: v.string() }) }),
  modules: { signIn: mutation(async () => "t") },
});

describe("composeComponents", () => {
  it("combines tables, modules, and the component-name set", () => {
    const out = composeComponents({ schemaJson: appSchema, moduleMap: { "messages:list": query(async () => []) } }, [auth]);
    expect(out.tableNumbers["messages"]).toBeGreaterThan(0);
    expect(out.tableNumbers["auth/sessions"]).toBeGreaterThan(0);
    expect(Object.keys(out.moduleMap).sort()).toEqual(["auth:signIn", "messages:list"]);
    expect([...out.componentNames]).toEqual(["auth"]);
    expect(out.catalog.getTable("auth/sessions")?.tableNumber).toBe(out.tableNumbers["auth/sessions"]);
  });
});

describe("composeComponents httpRoutes cross-component overlap guard", () => {
  const h = httpAction(async () => new Response("ok"));

  it("rejects two components whose route prefixes overlap (one a prefix of the other), same method", () => {
    const a = defineComponent({ name: "a", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/", handler: "h" }] });
    const b = defineComponent({ name: "b", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/b/", handler: "h" }] });
    expect(() => composeComponents({ schemaJson: appSchema, moduleMap: {} }, [a, b])).toThrow(/overlaps/);
  });

  it("accepts two components with disjoint route prefixes", () => {
    const a = defineComponent({ name: "a", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/", handler: "h" }] });
    const b = defineComponent({ name: "b", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/b/", handler: "h" }] });
    const out = composeComponents({ schemaJson: appSchema, moduleMap: {} }, [a, b]);
    expect(out.componentRoutes).toEqual([
      { method: "GET", pathPrefix: "/api/a/", handlerPath: "a:h" },
      { method: "GET", pathPrefix: "/api/b/", handlerPath: "b:h" },
    ]);
  });

  it("still rejects an exact-duplicate prefix across components (unchanged pre-existing behavior)", () => {
    const a = defineComponent({ name: "a", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/", handler: "h" }] });
    const b = defineComponent({ name: "b", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/", handler: "h" }] });
    expect(() => composeComponents({ schemaJson: appSchema, moduleMap: {} }, [a, b])).toThrow(/overlaps/);
  });

  it("allows the same prefix under different methods (no overlap across methods)", () => {
    const a = defineComponent({ name: "a", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/a/", handler: "h" }] });
    const b = defineComponent({ name: "b", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "POST", pathPrefix: "/api/a/", handler: "h" }] });
    expect(() => composeComponents({ schemaJson: appSchema, moduleMap: {} }, [a, b])).not.toThrow();
  });
});
