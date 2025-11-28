import { describe, it, expect } from "vitest";
import { v, defineSchema, defineTable } from "@stackbase/values";
import { generateIds, generateAll } from "../src/generate";
import type { AnalyzedFunctionManifest } from "../src/generate";

const schema = defineSchema({
  conversations: defineTable({ name: v.string() }),
  messages: defineTable({ body: v.string() }),
}).export();

const manifest: AnalyzedFunctionManifest = [];

const tableNumbers = {
  conversations: 10001,
  messages: 10002,
  "scheduler/jobs": 10003, // component table — must be excluded
  _storage: 20, // system table — must be excluded
};

describe("generateIds", () => {
  it("emits ids.ts with the APP-ONLY table map and a typed mintId", () => {
    const file = generateIds(schema, tableNumbers);
    expect(file.path).toBe("ids.ts");
    expect(file.content).toContain('"conversations": 10001');
    expect(file.content).toContain('"messages": 10002');
    expect(file.content).not.toContain("scheduler/jobs");
    expect(file.content).not.toContain("_storage");
    expect(file.content).toContain("export function mintId");
    expect(file.content).toContain("mintEncodedDocumentId"); // delegates to the id-codec core
  });

  it("generateAll includes ids.ts only when tableNumbers is provided", () => {
    const withIds = generateAll({ schema, manifest, tableNumbers });
    expect(withIds.files.some((f) => f.path === "ids.ts")).toBe(true);
    const without = generateAll({ schema, manifest });
    expect(without.files.some((f) => f.path === "ids.ts")).toBe(false);
  });
});
