import { describe, it, expect } from "vitest";
import { defineSchema, defineTable, v } from "@stackbase/values";
import { D1DocStore } from "../src/d1-doc-store";
import { UniqueConstraintError, type D1Client } from "../src/index";

const schema = defineSchema({
  users: defineTable({
    email: v.string(),
    age: v.number(),
    tags: v.array(v.string()),
    active: v.boolean(),
    score: v.int64(),
    bio: v.optional(v.string()),
  })
    .index("by_email", ["email"], { unique: true })
    .index("by_age", ["age"])
    .index("by_active", ["active"])
    .index("by_score", ["score"]),
}).export();

/** The shared D1 store behavior suite — run against any D1Client substrate. */
export function d1BehaviorSuite(name: string, makeClient: () => D1Client | Promise<D1Client>): void {
  describe(`D1DocStore behavior — ${name}`, () => {
    async function store(): Promise<D1DocStore> {
      const s = new D1DocStore(await makeClient(), schema);
      await s.applyDdl();
      return s;
    }

    it("insert → get round-trips (nested JSON, boolean, full-precision int64, absent optional)", async () => {
      const s = await store();
      // score is 2^53 + 1 — NOT representable as a JS number; proves the TEXT bigint column keeps full i64 precision.
      const doc = { _id: "u1", _creationTime: 1, email: "a@b.c", age: 30, tags: ["x"], active: true, score: 9007199254740993n };
      await s.insert("users", doc);
      const back = await s.get("users", "u1");
      expect(back).toEqual(doc);
      expect(back!.active).toBe(true);          // boolean round-tripped from the INTEGER 0/1 column
      expect(back!.score).toBe(9007199254740993n); // bigint round-tripped from the TEXT column, no precision loss
      expect(back).not.toHaveProperty("bio");   // absent optional stays absent
    });

    it("a .unique() violation throws UniqueConstraintError(table, field)", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "dup@x.c", age: 1, tags: [], active: true, score: 1n });
      await expect(
        s.insert("users", { _id: "u2", _creationTime: 2, email: "dup@x.c", age: 2, tags: [], active: false, score: 2n }),
      ).rejects.toMatchObject({ name: "UniqueConstraintError", table: "users", field: "email" });
    });

    it("patch merges (preserving untouched typed fields), replace overwrites, delete removes", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a", age: 1, tags: [], active: true, score: 42n });
      await s.patch("users", "u1", { age: 2 });
      const patched = await s.get("users", "u1");
      expect(patched!.age).toBe(2);
      expect(patched!.active).toBe(true);  // patch read-merge-write round-trips the untouched boolean...
      expect(patched!.score).toBe(42n);    // ...and the untouched bigint, through the codec
      await s.replace("users", "u1", { _id: "u1", _creationTime: 1, email: "b", age: 9, tags: ["z"], active: false, score: 5n });
      expect(await s.get("users", "u1")).toMatchObject({ email: "b", age: 9, tags: ["z"], active: false, score: 5n });
      await s.delete("users", "u1");
      expect(await s.get("users", "u1")).toBeNull();
    });

    it("queryByIndex returns matching rows", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a", age: 20, tags: [], active: true, score: 1n });
      await s.insert("users", { _id: "u2", _creationTime: 2, email: "b", age: 20, tags: [], active: true, score: 2n });
      await s.insert("users", { _id: "u3", _creationTime: 3, email: "c", age: 99, tags: [], active: false, score: 3n });
      const rows = await s.queryByIndex("users", { index: "by_age", eq: { age: 20 } });
      expect(rows.map((r) => r._id).sort()).toEqual(["u1", "u2"]);
    });

    it("queryByIndex encodes boolean and bigint eq values (write/read symmetry)", async () => {
      const s = await store();
      await s.insert("users", { _id: "u1", _creationTime: 1, email: "a", age: 5, tags: [], active: true, score: 100n });
      await s.insert("users", { _id: "u2", _creationTime: 2, email: "b", age: 6, tags: [], active: false, score: 200n });
      const activeRows = await s.queryByIndex("users", { index: "by_active", eq: { active: true } });
      expect(activeRows.map((r) => r._id)).toEqual(["u1"]);
      const scoreRows = await s.queryByIndex("users", { index: "by_score", eq: { score: 200n } });
      expect(scoreRows.map((r) => r._id)).toEqual(["u2"]);
    });
  });
}
