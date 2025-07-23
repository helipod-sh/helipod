import { describe, it, expect } from "vitest";
import { diffSchema, type DeploySchema } from "../src/schema-diff";

// Minimal schema-shape builder for the test.
function schema(tables: Record<string, { num: number; fields: Record<string, { type: string; optional?: boolean }> }>): DeploySchema {
  const tableNumbers: Record<string, number> = {};
  const sj: DeploySchema["schemaJson"] = { tables: {} };
  for (const [name, t] of Object.entries(tables)) {
    tableNumbers[name] = t.num;
    const value: Record<string, { fieldType: { type: string }; optional: boolean }> = {};
    for (const [f, v] of Object.entries(t.fields)) value[f] = { fieldType: { type: v.type }, optional: !!v.optional };
    sj.tables[name] = { documentType: { type: "object", value } };
  }
  return { schemaJson: sj, tableNumbers };
}

const base = schema({ users: { num: 1, fields: { name: { type: "string" } } } });

describe("diffSchema", () => {
  it("allows an unchanged schema", () => {
    expect(diffSchema(base, base)).toEqual({ ok: true });
  });
  it("allows a new table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" } } }, posts: { num: 2, fields: { title: { type: "string" } } } });
    expect(diffSchema(base, next)).toEqual({ ok: true });
  });
  it("allows a new OPTIONAL field on an existing table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" }, nick: { type: "string", optional: true } } } });
    expect(diffSchema(base, next)).toEqual({ ok: true });
  });
  it("rejects a dropped table", () => {
    const next = schema({ posts: { num: 2, fields: { title: { type: "string" } } } });
    const r = diffSchema(base, next);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/users.*removed/i);
  });
  it("rejects a changed tableNumber", () => {
    const next = schema({ users: { num: 9, fields: { name: { type: "string" } } } });
    expect(diffSchema(base, next).ok).toBe(false);
  });
  it("rejects an incompatible field-type change (string→number)", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "number" } } } });
    expect(diffSchema(base, next).ok).toBe(false);
  });
  it("rejects a new REQUIRED field on an existing table", () => {
    const next = schema({ users: { num: 1, fields: { name: { type: "string" }, age: { type: "number" } } } });
    const r = diffSchema(base, next);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/age.*required/i);
  });
  it("rejects a removed field on an existing table", () => {
    const twoField = schema({ users: { num: 1, fields: { name: { type: "string" }, nick: { type: "string", optional: true } } } });
    expect(diffSchema(twoField, base).ok).toBe(false);
  });
});
