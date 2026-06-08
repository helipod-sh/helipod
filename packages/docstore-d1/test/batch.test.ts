import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { D1DocStore, UniqueConstraintError } from "../src/index";
import { sqliteD1Client } from "./support/sqlite-d1-client";

const schema = defineSchema({
  users: defineTable({ email: v.string(), n: v.number() }).index("by_email", ["email"], { unique: true }),
}).export();

async function store() {
  const s = new D1DocStore(sqliteD1Client(), schema);
  await s.applyDdl();
  return s;
}

describe("D1DocStore.commitBatch", () => {
  it("applies a multi-op batch atomically", async () => {
    const s = await store();
    await s.commitBatch([
      { kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "a", n: 1 } },
      { kind: "insert", table: "users", doc: { _id: "u2", _creationTime: 2, email: "b", n: 2 } },
    ]);
    expect((await s.get("users", "u1"))!.email).toBe("a");
    expect((await s.get("users", "u2"))!.email).toBe("b");
  });
  it("is all-or-nothing: a unique violation mid-batch leaves NOTHING written", async () => {
    const s = await store();
    await expect(s.commitBatch([
      { kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "dup", n: 1 } },
      { kind: "insert", table: "users", doc: { _id: "u2", _creationTime: 2, email: "dup", n: 2 } }, // violates by_email
    ])).rejects.toMatchObject({ name: "UniqueConstraintError", table: "users", field: "email" });
    expect(await s.get("users", "u1")).toBeNull(); // rolled back — the first insert did NOT persist
  });
});
