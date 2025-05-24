// packages/component/test/define-component.test.ts
import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation } from "@stackbase/executor";
import { defineComponent } from "../src/define-component";

const schema = defineSchema({ sessions: defineTable({ token: v.string() }) });

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
});
