import { describe, it, expect } from "vitest";
import { SimpleIndexCatalog } from "../src/catalog";
import { v, validate } from "@helipod/values";

describe("catalog carries the document validator", () => {
  it("builds a validator from documentType when schemaValidation is on", () => {
    const cat = new SimpleIndexCatalog();
    const docType = v.object({ n: v.number() }).toJSON();
    cat.addTable("messages", 5, docType, true);
    const meta = cat.getTable("messages")!;
    expect(meta.documentValidator).toBeTruthy();
    expect(validate(meta.documentValidator!, { n: 1 } as never)).toEqual([]);
    expect(validate(meta.documentValidator!, { n: "x" } as never).length).toBeGreaterThan(0);
  });

  it("leaves documentValidator null when schemaValidation is off", () => {
    const cat = new SimpleIndexCatalog();
    cat.addTable("messages", 5, v.object({ n: v.number() }).toJSON(), false);
    expect(cat.getTable("messages")!.documentValidator).toBeNull();
  });

  it("leaves documentValidator null when no documentType is given (back-compat)", () => {
    const cat = new SimpleIndexCatalog();
    cat.addTable("messages", 5);
    expect(cat.getTable("messages")!.documentValidator ?? null).toBeNull();
  });
});
