// packages/component/test/define-component.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, httpAction } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";

const schema = defineSchema({ sessions: defineTable({ token: v.string() }) });

const h = httpAction(async () => new Response("ok"));

describe("defineComponent", () => {
  it("returns the definition for a valid component", () => {
    const c = defineComponent({ name: "auth", schema, modules: { signIn: mutation(async () => "ok") } });
    expect(c.name).toBe("auth");
    expect(c.schema).toBe(schema);
    expect(Object.keys(c.modules)).toEqual(["signIn"]);
  });

  it("rejects reserved/invalid names", () => {
    expect(() => defineComponent({ name: "", schema, modules: {} })).toThrow();
    expect(() => defineComponent({ name: "_secret", schema, modules: {} })).toThrow(/reserved/);
    expect(() => defineComponent({ name: "app", schema, modules: {} })).toThrow(/reserved/);
  });

  it("rejects names containing namespace separators", () => {
    expect(() => defineComponent({ name: "auth/x", schema, modules: {} })).toThrow(/may contain only/);
    expect(() => defineComponent({ name: "foo:bar", schema, modules: {} })).toThrow(/may contain only/);
  });

  it("rejects contextType without a context builder", () => {
    expect(() =>
      defineComponent({ name: "x", schema: defineSchema({}), modules: {}, contextType: { import: "@stackbase/x", type: "XContext" } }),
    ).toThrow(/contextType but no context/);
  });

  describe("httpRoutes reserved-prefix guard (Critical regression: ancestor-direction shadowing)", () => {
    it("rejects a bare '/api/' pathPrefix — would shadow every /api/* engine route (e.g. /api/run)", () => {
      expect(() =>
        defineComponent({ name: "bad", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "POST", pathPrefix: "/api/", handler: "h" }] }),
      ).toThrow(/too shallow|reserved prefix|collides/);
    });

    it("rejects a bare '/_' pathPrefix — would shadow every /_* engine route (e.g. /_admin/deploy)", () => {
      expect(() =>
        defineComponent({ name: "bad", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "POST", pathPrefix: "/_", handler: "h" }] }),
      ).toThrow(/too shallow|reserved prefix|collides/);
    });

    it("rejects '/api' with no trailing slash (fails the reserved-namespace check outright)", () => {
      expect(() =>
        defineComponent({ name: "bad", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api", handler: "h" }] }),
      ).toThrow(/reserved path/);
    });

    it("min-depth: rejects a 1-segment prefix, accepts a 2-segment prefix", () => {
      expect(() =>
        defineComponent({ name: "bad", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/", handler: "h" }] }),
      ).toThrow(/too shallow/);
      expect(() =>
        defineComponent({ name: "good", schema: defineSchema({}), modules: { h }, httpRoutes: [{ method: "GET", pathPrefix: "/api/x/", handler: "h" }] }),
      ).not.toThrow();
    });

    it("still accepts a legitimate deep prefix like '/api/auth/oauth/'", () => {
      expect(() =>
        defineComponent({
          name: "auth",
          schema: defineSchema({}),
          modules: { h },
          httpRoutes: [{ method: "GET", pathPrefix: "/api/auth/oauth/", handler: "h" }],
        }),
      ).not.toThrow();
    });
  });
});
