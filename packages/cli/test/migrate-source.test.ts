import { describe, it, expect } from "vitest";
import { resolveSource, type MigrationSource } from "../src/migrate/source";

const fake: MigrationSource = {
  id: "convex",
  detect: async () => true,
  analyze: async () => ({ edits: [], scaffold: [], report: [] }),
};

describe("resolveSource", () => {
  it("resolves a registered source by id", () => {
    expect(resolveSource({ convex: fake }, "convex")).toBe(fake);
  });
  it("throws a clear error on an unknown source", () => {
    expect(() => resolveSource({ convex: fake }, "supabase")).toThrow(/unknown migration source "supabase"/);
  });
});
