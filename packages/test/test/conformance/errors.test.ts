import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestHelipod, type TestHelipod } from "../../src";
import { mutation, query, action } from "@helipod/executor";
import { defineSchema, defineTable, v } from "@helipod/values";

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
  // Query handler illegally attempting a db write — queries have `dbWrite === false`. Note:
  // `GuestDatabaseReader` (the query-side `ctx.db`) doesn't even expose `.insert`/`.replace`/
  // `.delete` at the type OR runtime level, so ordinary user code can't reach this path — the
  // kernel-level `ForbiddenOperationError` guard (kernel.ts's `handleDbInsert`) is defense in
  // depth. We exercise it by reaching the underlying syscall channel directly (a plain runtime
  // property despite the `protected` TS modifier), the same channel `GuestDatabaseWriter` uses.
  writeFromQuery: query(async (ctx: A, args: A) =>
    ctx.db.channel.call("db.insert", JSON.stringify({ table: "docs", value: args }))
  ),
  // The LOAD-BEARING guarantee that real app code relies on: a query's `ctx.db` has no write
  // methods at all (unlike the kernel guard above, this is what actually stops ordinary code).
  queryDbShape: query(async (ctx: A) => ({
    insert: typeof ctx.db.insert,
    replace: typeof ctx.db.replace,
    delete: typeof ctx.db.delete,
  })),
  // Replace on a well-formed but never-existed / already-deleted id — distinct from `get`,
  // which returns null for the same shape of id.
  replaceMissing: mutation(async (ctx: A, args: { id: string }) =>
    ctx.db.replace(args.id, { label: "replaced" })
  ),
  // Uncaught throw inside an action handler (actions run outside the transaction).
  boomAction: action(async () => {
    throw new Error("action-boom");
  }),
  // Opt-in argument validation: wrong-typed arg should reject with ArgumentValidationError,
  // not DocumentValidationError/ForbiddenOperationError.
  typedMutation: mutation({
    args: { n: v.number() },
    handler: async (_ctx: A, args: { n: number }) => args.n,
  }),
  // Insert, THEN throw — the whole transaction must roll back, including the pre-throw write.
  insertThenThrow: mutation(async (ctx: A, args: A) => {
    await ctx.db.insert("docs", args);
    throw new Error("after-insert-boom");
  }),
};

describe("conformance — errors", () => {
  let t: TestHelipod;

  beforeEach(async () => {
    t = await createTestHelipod({ modules: { "mod.ts": mod, "schema.ts": { default: schema } } });
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

  it("a query handler attempting a db write throws ForbiddenOperationError (queries have dbWrite === false)", async () => {
    await expect(t.query("mod:writeFromQuery", { label: "nope" })).rejects.toMatchObject({
      name: "ForbiddenOperationError",
      code: "FORBIDDEN",
      message: expect.stringMatching(/writes are not allowed here/),
    });
  });

  it("a query's ctx.db exposes no write methods at all (load-bearing guarantee; the guard above is defense-in-depth)", async () => {
    // This is the assertion that catches the real regression — if `insert` were ever added to the
    // query-side reader, the bypass test above would still pass but this one would fail.
    await expect(t.query("mod:queryDbShape", {})).resolves.toEqual({
      insert: "undefined",
      replace: "undefined",
      delete: "undefined",
    });
  });

  it("calling a nonexistent function path throws FunctionNotFoundError", async () => {
    await expect(t.mutation("mod:doesNotExist", {})).rejects.toMatchObject({
      name: "FunctionNotFoundError",
      code: "FUNCTION_NOT_FOUND",
    });
  });

  it("ctx.db.replace on a well-formed but never-existed/already-deleted id throws (distinct from get, which returns null)", async () => {
    const id = await t.mutation<string>("mod:insert", { label: "temp" });
    await t.mutation("mod:del", { id });
    await expect(t.mutation("mod:replaceMissing", { id })).rejects.toMatchObject({
      name: "DocumentNotFoundError",
      code: "DOCUMENT_NOT_FOUND",
      message: expect.stringMatching(/cannot replace missing document/),
    });
  });

  it("an uncaught throw inside an action handler rejects t.action(...)", async () => {
    await expect(t.action("mod:boomAction", {})).rejects.toThrow(/action-boom/);
  });

  it("a wrong-typed arg against an opt-in args validator rejects with ArgumentValidationError, not a document-validation error", async () => {
    await expect(t.mutation("mod:typedMutation", { n: "not-a-number" })).rejects.toMatchObject({
      name: "ArgumentValidationError",
      code: "ARGUMENT_VALIDATION",
    });
  });

  it("a mutation that inserts a row then throws rolls back the ENTIRE transaction, including the pre-throw write", async () => {
    await expect(t.mutation("mod:insertThenThrow", { label: "should-not-persist" })).rejects.toThrow(
      /after-insert-boom/
    );
    // No trace of the insert should be observable — list the whole table via the privileged
    // `t.run` escape hatch (real db-writer ctx, no app function needed).
    const rows = await t.run(async (ctx: A) => ctx.db.query("docs", "by_creation").collect());
    expect(rows).toEqual([]);
  });
});
