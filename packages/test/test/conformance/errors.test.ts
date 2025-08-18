import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  docs: defineTable({ label: v.string() }),
});

const mod = {
  boom: mutation(async () => {
    throw new Error("boom");
  }),
  insert: mutation(async (ctx: A, args: A) => ctx.db.insert("docs", args)),
  del: mutation(async (ctx: A, args: { id: string }) => {
    await ctx.db.delete(args.id);
    return null;
  }),
  get: query(async (ctx: A, args: { id: string }) => ctx.db.get(args.id)),
};

describe("conformance — errors", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("an uncaught throw in a mutation handler surfaces as a rejection whose message contains 'boom'", async () => {
    await expect(t.mutation("mod:boom", {})).rejects.toThrow(/boom/);
  });

  it("ctx.db.get of a well-formed but absent id returns null, not a throw", async () => {
    const id = await t.mutation<string>("mod:insert", { label: "temp" });
    await t.mutation("mod:del", { id });
    // Well-formed id (was valid, minted by the engine), now absent from the table.
    await expect(t.query("mod:get", { id })).resolves.toBeNull();
  });
});
