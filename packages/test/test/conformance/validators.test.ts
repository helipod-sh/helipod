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

describe("conformance — runtime document validation (extended type coverage)", () => {
  // NOTE: `t.mutation(ref, args)` round-trips `args` through `jsonToConvex` (it's typed `Value` but
  // treated as `JSONValue` under the hood — a bare `bigint`/`ArrayBuffer` in the args object throws
  // a TypeError before it ever reaches the handler). `t.run(fn)` instead hands the handler a real
  // `ctx` directly with no JSON-args boundary, so it's used below whenever a test needs to construct
  // a genuine `bigint`/`ArrayBuffer` value. `ctx.db.insert` itself still round-trips through
  // `convexToJson`/`jsonToConvex` at the syscall boundary (see `packages/executor/src/guest.ts` and
  // `kernel.ts`), which correctly preserves both types.
  let t: TestStackbase;
  afterEach(async () => { if (t) await t.close(); });

  it("v.int64 accepts a bigint, rejects a plain number", async () => {
    const schema = defineSchema({ ints: defineTable({ n: v.int64() }) });
    t = await createTestStackbase({ modules: { "schema.ts": { default: schema } } });
    await expect(t.run(async (ctx: any) => ctx.db.insert("ints", { n: 5n }))).resolves.toBeTruthy();
    await expect(t.run(async (ctx: any) => ctx.db.insert("ints", { n: 5 }))).rejects.toThrow(/does not match schema/);
  });

  it("v.float64/v.number accepts a number, rejects a bigint", async () => {
    const schema = defineSchema({ floats: defineTable({ n: v.float64() }) });
    t = await createTestStackbase({ modules: { "schema.ts": { default: schema } } });
    await expect(t.run(async (ctx: any) => ctx.db.insert("floats", { n: 5 }))).resolves.toBeTruthy();
    await expect(t.run(async (ctx: any) => ctx.db.insert("floats", { n: 5n }))).rejects.toThrow(/does not match schema/);
  });

  it("v.bytes accepts an ArrayBuffer, rejects a non-ArrayBuffer", async () => {
    const schema = defineSchema({ blobs: defineTable({ b: v.bytes() }) });
    t = await createTestStackbase({ modules: { "schema.ts": { default: schema } } });
    const buf = new Uint8Array([1, 2, 3]).buffer;
    await expect(t.run(async (ctx: any) => ctx.db.insert("blobs", { b: buf }))).resolves.toBeTruthy();
    await expect(t.run(async (ctx: any) => ctx.db.insert("blobs", { b: "not-bytes" }))).rejects.toThrow(/does not match schema/);
    await expect(t.run(async (ctx: any) => ctx.db.insert("blobs", { b: [1, 2, 3] }))).rejects.toThrow(/does not match schema/);
  });

  it("v.array(v.number()) rejects a wrong-typed element, accepts all-valid, accepts empty", async () => {
    const schema = defineSchema({ lists: defineTable({ xs: v.array(v.number()) }) });
    const modules = {
      "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("lists", a)) } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:ins", { xs: [1, "two", 3] })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:ins", { xs: [1, 2, 3] })).resolves.toBeTruthy();
    await expect(t.mutation("mod:ins", { xs: [] })).resolves.toBeTruthy();
  });

  it("v.record(v.string(), v.number()) accepts a valid record, rejects a wrong-typed value", async () => {
    const schema = defineSchema({ recs: defineTable({ r: v.record(v.string(), v.number()) }) });
    const modules = {
      "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("recs", a)) } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:ins", { r: { a: 1, b: 2 } })).resolves.toBeTruthy();
    await expect(t.mutation("mod:ins", { r: { a: 1, b: "not-a-number" } })).rejects.toThrow(/does not match schema/);
  });

  it("v.boolean accepts a boolean, rejects a non-boolean", async () => {
    const schema = defineSchema({ bools: defineTable({ b: v.boolean() }) });
    const modules = {
      "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("bools", a)) } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:ins", { b: true })).resolves.toBeTruthy();
    await expect(t.mutation("mod:ins", { b: "true" })).rejects.toThrow(/does not match schema/);
  });

  it("v.null accepts null, rejects a non-null value", async () => {
    const schema = defineSchema({ nulls: defineTable({ n: v.null() }) });
    const modules = {
      "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("nulls", a)) } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:ins", { n: null })).resolves.toBeTruthy();
    await expect(t.mutation("mod:ins", { n: 0 })).rejects.toThrow(/does not match schema/);
  });

  it("v.id(\"table\") accepts a well-formed id — and, per the documented D5 divergence, also accepts an arbitrary string (shape-only, not existence/table-checked)", async () => {
    const schema = defineSchema({
      docs: defineTable({ label: v.string() }),
      refs: defineTable({ target: v.id("docs") }),
    });
    const modules = {
      "mod.ts": {
        insDoc: mutation(async (ctx: any, a: any) => ctx.db.insert("docs", a)),
        insRef: mutation(async (ctx: any, a: any) => ctx.db.insert("refs", a)),
      } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    const docId = await t.mutation<string>("mod:insDoc", { label: "x" });
    await expect(t.mutation("mod:insRef", { target: docId })).resolves.toBeTruthy();
    // FINDING: IdValidator.check (packages/values/src/validator.ts) only asserts `typeof value ===
    // "string"` — it never decodes the id or checks it references the declared table. Any string
    // (even one that isn't a real id at all) passes schema validation. This is the documented D5
    // "v.id is shape-only" divergence from Convex, not a bug to fix here — asserted as real behavior.
    await expect(t.mutation("mod:insRef", { target: "not-a-real-id" })).resolves.toBeTruthy();
  });

  it("non-string v.literal accepts the exact value, rejects another", async () => {
    const schema = defineSchema({
      fives: defineTable({ n: v.literal(5) }),
      trues: defineTable({ b: v.literal(true) }),
    });
    const modules = {
      "mod.ts": {
        insFive: mutation(async (ctx: any, a: any) => ctx.db.insert("fives", a)),
        insTrue: mutation(async (ctx: any, a: any) => ctx.db.insert("trues", a)),
      } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:insFive", { n: 5 })).resolves.toBeTruthy();
    await expect(t.mutation("mod:insFive", { n: 6 })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:insTrue", { b: true })).resolves.toBeTruthy();
    await expect(t.mutation("mod:insTrue", { b: false })).rejects.toThrow(/does not match schema/);
  });

  it("deep nesting: v.array(v.object({ k: v.optional(v.number()) })) rejects a bad nested element, allows an omitted optional inside", async () => {
    const schema = defineSchema({
      deep: defineTable({ items: v.array(v.object({ k: v.optional(v.number()) })) }),
    });
    const modules = {
      "mod.ts": { ins: mutation(async (ctx: any, a: any) => ctx.db.insert("deep", a)) } as any,
      "schema.ts": { default: schema },
    };
    t = await createTestStackbase({ modules });
    await expect(t.mutation("mod:ins", { items: [{ k: 1 }, { k: "bad" }] })).rejects.toThrow(/does not match schema/);
    await expect(t.mutation("mod:ins", { items: [{ k: 1 }, {}] })).resolves.toBeTruthy();
  });
});
