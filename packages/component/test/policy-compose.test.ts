import { describe, it, expect } from "vitest";
import { defineComponent, composeComponents } from "../src/index";
import { defineSchema, defineTable, v } from "@stackbase/values";

const appSchema = defineSchema({ todos: defineTable({ ownerId: v.string(), text: v.string() }) });

const guard = defineComponent({
  name: "guard",
  schema: defineSchema({}),
  modules: {},
  policies: { todos: { read: ({ auth }) => ({ ownerId: auth.userId }) } },
  policyContext: () => ({ auth: { userId: "u1", identity: null, can: async () => false, roles: async () => [], scopesWith: async () => [] } }),
});

describe("policy composition", () => {
  it("aggregates policies into a registry keyed by resolved table name + a provider", () => {
    const composed = composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [guard]);
    expect(composed.policyRegistry.has("todos")).toBe(true);
    expect(composed.policyProviders).toHaveLength(1);
    const [firstProvider] = composed.policyProviders;
    expect(firstProvider?.namespace).toBe("guard");
  });

  it("rejects a policy on an unknown table (typo guard)", () => {
    const bad = defineComponent({ name: "bad", schema: defineSchema({}), modules: {}, policies: { nope: { read: () => true } } });
    expect(() => composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [bad])).toThrow(/unknown table "nope"/);
  });

  it("rejects two components claiming the same table", () => {
    const g2 = defineComponent({ name: "g2", schema: defineSchema({}), modules: {}, policies: { todos: { read: () => true } } });
    expect(() => composeComponents({ schemaJson: appSchema.export(), moduleMap: {} }, [guard, g2])).toThrow(/duplicate policy for table "todos"/);
  });
});
