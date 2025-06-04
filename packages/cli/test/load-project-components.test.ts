import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { defineComponent } from "@stackbase/component";
import { loadProject } from "../src/project";

describe("loadProject with components", () => {
  it("composes component tables + functions into the catalog/moduleMap and reports componentNames/providers", () => {
    const auth = defineComponent({
      name: "auth",
      schema: defineSchema({ sessions: defineTable({ token: v.string() }).index("byToken", ["token"]) }),
      modules: { signOut: { type: "mutation", handler: async () => null } as never },
      context: (cctx) => ({ id: () => cctx.identity }),
    });
    const loaded = { schema: defineSchema({ notes: defineTable({ body: v.string() }) }), modules: {} };
    const p = loadProject(loaded, [auth]);
    expect(p.tableNumbers["notes"]).toBeGreaterThan(0);          // app table (bare)
    expect(p.tableNumbers["auth/sessions"]).toBeGreaterThan(0);  // component table (namespaced)
    expect(Object.keys(p.moduleMap)).toContain("auth:signOut");  // component function
    expect([...p.componentNames]).toEqual(["auth"]);
    expect(p.contextProviders.map((cp) => cp.name)).toEqual(["auth"]);
  });
  it("with no components, behaves as before (empty componentNames/providers)", () => {
    const loaded = { schema: defineSchema({ notes: defineTable({ body: v.string() }) }), modules: {} };
    const p = loadProject(loaded);
    expect(p.tableNumbers["notes"]).toBeGreaterThan(0);
    expect([...p.componentNames]).toEqual([]);
    expect(p.contextProviders).toEqual([]);
  });
});
