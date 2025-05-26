import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { mutation, query } from "@stackbase/executor";
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
