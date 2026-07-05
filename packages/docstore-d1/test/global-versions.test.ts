import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@helipod/values";
import { D1DocStore } from "../src/index";
import { sqliteD1Client } from "./support/sqlite-d1-client";

const schema = defineSchema({
  users: defineTable({ email: v.string() }).index("by_email", ["email"], { unique: true }),
  orgs: defineTable({ name: v.string() }),
}).export();
async function store() { const s = new D1DocStore(sqliteD1Client(), schema); await s.applyDdl(); return s; }

describe("_global_versions", () => {
  it("readVersions returns 0/absent for untouched tables, bumps on write", async () => {
    const s = await store();
    expect(await s.readVersions(["users"])).toEqual({}); // no writes yet → no row
    await s.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "a" } }]);
    expect((await s.readVersions(["users"])).users).toBe(1);
  });
  it("a multi-table batch bumps each distinct table once", async () => {
    const s = await store();
    await s.commitBatch([
      { kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "a" } },
      { kind: "insert", table: "users", doc: { _id: "u2", _creationTime: 2, email: "b" } },
      { kind: "insert", table: "orgs", doc: { _id: "o1", _creationTime: 3, name: "x" } },
    ]);
    const vs = await s.readVersions(["users", "orgs"]);
    expect(vs).toEqual({ users: 1, orgs: 1 }); // users bumped ONCE despite 2 inserts
    await s.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u3", _creationTime: 4, email: "c" } }]);
    expect((await s.readVersions(["users", "orgs"])).users).toBe(2);
  });
  it("the version bump is atomic with the write — a failed batch bumps nothing", async () => {
    const s = await store();
    await s.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u1", _creationTime: 1, email: "dup" } }]);
    await expect(s.commitBatch([{ kind: "insert", table: "users", doc: { _id: "u2", _creationTime: 2, email: "dup" } }])).rejects.toThrow();
    expect((await s.readVersions(["users"])).users).toBe(1); // NOT 2 — the failed batch's bump rolled back
  });
});
