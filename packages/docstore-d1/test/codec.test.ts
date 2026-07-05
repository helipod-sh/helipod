import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@helipod/values";
import { docToRow, rowToDoc } from "../src/codec";

const users = defineSchema({
  users: defineTable({ email: v.string(), age: v.number(), active: v.boolean(), tags: v.array(v.string()), bio: v.optional(v.string()) }),
}).export().tables.users!;

describe("docToRow / rowToDoc", () => {
  it("round-trips scalars, a boolean (0/1), a JSON array, and an absent optional", () => {
    const doc = { _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: true, tags: ["x", "y"] };
    const row = docToRow(users, doc);
    expect(row).toMatchObject({ _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: 1, tags: `["x","y"]`, bio: null });
    const back = rowToDoc(users, row);
    expect(back).toEqual({ _id: "u1", _creationTime: 100, email: "a@b.c", age: 30, active: true, tags: ["x", "y"] });
    expect(back).not.toHaveProperty("bio"); // absent optional stays absent
  });
  it("preserves a present optional", () => {
    const back = rowToDoc(users, docToRow(users, { _id: "u2", _creationTime: 1, email: "e", age: 1, active: false, tags: [], bio: "hi" }));
    expect(back.bio).toBe("hi");
    expect(back.active).toBe(false);
  });
});
