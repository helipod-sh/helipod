import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { columnTypeFor, tableDdl, schemaDdl } from "../src/ddl";

const schema = defineSchema({
  users: defineTable({ email: v.string(), age: v.number(), active: v.boolean(), tags: v.array(v.string()), bio: v.optional(v.string()) })
    .index("by_email", ["email"], { unique: true })
    .index("by_age", ["age"]),
}).export();

describe("columnTypeFor", () => {
  it("maps validator json types to sqlite column types", () => {
    expect(columnTypeFor({ type: "string" })).toBe("TEXT");
    expect(columnTypeFor({ type: "number" })).toBe("REAL");
    expect(columnTypeFor({ type: "boolean" })).toBe("INTEGER");
    expect(columnTypeFor({ type: "bigint" })).toBe("TEXT");
    expect(columnTypeFor({ type: "array", value: { type: "string" } })).toBe("TEXT"); // JSON
    expect(columnTypeFor({ type: "id", tableName: "users" })).toBe("TEXT");
  });
});

describe("tableDdl", () => {
  const stmts = tableDdl("users", schema.tables.users!);
  it("creates the table with _id PK, _creationTime, typed columns, optional→nullable", () => {
    const create = stmts.find((s) => s.startsWith("CREATE TABLE"))!;
    expect(create).toContain(`"_id" TEXT PRIMARY KEY`);
    expect(create).toContain(`"_creationTime" REAL NOT NULL`);
    expect(create).toContain(`"email" TEXT NOT NULL`);
    expect(create).toContain(`"age" REAL NOT NULL`);
    expect(create).toContain(`"active" INTEGER NOT NULL`);
    expect(create).toContain(`"tags" TEXT NOT NULL`); // array → JSON TEXT
    expect(create).toContain(`"bio" TEXT`); // optional → no NOT NULL
    expect(create).not.toContain(`"bio" TEXT NOT NULL`);
  });
  it("emits a UNIQUE index for a unique index and a plain INDEX otherwise", () => {
    expect(stmts.some((s) => /CREATE UNIQUE INDEX .* ON "users" \("email"\)/.test(s))).toBe(true);
    expect(stmts.some((s) => /CREATE INDEX .* ON "users" \("age"\)/.test(s))).toBe(true);
  });
});

describe("schemaDdl", () => {
  it("flattens all tables' DDL", () => {
    expect(schemaDdl(schema).some((s) => s.startsWith("CREATE TABLE"))).toBe(true);
  });
});
