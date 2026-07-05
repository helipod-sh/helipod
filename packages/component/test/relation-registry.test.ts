import { describe, it, expect } from "vitest";
import { composeComponents } from "../src/index";
import { defineSchema, defineTable, v } from "@helipod/values";

const schema = defineSchema({
  orgs: defineTable({ ownerId: v.string() }),
  documents: defineTable({ ownerId: v.string(), orgId: v.id("orgs") })
    .relation("sharedWith", { table: "document_shares", field: "documentId" }),
  document_shares: defineTable({ documentId: v.id("documents"), userId: v.string() }),
});

describe("relation registry", () => {
  it("extracts to-many from .relation() and to-one from v.id fields", () => {
    const { relationRegistry } = composeComponents({ schemaJson: schema.export(), moduleMap: {} }, []);
    expect(relationRegistry.toMany.get("documents")?.get("sharedWith")).toEqual({ table: "document_shares", field: "documentId" });
    expect(relationRegistry.toOne.get("documents")?.get("orgId")).toBe("orgs");
    expect(relationRegistry.toOne.get("document_shares")?.get("documentId")).toBe("documents");
  });

  it("rejects a relation to an unknown table", () => {
    const bad = defineSchema({ documents: defineTable({ a: v.string() }).relation("r", { table: "ghost", field: "x" }) });
    expect(() => composeComponents({ schemaJson: bad.export(), moduleMap: {} }, [])).toThrow(/unknown table "ghost"/);
  });

  it("rejects a relation whose back-reference field is not on the child table", () => {
    const bad = defineSchema({
      documents: defineTable({ a: v.string() }).relation("r", { table: "shares", field: "missing" }),
      shares: defineTable({ documentId: v.id("documents") }),
    });
    expect(() => composeComponents({ schemaJson: bad.export(), moduleMap: {} }, [])).toThrow(/unknown field "missing"/);
  });
});
