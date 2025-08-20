import { it, expect, describe, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { mutation } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

describe("conformance — runtime document validation (enforced)", () => {
  let t: TestStackbase;
  const schema = defineSchema({
    nums: defineTable({ n: v.number() }),
    picks: defineTable({ c: v.union(v.literal("a"), v.literal("b")) }),
    nested: defineTable({ o: v.object({ k: v.number() }) }),
    anys: defineTable({ data: v.any() }),
    opt: defineTable({ a: v.number(), b: v.optional(v.string()) }),
  });
  const modules = {
    "mod.ts": {
      insNums: mutation(async (ctx: any, a: any) => ctx.db.insert("nums", a)),
      insPicks: mutation(async (ctx: any, a: any) => ctx.db.insert("picks", a)),
      insNested: mutation(async (ctx: any, a: any) => ctx.db.insert("nested", a)),
      insAny: mutation(async (ctx: any, a: any) => ctx.db.insert("anys", a)),
      insOpt: mutation(async (ctx: any, a: any) => ctx.db.insert("opt", a)),
    } as any,
    "schema.ts": { default: schema },
  };
  beforeEach(async () => { t = await createTestStackbase({ modules }); });
  afterEach(async () => { await t.close(); });

  it("rejects a wrong-typed insert", async () => {
    await expect(t.mutation("mod:insNums", { n: "x" })).rejects.toThrow(/does not match schema/);
  });
  it("accepts a valid insert", async () => {
    await expect(t.mutation("mod:insNums", { n: 1 })).resolves.toBeTruthy();
  });
  it("rejects an extra field and a missing required field", async () => {
    await expect(t.mutation("mod:insNums", { n: 1, extra: 1 })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:insOpt", {})).rejects.toThrow(/does not match schema/);
  });
  it("rejects a non-member of a union, accepts a member", async () => {
    await expect(t.mutation("mod:insPicks", { c: "z" })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:insPicks", { c: "a" })).resolves.toBeTruthy();
  });
  it("rejects a wrong nested-field type", async () => {
    await expect(t.mutation("mod:insNested", { o: { k: "x" } })).rejects.toThrow(/does not match schema/);
  });
  it("allows omission of an optional field", async () => {
    await expect(t.mutation("mod:insOpt", { a: 1 })).resolves.toBeTruthy();
  });
  it("accepts anything for a v.any() field", async () => {
    await expect(t.mutation("mod:insAny", { data: { arbitrary: [1, "two", true] } })).resolves.toBeTruthy();
  });

  it("does not validate when schemaValidation is disabled", async () => {
    const loose = defineSchema({ nums: defineTable({ n: v.number() }) }, { schemaValidation: false });
    const tl = await createTestStackbase({
      modules: { "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("nums", a)) } as any, "schema.ts": { default: loose } },
    });
    try {
      await expect(tl.mutation("mod:ins", { n: "not-a-number" })).resolves.toBeTruthy();
    } finally { await tl.close(); }
  });
});
