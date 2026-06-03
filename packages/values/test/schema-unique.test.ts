import { describe, it, expect } from "vitest";
import { defineTable, v } from "../src/index";

describe("defineTable().index unique option", () => {
  it("marks an index unique in the exported JSON", () => {
    const t = defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true });
    const json = t.export();
    expect(json.indexes[0]).toEqual({ indexDescriptor: "by_email", fields: ["email"], unique: true });
  });
  it("a plain index is not unique (back-compat: no `unique` key when false)", () => {
    const t = defineTable({ box: v.string() }).index("by_box", ["box"]);
    expect(t.export().indexes[0]).toEqual({ indexDescriptor: "by_box", fields: ["box"] });
  });
});
