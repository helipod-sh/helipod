import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestStackbase, type TestStackbase } from "../../src";
import { schema, mod } from "../fixtures/conformance-app";

describe("conformance — db CRUD", () => {
  let t: TestStackbase;

  beforeEach(async () => {
    t = await createTestStackbase({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
  });

  afterEach(async () => {
    await t.close();
  });

  it("insert returns a usable id", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("get round-trips an inserted document", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const doc = await t.query("mod:get", { id });
    expect(doc).toMatchObject({ owner: "a", n: 1, tag: "x" });
  });

  it("Stackbase has no ctx.db.patch — partial update is read-merge-replace", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation("mod:patchViaReplace", { id, patch: { n: 2 } });
    // unspecified fields (owner, tag) are retained — this is a MERGE, not an overwrite
    expect(await t.query("mod:get", { id })).toMatchObject({ owner: "a", n: 2, tag: "x" });
  });

  it("replace overwrites the whole document (dropped optional field is gone)", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x", note: "keep" });
    // replace with a doc that omits the optional `note` field entirely — all required fields present
    await t.mutation("mod:replace", { id, doc: { owner: "a", n: 9, tag: "y" } });
    const doc = (await t.query("mod:get", { id })) as Record<string, unknown>;
    expect(doc).toMatchObject({ owner: "a", n: 9, tag: "y" });
    expect(doc.note).toBeUndefined(); // proves full overwrite, not a merge — the optional field was dropped
  });

  it("replace must keep the doc schema-valid — dropping a required field rejects", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    // `tag` is required by schema; omitting it on replace must be rejected, not silently accepted
    await expect(t.mutation("mod:replace", { id, doc: { owner: "a", n: 9 } })).rejects.toThrow(/does not match schema/);
  });

  it("delete makes a subsequent get return null", async () => {
    const id = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    await t.mutation("mod:del", { id });
    expect(await t.query("mod:get", { id })).toBeNull();
  });

  it("order(desc) over by_creation returns creation-descending order", async () => {
    const id1 = await t.mutation<string>("mod:insert", { owner: "a", n: 1, tag: "x" });
    const id2 = await t.mutation<string>("mod:insert", { owner: "a", n: 2, tag: "x" });
    const id3 = await t.mutation<string>("mod:insert", { owner: "a", n: 3, tag: "x" });
    const rows = (await t.query<Array<{ _id: string }>>("mod:allDesc", {}));
    expect(rows.map((r) => r._id)).toEqual([id3, id2, id1]);
  });
});
