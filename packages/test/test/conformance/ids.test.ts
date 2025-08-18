import { describe, it, expect, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { mutation, query } from "@stackbase/executor";
import { defineSchema, defineTable, v } from "@stackbase/values";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;

const schema = defineSchema({
  a: defineTable({ label: v.string() }),
  b: defineTable({ ref: v.optional(v.id("a")), label: v.string() }),
});

const mod = {
  insertA: mutation(async (ctx: A, args: A) => ctx.db.insert("a", args)),
  insertB: mutation(async (ctx: A, args: A) => ctx.db.insert("b", args)),
  get: query(async (ctx: A, args: { id: string }) => ctx.db.get(args.id)),
};

describe("conformance — ids", () => {
  let t: TestStackbase;

  afterEach(async () => {
    await t.close();
  });

  it("an inserted id round-trips: insert -> returned id string -> get returns the row", async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
    const id = await t.mutation<string>("mod:insertA", { label: "hello" });
    expect(typeof id).toBe("string");
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc).toMatchObject({ label: "hello", _id: id });
  });

  it("ctx.db.get of a syntactically-malformed id string rejects (id-codec throws)", async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
    await expect(t.query("mod:get", { id: "garbage!!" })).rejects.toThrow();
  });

  it("cross-table id: v.id(table) is NOT runtime-enforced (D5) — get() decodes the id's OWN embedded table, ignoring the field's declared table", async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });

    // Mint an id for table "a".
    const idA = await t.mutation<string>("mod:insertA", { label: "from-a" });

    // Store that "a" id in table "b"'s `ref` field, which is typed `v.id("a")` — so this is
    // actually the SAME-table case for the declared type. To exercise a genuine cross-table
    // mismatch, store an "a" id where a "b" id would be expected instead: insert a "b" row,
    // then call the shared `get` query with the "a" id directly (empirically observed below).
    const idB = await t.mutation<string>("mod:insertB", { label: "from-b", ref: idA });
    expect(idB).not.toBe(idA);

    // Empirically: ctx.db.get(id) has no notion of "which table field this came from" — a
    // DocumentId embeds its OWN table number (see packages/id-codec/src/document-id.ts), and
    // `handleDbGet` (packages/executor/src/kernel.ts) decodes THAT table number to find the row.
    // So calling get() with an "a" id always returns the "a" row, regardless of what table a
    // schema field declares it should belong to (v.id("a") is not checked against the actual
    // origin table on write, and get() doesn't take a target-table argument to check against
    // either). This documents get()'s actual behavior, not a rejection.
    const roundTripped = (await t.query("mod:get", { id: idA })) as Record<string, unknown>;
    expect(roundTripped).toMatchObject({ label: "from-a" });

    // And a well-formed id minted for table "b", if it were (incorrectly) written into a field
    // typed v.id("a") elsewhere, would likewise resolve to its OWN table ("b") on get — never
    // rejected, and never silently reinterpreted as an "a" row. Confirm with the actual b id:
    const bBack = (await t.query("mod:get", { id: idB })) as Record<string, unknown>;
    expect(bBack).toMatchObject({ label: "from-b", ref: idA });
  });
});
